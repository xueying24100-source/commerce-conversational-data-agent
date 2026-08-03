const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OLIST_AVAILABLE_METRICS = [
  'gmv',
  'new_customers',
  'paid_orders',
  'units',
];

const OLIST_DATASET_MANIFEST = {
  revision: 'd9e49802f3e92d09ee94ab9ccc5e457f207a8959',
  repository: 'https://github.com/olist/work-at-olist-data',
  license: 'MIT',
  files: {
    customers: {
      path: 'datasets/olist_customers_dataset.csv',
      sha256: 'c26c17f59f3027a6a0dbeb8f1fa373c38f3323ecc84f225a8f4820e5bb288df8',
      headers: [
        'customer_id',
        'customer_unique_id',
        'customer_zip_code_prefix',
        'customer_city',
        'customer_state',
      ],
    },
    items: {
      path: 'datasets/olist_order_items_dataset.csv',
      sha256: '4f6abdbbc94036d0df4a76fa0520c072e31a40119d70f7f370fba1e2285d2bcb',
      headers: [
        'order_id',
        'order_item_id',
        'product_id',
        'seller_id',
        'shipping_limit_date',
        'price',
        'freight_value',
      ],
    },
    orders: {
      path: 'datasets/olist_orders_dataset.csv',
      sha256: '8df58ef3d2d7e9944010f7beecd9b75367f5588ec6e3c91cec19ae3345ef9ecf',
      headers: [
        'order_id',
        'customer_id',
        'order_status',
        'order_purchase_timestamp',
        'order_approved_at',
        'order_delivered_carrier_date',
        'order_delivered_customer_date',
        'order_estimated_delivery_date',
      ],
    },
  },
};

