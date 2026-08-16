const SHOPIFY_AVAILABLE_METRICS = [
  'gmv',
  'paid_orders',
  'refund_amount',
  'units',
];

const PAID_STATUSES = new Set(['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_GRAPHQL_CODES = new Set(['THROTTLED', 'INTERNAL_SERVER_ERROR']);
const SHOPIFY_ALL_ORDERS_WINDOW_MS = 60 * 24 * 60 * 60 * 1_000;

const SHOPIFY_ORDERS_QUERY = `query CommerceOrders(
  $first: Int!
  $after: String
  $query: String!
) {
  orders(first: $first, after: $after, sortKey: UPDATED_AT, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      createdAt
      updatedAt
      test
      displayFinancialStatus
      shippingAddress { provinceCode countryCodeV2 }
      channelInformation { channelDefinition { channelName } }
      lineItems(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          quantity
          discountedTotalSet { shopMoney { amount currencyCode } }
        }
      }
      refunds {
        id
        createdAt
        totalRefundedSet { shopMoney { amount currencyCode } }
      }
    }
  }
}`;

function requiredString(value, name, pattern) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || (pattern && !pattern.test(normalized))) {
    throw new Error(`${name} is invalid or missing.`);
  }
  return normalized;
}

function boundedInteger(value, name, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function isoTimestamp(value, name) {
  const date = new Date(requiredString(value, name));
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be an ISO timestamp.`);
  return date.toISOString();
}

function businessDateTime(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Shopify returned an invalid timestamp.');
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
    millisecond: date.getUTCMilliseconds(),
  };
}

function businessDate(value, timeZone) {
  return businessDateTime(value, timeZone).date;
}

function fullHistoryCoverageStart(value, timeZone) {
  const local = businessDateTime(value, timeZone);
  if (
    local.hour !== '00'
    || local.minute !== '00'
    || local.second !== '00'
    || local.millisecond !== 0
  ) {
    throw new Error(
      'Shopify full-history initialUpdatedAt must be exactly midnight in source.businessTimeZone.',
    );
  }
  return local.date;
}

function previousCompleteBusinessDate(value, timeZone) {
  const current = businessDate(value, timeZone);
  const calendar = new Date(`${current}T00:00:00.000Z`);
  calendar.setUTCDate(calendar.getUTCDate() - 1);
  return calendar.toISOString().slice(0, 10);
}

function money(value, name) {
  const parsed = Number(value?.amount);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Shopify ${name} is invalid.`);
  return parsed;
}

function moneyCurrency(value, name) {
  const normalized = String(value?.currencyCode || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) {
    throw new Error(`Shopify ${name} currencyCode is invalid or missing.`);
  }
  return normalized;
}

