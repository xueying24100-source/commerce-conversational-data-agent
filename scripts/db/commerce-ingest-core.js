const COLUMNS = [
  'tenant_id', 'metric_date', 'region', 'channel', 'sku', 'category', 'business_timezone',
  'data_mode',
  'visits', 'paid_orders', 'units', 'gmv', 'refund_orders', 'refund_amount',
  'cost_amount', 'ad_spend', 'new_customers', 'stockout_hours',
  'ending_inventory', 'available_metrics', 'source_updated_at',
];

const AVAILABLE_METRIC_FIELDS = [
  'visits', 'paid_orders', 'units', 'gmv', 'refund_orders', 'refund_amount',
  'cost_amount', 'ad_spend', 'new_customers', 'stockout_hours', 'ending_inventory',
];

const INTEGER_FIELDS = [
  'visits', 'paid_orders', 'units', 'refund_orders', 'new_customers', 'ending_inventory',
];
const DECIMAL_FIELDS = [
  'gmv', 'refund_amount', 'cost_amount', 'ad_spend', 'stockout_hours',
];

function requiredText(value, field, line, maximumLength = 160) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximumLength) {
    throw new Error(`Record ${line}: ${field} must be a non-empty string of at most ${maximumLength} characters.`);
  }
  return normalized;
}

function integer(value, field, line) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Record ${line}: ${field} must be a non-negative safe integer.`);
  }
  return value;
}

function decimal(value, field, line) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Record ${line}: ${field} must be a non-negative finite number.`);
  }
  return value;
}

function validIsoDate(value) {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function availableMetrics(value, line) {
  if (value === undefined) return [...AVAILABLE_METRIC_FIELDS];
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`Record ${line}: available_metrics must be a non-empty array.`);
  }
  const normalized = Array.from(new Set(value.map((item) => String(item).trim())));
  if (normalized.some((item) => !AVAILABLE_METRIC_FIELDS.includes(item))) {
    throw new Error(`Record ${line}: available_metrics contains an unsupported metric.`);
  }
  return normalized.sort();
}

function businessTimeZone(value, line) {
  const normalized = value === undefined
    ? 'Asia/Shanghai'
    : requiredText(value, 'business_timezone', line, 80);
  try {
    new Intl.DateTimeFormat('en', { timeZone: normalized }).format();
  } catch {
    throw new Error(`Record ${line}: business_timezone must be an IANA time zone.`);
  }
  return normalized;
}

function dataMode(value, line) {
  const normalized = value === undefined
    ? 'snapshot'
    : requiredText(value, 'data_mode', line, 20);
  if (!['snapshot', 'incremental'].includes(normalized)) {
    throw new Error(`Record ${line}: data_mode must be snapshot or incremental.`);
  }
  return normalized;
}

function parseCommerceRow(value, line = 1, forcedTenantId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Record ${line}: each record must be an object.`);
  }
  const tenantId = forcedTenantId || requiredText(value.tenant_id, 'tenant_id', line);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(tenantId)) {
    throw new Error(`Record ${line}: tenant_id contains unsupported characters.`);
  }
  if (forcedTenantId && value.tenant_id && String(value.tenant_id).trim() !== forcedTenantId) {
    throw new Error(`Record ${line}: source tenant_id does not match connector tenant.`);
  }
  const metricDate = requiredText(value.metric_date, 'metric_date', line);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(metricDate) || !validIsoDate(metricDate)) {
    throw new Error(`Record ${line}: metric_date must be a valid YYYY-MM-DD date.`);
  }
  const sourceUpdatedAt = requiredText(value.source_updated_at, 'source_updated_at', line);
  if (!Number.isFinite(Date.parse(sourceUpdatedAt))) {
    throw new Error(`Record ${line}: source_updated_at must be an ISO timestamp.`);
  }
  const parsed = {
    tenant_id: tenantId,
    metric_date: metricDate,
    region: requiredText(value.region, 'region', line, 120),
    channel: requiredText(value.channel, 'channel', line, 120),
    sku: requiredText(value.sku, 'sku', line, 120),
    category: requiredText(value.category, 'category', line, 120),
    business_timezone: businessTimeZone(value.business_timezone, line),
    data_mode: dataMode(value.data_mode, line),
    available_metrics: availableMetrics(value.available_metrics, line),
    source_updated_at: sourceUpdatedAt,
  };
  for (const field of INTEGER_FIELDS) parsed[field] = integer(value[field], field, line);
  for (const field of DECIMAL_FIELDS) parsed[field] = decimal(value[field], field, line);
  return parsed;
}

async function selectIngestTenant(client, tenantId) {
  await client.query(
    `SELECT set_config('commerce.tenant_id', $1, true),
            set_config('commerce.ingest_tenant_id', $1, true)`,
    [tenantId],
  );
}

async function upsertCommerceRows(client, rows) {
  if (!rows.length) return;
  const tenantId = rows[0].tenant_id;
  if (rows.some((row) => row.tenant_id !== tenantId)) {
    throw new Error('A Commerce ingest batch must contain exactly one tenant.');
  }
  await selectIngestTenant(client, tenantId);
  for (let offset = 0; offset < rows.length; offset += 250) {
    const batch = rows.slice(offset, offset + 250);
    const values = [];
    const tuples = batch.map((row, rowIndex) => {
      const placeholders = COLUMNS.map((column, columnIndex) => {
        values.push(row[column]);
        return `$${rowIndex * COLUMNS.length + columnIndex + 1}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const updates = COLUMNS
      .filter((column) => !['tenant_id', 'metric_date', 'region', 'channel', 'sku'].includes(column))
      .map((column) => `${column} = EXCLUDED.${column}`)
      .concat('ingested_at = NOW()');
    await client.query(
      `INSERT INTO commerce_daily_metrics (${COLUMNS.join(', ')})
       VALUES ${tuples.join(', ')}
       ON CONFLICT (tenant_id, metric_date, region, channel, sku)
       DO UPDATE SET ${updates.join(', ')}`,
      values,
    );
  }
}

async function refreshCommerceCatalog(client, tenantId) {
  await selectIngestTenant(client, tenantId);
  await client.query('SELECT commerce_refresh_tenant_catalog($1)', [tenantId]);
}

module.exports = {
  COLUMNS,
  AVAILABLE_METRIC_FIELDS,
  parseCommerceRow,
  refreshCommerceCatalog,
  selectIngestTenant,
  upsertCommerceRows,
};