const INCLUDED_ORDER_STATUSES = new Set([
  'approved',
  'delivered',
  'invoiced',
  'processing',
  'shipped',
]);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

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

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function manifestSha256(manifest) {
  const canonical = [
    manifest.revision,
    ...Object.keys(manifest.files).sort().map((name) => (
      `${name}:${manifest.files[name].sha256}`
    )),
  ].join('\n');
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function visitCsv(text, file, maxRows, visitor) {
  let headers = null;
  let row = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let rowNumber = 0;

  const emitRow = () => {
    row.push(field);
    field = '';
    afterQuote = false;
    if (row.length === 1 && row[0] === '') {
      row = [];
      return;
    }
    rowNumber += 1;
    if (!headers) {
      headers = row;
      headers[0] = headers[0].replace(/^\uFEFF/u, '');
      if (
        headers.length !== file.headers.length
        || headers.some((header, index) => header !== file.headers[index])
      ) {
        throw new Error(`${file.path} header does not match the pinned Olist contract.`);
      }
      row = [];
      return;
    }
    if (row.length !== headers.length) {
      throw new Error(`${file.path} row ${rowNumber} has an invalid column count.`);
    }
    if (rowNumber - 1 > maxRows) {
      throw new Error(`${file.path} exceeded source.maxSourceRows=${maxRows}.`);
    }
    visitor(row, rowNumber - 1);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (afterQuote && ![',', '\r', '\n'].includes(character)) {
      throw new Error(`${file.path} row ${rowNumber + 1} has characters after a quoted field.`);
    }
    if (character === '"') {
      if (field) throw new Error(`${file.path} row ${rowNumber + 1} has an invalid quote.`);
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
      afterQuote = false;
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      emitRow();
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error(`${file.path} ended inside a quoted field.`);
  if (field || row.length) emitRow();
  if (!headers) throw new Error(`${file.path} is empty.`);
  return rowNumber - 1;
}

function nonNegativeMoney(value, name, rowNumber) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Olist ${name} at row ${rowNumber} is invalid.`);
  }
  return parsed;
}

function purchaseTimestamp(value, rowNumber) {
  const normalized = requiredString(value, `Olist purchase timestamp at row ${rowNumber}`);
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(normalized);
  if (!match) throw new Error(`Olist purchase timestamp at row ${rowNumber} is invalid.`);
  const date = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ));
  if (
    date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])
    || date.getUTCHours() !== Number(match[4])
    || date.getUTCMinutes() !== Number(match[5])
    || date.getUTCSeconds() !== Number(match[6])
  ) {
    throw new Error(`Olist purchase timestamp at row ${rowNumber} is invalid.`);
  }
  return normalized;
}

function normalizeOlistFiles(files, source, manifest) {
  const customers = new Map();
  visitCsv(files.customers, manifest.files.customers, source.maxSourceRows, (row, rowNumber) => {
    const customerId = requiredString(row[0], `Olist customer_id at row ${rowNumber}`);
    if (customers.has(customerId)) throw new Error(`Olist customer_id is duplicated: ${customerId}.`);
    customers.set(customerId, {
      uniqueId: requiredString(row[1], `Olist customer_unique_id at row ${rowNumber}`),
      region: requiredString(row[4], `Olist customer_state at row ${rowNumber}`, /^[A-Z]{2}$/u),
    });
  });

  const itemTotals = new Map();
  visitCsv(files.items, manifest.files.items, source.maxSourceRows, (row, rowNumber) => {
    const orderId = requiredString(row[0], `Olist item order_id at row ${rowNumber}`);
    const current = itemTotals.get(orderId) || { gmv: 0, units: 0 };
    current.gmv = roundMoney(
      current.gmv + nonNegativeMoney(row[5], 'item price', rowNumber),
    );
    current.units += 1;
    itemTotals.set(orderId, current);
  });

  const orders = [];
  const earliestByCustomer = new Map();
  const seenOrderIds = new Set();
  let rejectedRows = 0;
  const sourceRows = visitCsv(
    files.orders,
    manifest.files.orders,
    source.maxSourceRows,
    (row, rowNumber) => {
      const orderId = requiredString(row[0], `Olist order_id at row ${rowNumber}`);
      if (seenOrderIds.has(orderId)) throw new Error(`Olist order_id is duplicated: ${orderId}.`);
      seenOrderIds.add(orderId);
      if (!INCLUDED_ORDER_STATUSES.has(String(row[2]).trim().toLowerCase())) return;
      const customer = customers.get(requiredString(
        row[1],
        `Olist order customer_id at row ${rowNumber}`,
      ));
      if (!customer) {
        rejectedRows += 1;
        return;
      }
      const totals = itemTotals.get(orderId);
      if (!totals || totals.units < 1) {
        rejectedRows += 1;
        return;
      }
      const purchasedAt = purchaseTimestamp(row[3], rowNumber);
      const earliestKey = `${purchasedAt}\u001f${orderId}`;
      const existingEarliest = earliestByCustomer.get(customer.uniqueId);
      if (!existingEarliest || earliestKey < existingEarliest) {
        earliestByCustomer.set(customer.uniqueId, earliestKey);
      }
      orders.push({ orderId, customer, totals, purchasedAt, earliestKey });
    },
  );
  if (rejectedRows > source.maxRejectedRows) {
    throw new Error(
      `Olist join rejected ${rejectedRows} orders, exceeding source.maxRejectedRows=${source.maxRejectedRows}.`,
    );
  }

  const aggregated = new Map();
  for (const order of orders) {
    const metricDate = order.purchasedAt.slice(0, 10);
    const key = [metricDate, order.customer.region, source.channel].join('\u001f');
    const current = aggregated.get(key) || {
      metric_date: metricDate,
      region: order.customer.region,
      channel: source.channel,
      sku: source.orderSku,
      category: source.orderCategory,
      business_timezone: source.businessTimeZone,
      visits: 0,
      paid_orders: 0,
      units: 0,
      gmv: 0,
      refund_orders: 0,
      refund_amount: 0,
      cost_amount: 0,
      ad_spend: 0,
      new_customers: 0,
      stockout_hours: 0,
      ending_inventory: 0,
      available_metrics: [...OLIST_AVAILABLE_METRICS],
      data_mode: 'snapshot',
      source_updated_at: source.snapshotUpdatedAt,
    };
    current.paid_orders += 1;
    current.units += order.totals.units;
    current.gmv = roundMoney(current.gmv + order.totals.gmv);
    if (earliestByCustomer.get(order.customer.uniqueId) === order.earliestKey) {
      current.new_customers += 1;
    }
    aggregated.set(key, current);
  }

  return {
    records: [...aggregated.values()].sort((left, right) => (
      left.metric_date.localeCompare(right.metric_date)
      || left.region.localeCompare(right.region)
    )),
    sourceRows,
    rejectedRows,
  };
}

function retryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function downloadFile(input) {
  let lastError = null;
  for (let attempt = 0; attempt <= input.maxRetries; attempt += 1) {
    try {
      const response = await input.fetchImpl(input.url, {
        headers: { Accept: 'text/csv,text/plain;q=0.9' },
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      if (!response.ok) {
        throw Object.assign(new Error(`Olist source returned HTTP ${response.status}.`), {
          retryable: RETRYABLE_STATUS.has(response.status),
          retryAfterMs: retryAfterMs(response),
        });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > input.remainingBytes) {
        throw new Error('Olist source exceeded connector maxBytes.');
      }
      const actualSha256 = createHash('sha256').update(buffer).digest('hex');
      if (actualSha256 !== input.expectedSha256) {
        throw new Error(`Olist checksum mismatch for ${input.filePath}.`);
      }
      return { buffer, text: buffer.toString('utf8'), bytes: buffer.length };
    } catch (error) {
      lastError = error;
      const retryable = error?.retryable === true
        || error instanceof TypeError
        || error?.name === 'TimeoutError';
      if (!retryable || attempt >= input.maxRetries) throw error;
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

function cachedFile(file, cacheDirectory, remainingBytes) {
  const target = path.join(cacheDirectory, path.basename(file.path));
  if (!fs.existsSync(target)) return null;
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error(`Olist cache target is not a regular file: ${target}.`);
  if (stat.size > remainingBytes) throw new Error('Olist cache exceeded connector maxBytes.');
  const buffer = fs.readFileSync(target);
  const actualSha256 = createHash('sha256').update(buffer).digest('hex');
  if (actualSha256 !== file.sha256) {
    throw new Error(`Olist cache checksum mismatch for ${file.path}.`);
  }
  return { buffer, text: buffer.toString('utf8'), bytes: buffer.length };
}

function writeCacheFile(file, cacheDirectory, buffer) {
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const target = path.join(cacheDirectory, path.basename(file.path));
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, buffer, { flag: 'wx' });
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (!fs.existsSync(target)) throw error;
    const existing = fs.readFileSync(target);
    if (createHash('sha256').update(existing).digest('hex') !== file.sha256) throw error;
  }
}

function fetchRuntime(dependencies) {
  if (dependencies.fetchImpl) {
    return { fetchImpl: dependencies.fetchImpl, close: async () => undefined };
  }
  if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY) {
    return { fetchImpl: fetch, close: async () => undefined };
  }
  const { EnvHttpProxyAgent, fetch: undiciFetch } = require('undici');
  const dispatcher = new EnvHttpProxyAgent();
  return {
    fetchImpl: (url, init) => undiciFetch(url, { ...init, dispatcher }),
    close: () => dispatcher.close(),
  };
}

function olistSourceConfig(config, manifest) {
  const revision = requiredString(
    config.datasetRevision || manifest.revision,
    'source.datasetRevision',
    /^[a-f0-9]{40}$/u,
  );
  if (revision !== manifest.revision) {
    throw new Error('source.datasetRevision is not present in the pinned Olist manifest.');
  }
  const businessTimeZone = requiredString(
    config.businessTimeZone || 'America/Sao_Paulo',
    'source.businessTimeZone',
  );
  if (businessTimeZone !== 'America/Sao_Paulo') {
    throw new Error('The pinned Olist timestamps require source.businessTimeZone=America/Sao_Paulo.');
  }
  return {
    revision,
    businessTimeZone,
    snapshotUpdatedAt: isoTimestamp(
      config.snapshotUpdatedAt || '2018-10-17T20:30:18.000Z',
      'source.snapshotUpdatedAt',
    ),
    maxRetries: boundedInteger(config.maxRetries, 'source.maxRetries', 4, 0, 8),
    maxRetryDelayMs: boundedInteger(
      config.maxRetryDelayMs,
      'source.maxRetryDelayMs',
      30_000,
      500,
      120_000,
    ),
    maxSourceRows: boundedInteger(
      config.maxSourceRows,
      'source.maxSourceRows',
      500_000,
      100_000,
      5_000_000,
    ),
    maxRejectedRows: boundedInteger(
      config.maxRejectedRows,
      'source.maxRejectedRows',
      10,
      0,
      10_000,
    ),
    channel: requiredString(config.channel || 'Olist Marketplace', 'source.channel'),
    orderSku: requiredString(config.orderSku || 'OLIST-ORDER', 'source.orderSku'),
    orderCategory: requiredString(
      config.orderCategory || 'All Products',
      'source.orderCategory',
    ),
  };
}

async function loadOlistPublicSource(config, checkpoint, limits, dependencies = {}) {
  const manifest = dependencies.manifest || OLIST_DATASET_MANIFEST;
  const source = olistSourceConfig(config, manifest);
  const checkpointAfter = `olist:${source.revision}`;
  const sourceSha256 = manifestSha256(manifest);
  if (dependencies.allowUnchanged === true && checkpoint === checkpointAfter) {
    return {
      body: '',
      records: [],
      checkpointAfter,
      transport: 'olist',
      sourceRows: 0,
      sourceSha256,
      unchanged: true,
    };
  }

  const network = fetchRuntime(dependencies);
  const sleepImpl = dependencies.sleepImpl
    || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const cacheDirectory = dependencies.cacheDirectory === false
    ? null
    : dependencies.cacheDirectory
      || (dependencies.fetchImpl
        ? null
        : path.join(__dirname, '..', '..', 'tmp', 'olist-public', source.revision));
  const files = {};
  let totalBytes = 0;
  try {
    for (const name of ['customers', 'items', 'orders']) {
      const file = manifest.files[name];
      requiredString(file.sha256, `${name}.sha256`, /^[a-f0-9]{64}$/u);
      let result = cacheDirectory
        ? cachedFile(file, cacheDirectory, limits.maxBytes - totalBytes)
        : null;
      if (!result) {
        const url = file.url
          || `https://raw.githubusercontent.com/olist/work-at-olist-data/${source.revision}/${file.path}`;
        result = await downloadFile({
          url,
          filePath: file.path,
          expectedSha256: file.sha256,
          remainingBytes: limits.maxBytes - totalBytes,
          timeoutMs: limits.timeoutMs,
          maxRetries: source.maxRetries,
          maxRetryDelayMs: source.maxRetryDelayMs,
          fetchImpl: network.fetchImpl,
          sleepImpl,
        });
        if (cacheDirectory) writeCacheFile(file, cacheDirectory, result.buffer);
      }
      files[name] = result.text;
      totalBytes += result.bytes;
    }
  } finally {
    await network.close();
  }
  const normalized = normalizeOlistFiles(files, source, manifest);
  if (normalized.records.length > limits.maxRows) {
    throw new Error(`Olist connector exceeded maxRows=${limits.maxRows}.`);
  }
  const body = JSON.stringify(normalized.records);
  if (Buffer.byteLength(body, 'utf8') > limits.maxBytes) {
    throw new Error('Normalized Olist records exceeded maxBytes.');
  }
  return {
    body,
    records: normalized.records,
    checkpointAfter,
    transport: 'olist',
    sourceRows: normalized.sourceRows,
    rejectedRows: normalized.rejectedRows,
    sourceSha256,
  };
}

module.exports = {
  OLIST_AVAILABLE_METRICS,
  OLIST_DATASET_MANIFEST,
  loadOlistPublicSource,
  manifestSha256,
  normalizeOlistFiles,
};