function integer(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Shopify ${name} is invalid.`);
  return parsed;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Emits one fact row per Shopify order (its paid contribution) and one per refund, each
// tagged with a stable source_line_id. This intentionally does NOT pre-aggregate into daily
// buckets here: a partial incremental window must only ever add or update the specific
// order/refund lines it observed, never overwrite a shared (date, region, channel, sku)
// bucket with a partial sum. Bucket aggregation happens downstream in
// recomputeDailyMetricsFromSourceFacts, which re-sums the *complete* staged history for
// every bucket a run touches, so a window that only sees 1 of N historical orders for a
// bucket can no longer erase the other N-1 orders' contribution.
function normalizeShopifyOrders(orders, source) {
  const factRows = [];
  const sourceEntities = [];
  const currencies = new Set();
  for (const order of orders) {
    if (!order || typeof order !== 'object' || Array.isArray(order)) {
      throw new Error('Shopify returned an invalid order node.');
    }
    const orderId = requiredString(order.id, 'order.id');
    const sourceLineIds = [];
    // Test orders are still emitted as observed entities with zero active lines. If an order
    // is reclassified as test after a previous import, entity reconciliation removes its old
    // production contribution instead of silently retaining it.
    if (order.test === true) {
      sourceEntities.push({ source_entity_id: orderId, source_line_ids: sourceLineIds });
      continue;
    }
    if (order.lineItems?.pageInfo?.hasNextPage) {
      throw new Error('Shopify order has more than 100 line items; use Bulk Operations for this store.');
    }
    const updatedAt = isoTimestamp(order.updatedAt, 'order.updatedAt');
    const dimensions = {
      region: order.shippingAddress?.provinceCode
        || order.shippingAddress?.countryCodeV2
        || source.defaultRegion,
      channel: order.channelInformation?.channelDefinition?.channelName
        || source.defaultChannel,
      sku: source.orderSku,
      category: source.orderCategory,
      business_timezone: source.businessTimeZone,
    };
    if (PAID_STATUSES.has(String(order.displayFinancialStatus || ''))) {
      const lineItems = order.lineItems?.nodes || [];
      const units = lineItems.reduce(
        (sum, line) => sum + integer(line.quantity, 'line item quantity'),
        0,
      );
      const gmv = roundMoney(lineItems.reduce(
        (sum, line) => sum + money(line.discountedTotalSet?.shopMoney, 'line item total'),
        0,
      ));
      let lineCurrency;
      for (const line of lineItems) {
        lineCurrency = moneyCurrency(line.discountedTotalSet?.shopMoney, 'line item total');
        currencies.add(lineCurrency);
      }
      const sourceLineId = `order:${orderId}`;
      sourceLineIds.push(sourceLineId);
      factRows.push({
        ...dimensions,
        source_entity_id: orderId,
        source_line_id: sourceLineId,
        metric_date: businessDate(order.createdAt, source.businessTimeZone),
        currency_code: lineCurrency,
        paid_orders: 1,
        units,
        gmv,
        refund_amount: 0,
        source_updated_at: updatedAt,
      });
    }
    (order.refunds || []).forEach((refund, index) => {
      const refundAmount = money(refund.totalRefundedSet?.shopMoney, 'refund total');
      if (refundAmount === 0) return;
      const refundCurrency = moneyCurrency(refund.totalRefundedSet?.shopMoney, 'refund total');
      currencies.add(refundCurrency);
      const refundId = requiredString(String(refund.id ?? index), 'refund.id');
      const sourceLineId = `refund:${orderId}:${refundId}`;
      sourceLineIds.push(sourceLineId);
      factRows.push({
        ...dimensions,
        source_entity_id: orderId,
        source_line_id: sourceLineId,
        metric_date: businessDate(refund.createdAt, source.businessTimeZone),
        currency_code: refundCurrency,
        paid_orders: 0,
        units: 0,
        gmv: 0,
        refund_amount: roundMoney(refundAmount),
        source_updated_at: updatedAt,
      });
    });
    sourceEntities.push({ source_entity_id: orderId, source_line_ids: sourceLineIds });
  }
  if (currencies.size > 1) {
    throw new Error(
      `Shopify returned multiple currencies in one connector run (${[...currencies].sort().join(', ')}); `
      + 'multi-currency ingestion is not supported.',
    );
  }
  factRows.sort((left, right) => (
    left.metric_date.localeCompare(right.metric_date)
    || left.region.localeCompare(right.region)
    || left.channel.localeCompare(right.channel)
    || left.source_line_id.localeCompare(right.source_line_id)
  ));
  sourceEntities.sort((left, right) => left.source_entity_id.localeCompare(right.source_entity_id));
  return { factRows, sourceEntities };
}

function retryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function fetchPage(input) {
  let lastError = null;
  for (let attempt = 0; attempt <= input.maxRetries; attempt += 1) {
    try {
      const response = await input.fetchImpl(input.url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': input.accessToken,
        },
        body: JSON.stringify({
          query: SHOPIFY_ORDERS_QUERY,
          variables: input.variables,
        }),
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      const body = await response.text();
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > input.remainingBytes) throw new Error('Shopify response exceeded maxBytes.');
      if (!response.ok) {
        const error = Object.assign(new Error(`Shopify Admin API returned HTTP ${response.status}.`), {
          retryable: RETRYABLE_STATUS.has(response.status),
          retryAfterMs: retryAfterMs(response),
        });
        throw error;
      }
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error('Shopify Admin API returned invalid JSON.');
      }
      if (Array.isArray(payload.errors) && payload.errors.length) {
        const retryable = payload.errors.some((error) => (
          RETRYABLE_GRAPHQL_CODES.has(String(error?.extensions?.code || ''))
        ));
        const message = String(payload.errors[0]?.message || 'Shopify GraphQL request failed.');
        throw Object.assign(new Error(message.slice(0, 500)), { retryable });
      }
      const orders = payload.data?.orders;
      if (!orders || !Array.isArray(orders.nodes) || !orders.pageInfo) {
        throw new Error('Shopify orders response did not match the expected GraphQL contract.');
      }
      return { orders, bytes };
    } catch (error) {
      lastError = error;
      if (!error?.retryable || attempt >= input.maxRetries) throw error;
      const exponential = Math.min(input.maxRetryDelayMs, 500 * (2 ** attempt));
      const delay = Math.min(
        input.maxRetryDelayMs,
        Math.max(exponential, Number(error.retryAfterMs) || 0),
      );
      await input.sleepImpl(delay);
    }
  }
  throw lastError;
}

async function assertReadAllOrdersScope(input) {
  const response = await input.fetchImpl(input.url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Shopify-Access-Token': input.accessToken,
    },
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Shopify access scope verification failed with HTTP ${response.status}; refusing full-history coverage.`,
    );
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('Shopify access scope verification returned invalid JSON; refusing full-history coverage.');
  }
  const handles = Array.isArray(payload?.access_scopes)
    ? payload.access_scopes.map((scope) => String(scope?.handle || '').trim())
    : [];
  if (!handles.includes('read_all_orders')) {
    throw new Error(
      'Shopify full-history reconciliation older than 60 days requires the read_all_orders scope.',
    );
  }
}

function shopifySourceConfig(config) {
  const domainEnv = requiredString(
    config.shopDomainEnv || 'SHOPIFY_SHOP_DOMAIN',
    'source.shopDomainEnv',
    /^[A-Z][A-Z0-9_]{2,127}$/u,
  );
  const tokenEnv = requiredString(
    config.accessTokenEnv || 'SHOPIFY_ADMIN_ACCESS_TOKEN',
    'source.accessTokenEnv',
    /^[A-Z][A-Z0-9_]{2,127}$/u,
  );
  const shopDomain = requiredString(
    process.env[domainEnv],
    domainEnv,
    /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u,
  );
  const accessToken = requiredString(process.env[tokenEnv], tokenEnv);
  const apiVersion = requiredString(
    config.apiVersion,
    'source.apiVersion',
    /^20\d{2}-(?:01|04|07|10)$/u,
  );
  const businessTimeZone = requiredString(
    config.businessTimeZone || 'Asia/Shanghai',
    'source.businessTimeZone',
  );
  try {
    new Intl.DateTimeFormat('en', { timeZone: businessTimeZone }).format();
  } catch {
    throw new Error('source.businessTimeZone must be an IANA time zone.');
  }
  return {
    shopDomain,
    accessToken,
    apiVersion,
    businessTimeZone,
    initialUpdatedAt: isoTimestamp(config.initialUpdatedAt, 'source.initialUpdatedAt'),
    pageSize: boundedInteger(config.pageSize, 'source.pageSize', 50, 1, 100),
    maxPages: boundedInteger(config.maxPages, 'source.maxPages', 1_000, 1, 10_000),
    maxRetries: boundedInteger(config.maxRetries, 'source.maxRetries', 4, 0, 8),
    maxRetryDelayMs: boundedInteger(
      config.maxRetryDelayMs,
      'source.maxRetryDelayMs',
      30_000,
      500,
      120_000,
    ),
    defaultRegion: requiredString(config.defaultRegion || 'Unknown', 'source.defaultRegion'),
    defaultChannel: requiredString(config.defaultChannel || 'Shopify', 'source.defaultChannel'),
    orderSku: requiredString(config.orderSku || 'SHOPIFY-ORDER', 'source.orderSku'),
    orderCategory: requiredString(
      config.orderCategory || 'All Products',
      'source.orderCategory',
    ),
    fullHistoryReconciliation: config.fullHistoryReconciliation === true,
  };
}

async function loadShopifySource(config, checkpoint, limits, dependencies = {}) {
  const source = shopifySourceConfig(config);
  if (source.fullHistoryReconciliation && checkpoint) {
    throw new Error('Shopify fullHistoryReconciliation is a one-time empty-checkpoint bootstrap only.');
  }
  const coverageStart = source.fullHistoryReconciliation
    ? fullHistoryCoverageStart(source.initialUpdatedAt, source.businessTimeZone)
    : null;
  const lower = checkpoint ? isoTimestamp(checkpoint, 'Shopify checkpoint') : source.initialUpdatedAt;
  const upper = (dependencies.now || (() => new Date()))().toISOString();
  if (lower > upper) throw new Error('Shopify checkpoint cannot be later than the current watermark.');
  const coverageEnd = previousCompleteBusinessDate(upper, source.businessTimeZone);
  if (coverageStart && coverageEnd < coverageStart) {
    throw new Error('Shopify full-history reconciliation requires at least one complete business day.');
  }
  const adminApiBase = `https://${source.shopDomain}/admin/api/${source.apiVersion}`;
  const url = `${adminApiBase}/graphql.json`;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const sleepImpl = dependencies.sleepImpl || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  if (
    source.fullHistoryReconciliation
    && Date.parse(upper) - Date.parse(source.initialUpdatedAt) > SHOPIFY_ALL_ORDERS_WINDOW_MS
  ) {
    await assertReadAllOrdersScope({
      url: `https://${source.shopDomain}/admin/oauth/access_scopes.json`,
      accessToken: source.accessToken,
      timeoutMs: limits.timeoutMs,
      fetchImpl,
    });
  }
  const query = `updated_at:>='${lower}' updated_at:<='${upper}'`;
  const orders = [];
  let cursor = null;
  let totalBytes = 0;
  for (let page = 1; page <= source.maxPages; page += 1) {
    const result = await fetchPage({
      url,
      accessToken: source.accessToken,
      variables: { first: source.pageSize, after: cursor, query },
      timeoutMs: limits.timeoutMs,
      maxRetries: source.maxRetries,
      maxRetryDelayMs: source.maxRetryDelayMs,
      remainingBytes: limits.maxBytes - totalBytes,
      fetchImpl,
      sleepImpl,
    });
    totalBytes += result.bytes;
    orders.push(...result.orders.nodes);
    if (!result.orders.pageInfo.hasNextPage) break;
    cursor = result.orders.pageInfo.endCursor;
    if (!cursor) throw new Error('Shopify pagination did not provide endCursor.');
    if (page === source.maxPages) throw new Error('Shopify connector exceeded source.maxPages.');
  }
  if (orders.length > limits.maxRows) throw new Error(`Shopify connector exceeded maxRows=${limits.maxRows}.`);
  const { factRows, sourceEntities } = normalizeShopifyOrders(orders, source);
  if (factRows.length > limits.maxRows) throw new Error(`Shopify connector exceeded maxRows=${limits.maxRows}.`);
  const body = JSON.stringify({ factRows, sourceEntities });
  if (Buffer.byteLength(body, 'utf8') > limits.maxBytes) {
    throw new Error('Normalized Shopify records exceeded maxBytes.');
  }
  return {
    body,
    factRows,
    sourceEntities,
    checkpointAfter: upper,
    transport: 'shopify',
    sourceRows: orders.length,
    ...(source.fullHistoryReconciliation ? {
      coverageProof: {
        kind: 'full_history_reconciliation',
        coverageStart,
        coverageEnd,
        sourceUpdatedAt: upper,
      },
    } : checkpoint ? {
      coverageProof: {
        kind: 'coordinated_incremental_scan',
        coverageEnd,
        sourceUpdatedAt: upper,
      },
    } : {}),
  };
}

module.exports = {
  SHOPIFY_AVAILABLE_METRICS,
  loadShopifySource,
  normalizeShopifyOrders,
};
