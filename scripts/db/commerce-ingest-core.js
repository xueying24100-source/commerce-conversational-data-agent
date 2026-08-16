const COLUMNS = [
  'tenant_id', 'source_id', 'metric_date', 'region', 'channel', 'sku', 'category', 'business_timezone',
  'data_mode', 'currency_code',
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
const BUSINESS_EVENT_TYPES = [
  'price_change', 'campaign_change', 'promotion', 'restock', 'stockout',
];
const BUSINESS_EVENT_DIMENSIONS = ['region', 'channel', 'sku', 'category'];

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

function dateDistance(start, end) {
  return Math.round(
    (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`))
      / 86_400_000,
  );
}

function parseCoverageProof(value, dataMode) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Connector coverage proof is required before any date can be published ready.');
  }
  const kind = requiredText(value.kind, 'coverageProof.kind', 80);
  const allowed = dataMode === 'snapshot'
    ? ['complete_snapshot']
    : ['full_history_reconciliation', 'coordinated_incremental_scan'];
  if (!allowed.includes(kind)) {
    throw new Error(`Coverage proof ${kind} is not valid for ${dataMode} data.`);
  }
  const coverageEnd = requiredText(value.coverageEnd, 'coverageProof.coverageEnd', 10);
  if (!validIsoDate(coverageEnd)) {
    throw new Error('coverageProof.coverageEnd must be a valid YYYY-MM-DD date.');
  }
  const coordinated = kind === 'coordinated_incremental_scan';
  if (coordinated && value.coverageStart !== undefined && value.coverageStart !== null) {
    throw new Error('A coordinated incremental scan must inherit coverageStart from durable proof.');
  }
  const coverageStart = coordinated
    ? null
    : requiredText(value.coverageStart, 'coverageProof.coverageStart', 10);
  if (coverageStart && !validIsoDate(coverageStart)) {
    throw new Error('coverageProof.coverageStart must be a valid YYYY-MM-DD date.');
  }
  if (coverageStart && dateDistance(coverageStart, coverageEnd) < 0) {
    throw new Error('Connector coverage proof start must not be after its end.');
  }
  if (coverageStart && dateDistance(coverageStart, coverageEnd) > 36_600) {
    throw new Error('Connector coverage proof cannot span more than 100 years.');
  }
  const sourceUpdatedAt = requiredText(
    value.sourceUpdatedAt,
    'coverageProof.sourceUpdatedAt',
    64,
  );
  if (!Number.isFinite(Date.parse(sourceUpdatedAt))) {
    throw new Error('coverageProof.sourceUpdatedAt must be an ISO timestamp.');
  }
  return {
    kind,
    coverageStart,
    coverageEnd,
    sourceUpdatedAt: new Date(sourceUpdatedAt).toISOString(),
  };
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

function currencyCode(value, line) {
  const normalized = value === undefined
    ? 'CNY'
    : requiredText(value, 'currency_code', line, 3).toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) {
    throw new Error(`Record ${line}: currency_code must be a 3-letter ISO 4217 code.`);
  }
  return normalized;
}

function parseCommerceRow(value, line = 1, forcedTenantId, forcedSourceId) {
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
    source_id: forcedSourceId || requiredText(value.source_id, 'source_id', line, 128),
    metric_date: metricDate,
    region: requiredText(value.region, 'region', line, 120),
    channel: requiredText(value.channel, 'channel', line, 120),
    sku: requiredText(value.sku, 'sku', line, 120),
    category: requiredText(value.category, 'category', line, 120),
    business_timezone: businessTimeZone(value.business_timezone, line),
    data_mode: dataMode(value.data_mode, line),
    currency_code: currencyCode(value.currency_code, line),
    available_metrics: availableMetrics(value.available_metrics, line),
    source_updated_at: sourceUpdatedAt,
  };
  for (const field of INTEGER_FIELDS) parsed[field] = integer(value[field], field, line);
  for (const field of DECIMAL_FIELDS) parsed[field] = decimal(value[field], field, line);
  return parsed;
}

function parseCommerceBusinessEvent(value, line = 1, forcedTenantId, forcedSourceId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Business event ${line}: each event must be an object.`);
  }
  const tenantId = forcedTenantId || requiredText(value.tenant_id, 'tenant_id', line, 128);
  const sourceId = forcedSourceId || requiredText(value.source_id, 'source_id', line, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(tenantId)) {
    throw new Error(`Business event ${line}: tenant_id contains unsupported characters.`);
  }
  const eventType = requiredText(value.eventType ?? value.event_type, 'event_type', line, 40);
  if (!BUSINESS_EVENT_TYPES.includes(eventType)) {
    throw new Error(`Business event ${line}: event_type is unsupported.`);
  }
  const occurredAt = requiredText(value.occurredAt ?? value.occurred_at, 'occurred_at', line, 64);
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new Error(`Business event ${line}: occurred_at must be an ISO timestamp.`);
  }
  const rawScope = value.scope ?? {};
  if (!rawScope || typeof rawScope !== 'object' || Array.isArray(rawScope)) {
    throw new Error(`Business event ${line}: scope must be an object.`);
  }
  const scope = {};
  for (const [dimension, scopeValue] of Object.entries(rawScope)) {
    if (!BUSINESS_EVENT_DIMENSIONS.includes(dimension)) {
      throw new Error(`Business event ${line}: scope contains an unsupported dimension.`);
    }
    scope[dimension] = requiredText(scopeValue, `scope.${dimension}`, line, 120);
  }
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`Business event ${line}: confidence must be between zero and one.`);
  }
  const scenarioMetadata = value.scenarioMetadata ?? value.scenario_metadata;
  if (typeof scenarioMetadata !== 'boolean') {
    throw new Error(`Business event ${line}: scenario_metadata must be boolean.`);
  }
  return {
    tenant_id: tenantId,
    source_id: sourceId,
    event_id: requiredText(value.eventId ?? value.event_id, 'event_id', line, 160),
    event_type: eventType,
    occurred_at: new Date(occurredAt).toISOString(),
    scope,
    event_source: requiredText(value.source ?? value.event_source, 'event_source', line, 240),
    confidence,
    scenario_metadata: scenarioMetadata,
  };
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
      .filter((column) => ![
        'tenant_id', 'source_id', 'metric_date', 'region', 'channel', 'sku',
      ].includes(column))
      .map((column) => `${column} = EXCLUDED.${column}`)
      .concat('ingested_at = NOW()');
    await client.query(
      `INSERT INTO commerce_daily_metrics (${COLUMNS.join(', ')})
       VALUES ${tuples.join(', ')}
       ON CONFLICT (tenant_id, source_id, metric_date, region, channel, sku)
       DO UPDATE SET ${updates.join(', ')}`,
      values,
    );
  }
}

// Generic file/HTTPS/Olist connectors are complete snapshots. Replacing the tenant in one
// transaction is deliberate: an upsert-only snapshot leaves rows that disappeared upstream
// behind forever. The runner fences this operation to one connector owner per tenant before
// calling it, so the tenant-wide delete cannot erase another connector's facts.
async function replaceCommerceSnapshot(client, tenantId, sourceId, rows) {
  if (rows.some((row) => row.tenant_id !== tenantId)) {
    throw new Error('A Commerce snapshot must contain exactly one tenant.');
  }
  if (rows.some((row) => row.data_mode !== 'snapshot')) {
    throw new Error('Generic Commerce connectors only support data_mode=snapshot; incremental sources require a source-fact adapter.');
  }
  if (rows.some((row) => row.source_id !== sourceId)) {
    throw new Error('A Commerce snapshot must contain exactly one source.');
  }
  await selectIngestTenant(client, tenantId);
  await client.query(
    'DELETE FROM commerce_daily_metrics WHERE tenant_id = $1 AND source_id = $2',
    [tenantId, sourceId],
  );
  await upsertCommerceRows(client, rows);
}

async function replaceCommerceBusinessEvents(client, tenantId, sourceId, events) {
  if (events.some((event) => event.tenant_id !== tenantId || event.source_id !== sourceId)) {
    throw new Error('A Commerce business-event batch must contain exactly one tenant and source.');
  }
  const eventIds = new Set();
  for (const event of events) {
    if (eventIds.has(event.event_id)) {
      throw new Error(`A Commerce business-event batch repeats event_id ${event.event_id}.`);
    }
    eventIds.add(event.event_id);
  }
  await selectIngestTenant(client, tenantId);
  await client.query(
    'DELETE FROM commerce_business_events WHERE tenant_id = $1 AND source_id = $2',
    [tenantId, sourceId],
  );
  for (let offset = 0; offset < events.length; offset += 250) {
    const batch = events.slice(offset, offset + 250);
    const values = [];
    const tuples = batch.map((event, rowIndex) => {
      const fields = [
        event.tenant_id,
        event.source_id,
        event.event_id,
        event.event_type,
        event.occurred_at,
        JSON.stringify(event.scope),
        event.event_source,
        event.confidence,
        event.scenario_metadata,
      ];
      const base = rowIndex * fields.length;
      values.push(...fields);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, `
        + `$${base + 5}::timestamptz, $${base + 6}::jsonb, $${base + 7}, `
        + `$${base + 8}, $${base + 9})`;
    });
    await client.query(
      `INSERT INTO commerce_business_events
         (tenant_id, source_id, event_id, event_type, occurred_at, scope,
          event_source, confidence, scenario_metadata)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  }
}

async function persistCommerceSourceSnapshot(client, tenantId, sourceId, metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Commerce Source Adapter snapshot metadata is required.');
  }
  const descriptor = metadata.descriptor;
  const coverage = metadata.coverage;
  const virtualAsOf = requiredText(coverage?.virtualAsOf, 'coverage.virtualAsOf', 1, 64);
  const sourceWatermark = requiredText(
    coverage?.sourceWatermark,
    'coverage.sourceWatermark',
    1,
    64,
  );
  if (!Number.isFinite(Date.parse(virtualAsOf))
      || !Number.isFinite(Date.parse(sourceWatermark))
      || Date.parse(sourceWatermark) > Date.parse(virtualAsOf)) {
    throw new Error('Commerce Source Adapter virtualAsOf/sourceWatermark are invalid.');
  }
  const sourceKind = requiredText(descriptor?.sourceKind, 'descriptor.sourceKind', 1, 40);
  if (!['public_snapshot', 'controlled_fixture', 'production_connector'].includes(sourceKind)) {
    throw new Error('Commerce Source Adapter sourceKind is invalid.');
  }
  await selectIngestTenant(client, tenantId);
  await client.query(
    `INSERT INTO commerce_source_snapshots
       (tenant_id, source_id, snapshot_id, contract_version, adapter_id, adapter_version,
        upstream_source_id, source_kind, source_uri, source_revision, source_sha256,
        artifact_sha256, license, fixture_seed, lineage, capabilities, virtual_as_of,
        source_watermark, ingested_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13::jsonb, $14, $15::jsonb, $16::jsonb, $17::timestamptz,
             $18::timestamptz, NOW())
     ON CONFLICT (tenant_id, source_id) DO UPDATE SET
       snapshot_id = EXCLUDED.snapshot_id,
       contract_version = EXCLUDED.contract_version,
       adapter_id = EXCLUDED.adapter_id,
       adapter_version = EXCLUDED.adapter_version,
       upstream_source_id = EXCLUDED.upstream_source_id,
       source_kind = EXCLUDED.source_kind,
       source_uri = EXCLUDED.source_uri,
       source_revision = EXCLUDED.source_revision,
       source_sha256 = EXCLUDED.source_sha256,
       artifact_sha256 = EXCLUDED.artifact_sha256,
       license = EXCLUDED.license,
       fixture_seed = EXCLUDED.fixture_seed,
       lineage = EXCLUDED.lineage,
       capabilities = EXCLUDED.capabilities,
       virtual_as_of = EXCLUDED.virtual_as_of,
       source_watermark = EXCLUDED.source_watermark,
       ingested_at = NOW()`,
    [
      tenantId,
      sourceId,
      requiredText(metadata.snapshotId, 'snapshotId', 1, 160),
      requiredText(descriptor?.contractVersion, 'descriptor.contractVersion', 1, 80),
      requiredText(descriptor?.adapterId, 'descriptor.adapterId', 1, 160),
      requiredText(descriptor?.adapterVersion, 'descriptor.adapterVersion', 1, 80),
      requiredText(descriptor?.sourceId, 'descriptor.sourceId', 1, 160),
      sourceKind,
      requiredText(descriptor?.sourceUri, 'descriptor.sourceUri', 1, 1_000),
      requiredText(descriptor?.sourceRevision, 'descriptor.sourceRevision', 1, 240),
      requiredText(descriptor?.sourceSha256, 'descriptor.sourceSha256', 1, 80),
      requiredText(metadata.artifactSha256, 'artifactSha256', 1, 80),
      JSON.stringify(descriptor?.license ?? {}),
      descriptor?.fixtureSeed ?? null,
      JSON.stringify(descriptor?.lineage ?? {}),
      JSON.stringify(descriptor?.capabilities ?? {}),
      new Date(virtualAsOf).toISOString(),
      new Date(sourceWatermark).toISOString(),
    ],
  );
}

async function refreshCommerceCatalog(client, tenantId) {
  await selectIngestTenant(client, tenantId);
  await client.query('SELECT commerce_refresh_tenant_catalog($1)', [tenantId]);
}

// Publishes a connector's explicit business-date coverage and rebuilds tenant partitions from
// the intersection of every active connector's proof. This is intentionally separate from the
// catalog refresh: facts, MIN/MAX dates and checkpoints are not completeness evidence.
async function publishCommerceCoverage(
  client,
  tenantId,
  connectorId,
  dataMode,
  runId,
  rawProof,
) {
  await selectIngestTenant(client, tenantId);
  let proof = parseCoverageProof(rawProof, dataMode);
  if (proof.kind === 'coordinated_incremental_scan') {
    const prior = await client.query(
      `SELECT MIN(partition_date)::text AS coverage_start,
              MAX(partition_date)::text AS coverage_end
       FROM commerce_connector_date_coverage
       WHERE tenant_id = $1 AND connector_id = $2`,
      [tenantId, connectorId],
    );
    const priorStart = prior.rows[0]?.coverage_start || null;
    const priorEnd = prior.rows[0]?.coverage_end || null;
    if (!priorStart || !priorEnd) {
      return { published: false, reason: 'full_history_reconciliation_required' };
    }
    if (proof.coverageEnd < priorEnd) {
      throw new Error('A coordinated incremental scan cannot shrink prior proven coverage.');
    }
    proof = { ...proof, coverageStart: priorStart };
  }
  await client.query(
    `DELETE FROM commerce_connector_date_coverage
     WHERE tenant_id = $1 AND connector_id = $2`,
    [tenantId, connectorId],
  );
  await client.query(
    `INSERT INTO commerce_connector_date_coverage
       (tenant_id, connector_id, partition_date, run_id, proof_kind, source_updated_at, proved_at)
     SELECT $1, $2, calendar.partition_date::date, $3, $4, $5::timestamptz, NOW()
     FROM generate_series($6::date, $7::date, INTERVAL '1 day') AS calendar(partition_date)`,
    [
      tenantId,
      connectorId,
      runId,
      proof.kind,
      proof.sourceUpdatedAt,
      proof.coverageStart,
      proof.coverageEnd,
    ],
  );
  await client.query(
    'DELETE FROM commerce_tenant_data_partitions WHERE tenant_id = $1',
    [tenantId],
  );
  await client.query(
    `WITH connector_count AS (
       SELECT COUNT(*)::integer AS expected
       FROM commerce_connector_checkpoints
       WHERE tenant_id = $1
     ), proved_dates AS (
       SELECT coverage.partition_date,
              ARRAY_AGG(coverage.connector_id ORDER BY coverage.connector_id) AS connector_ids,
              ARRAY_AGG(coverage.run_id ORDER BY coverage.connector_id) AS run_ids,
              MIN(checkpoint.data_mode) AS data_mode,
              MAX(coverage.source_updated_at) AS source_updated_at
       FROM commerce_connector_date_coverage AS coverage
       JOIN commerce_connector_checkpoints AS checkpoint
         ON checkpoint.tenant_id = coverage.tenant_id
        AND checkpoint.connector_id = coverage.connector_id
       WHERE coverage.tenant_id = $1
       GROUP BY coverage.partition_date
       HAVING COUNT(*) = (SELECT expected FROM connector_count)
          AND (SELECT expected FROM connector_count) > 0
     ), fact_counts AS (
       SELECT metric_date, COUNT(*)::bigint AS fact_row_count,
              MAX(ingested_at) AS last_ingested_at
       FROM commerce_daily_metrics
       WHERE tenant_id = $1
       GROUP BY metric_date
     )
     INSERT INTO commerce_tenant_data_partitions
       (tenant_id, partition_date, data_mode, fact_row_count, last_ingested_at,
        source_updated_at, completeness_state, coverage_proof_kind,
        coverage_connector_ids, coverage_run_ids, refreshed_at)
     SELECT $1, proved_dates.partition_date, proved_dates.data_mode,
            COALESCE(fact_counts.fact_row_count, 0),
            COALESCE(fact_counts.last_ingested_at, NOW()),
            proved_dates.source_updated_at, 'ready', 'connector_coverage_intersection',
            proved_dates.connector_ids, proved_dates.run_ids, NOW()
     FROM proved_dates
     LEFT JOIN fact_counts ON fact_counts.metric_date = proved_dates.partition_date`,
    [tenantId],
  );
  return { published: true, proof };
}

const SOURCE_FACT_COLUMNS = [
  'tenant_id', 'connector_id', 'source_entity_id', 'source_line_id', 'metric_date', 'region',
  'channel', 'sku', 'category', 'business_timezone', 'currency_code', 'paid_orders', 'units',
  'gmv', 'refund_amount', 'source_updated_at',
];

// Validates one order- or refund-level staging line from an incremental connector (Shopify
// today). Unlike parseCommerceRow, this is not a full daily-metrics bucket: it is a single
// source record's contribution, later aggregated by recomputeDailyMetricsFromSourceFacts.
function parseCommerceSourceFactRow(value, connectorId, line, forcedTenantId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Source fact ${line}: each record must be an object.`);
  }
  const tenantId = forcedTenantId || requiredText(value.tenant_id, 'tenant_id', line);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(tenantId)) {
    throw new Error(`Source fact ${line}: tenant_id contains unsupported characters.`);
  }
  const metricDate = requiredText(value.metric_date, 'metric_date', line);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(metricDate) || !validIsoDate(metricDate)) {
    throw new Error(`Source fact ${line}: metric_date must be a valid YYYY-MM-DD date.`);
  }
  const sourceUpdatedAt = requiredText(value.source_updated_at, 'source_updated_at', line);
  if (!Number.isFinite(Date.parse(sourceUpdatedAt))) {
    throw new Error(`Source fact ${line}: source_updated_at must be an ISO timestamp.`);
  }
  return {
    tenant_id: tenantId,
    connector_id: requiredText(connectorId, 'connector_id', line, 128),
    source_entity_id: requiredText(value.source_entity_id, 'source_entity_id', line, 200),
    source_line_id: requiredText(value.source_line_id, 'source_line_id', line, 200),
    metric_date: metricDate,
    region: requiredText(value.region, 'region', line, 120),
    channel: requiredText(value.channel, 'channel', line, 120),
    sku: requiredText(value.sku, 'sku', line, 120),
    category: requiredText(value.category, 'category', line, 120),
    business_timezone: businessTimeZone(value.business_timezone, line),
    currency_code: currencyCode(value.currency_code, line),
    paid_orders: integer(value.paid_orders ?? 0, 'paid_orders', line),
    units: integer(value.units ?? 0, 'units', line),
    gmv: decimal(value.gmv ?? 0, 'gmv', line),
    refund_amount: decimal(value.refund_amount ?? 0, 'refund_amount', line),
    source_updated_at: sourceUpdatedAt,
  };
}

function parseSourceEntityReconciliation(value, line = 1) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Source entity ${line}: each reconciliation must be an object.`);
  }
  const sourceEntityId = requiredText(
    value.source_entity_id,
    'source_entity_id',
    line,
    200,
  );
  if (!Array.isArray(value.source_line_ids)) {
    throw new Error(`Source entity ${line}: source_line_ids must be an array.`);
  }
  const sourceLineIds = value.source_line_ids.map((item) => requiredText(
    item,
    'source_line_ids',
    line,
    200,
  ));
  if (new Set(sourceLineIds).size !== sourceLineIds.length) {
    throw new Error(`Source entity ${line}: source_line_ids must not contain duplicates.`);
  }
  return { source_entity_id: sourceEntityId, source_line_ids: sourceLineIds };
}

async function upsertSourceFacts(client, tenantId, connectorId, rows) {
  if (!rows.length) return;
  if (rows.some((row) => row.tenant_id !== tenantId || row.connector_id !== connectorId)) {
    throw new Error('A Commerce source-fact batch must contain exactly one tenant and connector.');
  }
  await selectIngestTenant(client, tenantId);
  for (let offset = 0; offset < rows.length; offset += 250) {
    const batch = rows.slice(offset, offset + 250);
    const values = [];
    const tuples = batch.map((row, rowIndex) => {
      const placeholders = SOURCE_FACT_COLUMNS.map((column, columnIndex) => {
        values.push(row[column]);
        return `$${rowIndex * SOURCE_FACT_COLUMNS.length + columnIndex + 1}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const updates = SOURCE_FACT_COLUMNS
      .filter((column) => !['tenant_id', 'connector_id', 'source_line_id'].includes(column))
      .map((column) => `${column} = EXCLUDED.${column}`)
      .concat('ingested_at = NOW()');
    await client.query(
      `INSERT INTO commerce_connector_source_facts (${SOURCE_FACT_COLUMNS.join(', ')})
       VALUES ${tuples.join(', ')}
       ON CONFLICT (tenant_id, connector_id, source_line_id)
       DO UPDATE SET ${updates.join(', ')}`,
      values,
    );
  }
}

function uniqueBucketKeys(rows) {
  return [...new Map(rows.map((row) => [
    [row.metric_date, row.region, row.channel, row.sku].join('\u001f'),
    {
      metric_date: row.metric_date,
      region: row.region,
      channel: row.channel,
      sku: row.sku,
    },
  ])).values()];
}

// Replaces the complete set of lines for every source entity observed in an incremental
// window. Shopify returns the full current order (including all refunds), so entity-level
// replacement gives us tombstones for PAID -> VOID, deleted refunds, and dimension moves
// without deleting untouched orders outside the window. Old bucket keys are returned with
// new keys so the caller can remove buckets that became empty as well as populate new ones.
async function reconcileSourceFacts(client, tenantId, connectorId, rows, reconciliations) {
  if (rows.some((row) => row.tenant_id !== tenantId || row.connector_id !== connectorId)) {
    throw new Error('A Commerce source-fact reconciliation must contain exactly one tenant and connector.');
  }
  const desiredByEntity = new Map();
  for (const reconciliation of reconciliations) {
    if (desiredByEntity.has(reconciliation.source_entity_id)) {
      throw new Error('A Commerce source-fact reconciliation must not repeat a source entity.');
    }
    desiredByEntity.set(reconciliation.source_entity_id, new Set(reconciliation.source_line_ids));
  }
  const seenLineIds = new Set();
  for (const row of rows) {
    const desiredLines = desiredByEntity.get(row.source_entity_id);
    if (!desiredLines || !desiredLines.has(row.source_line_id)) {
      throw new Error('Every Commerce source fact must be declared by its source entity reconciliation.');
    }
    if (seenLineIds.has(row.source_line_id)) {
      throw new Error('A Commerce source-fact reconciliation must not repeat a source line.');
    }
    seenLineIds.add(row.source_line_id);
  }
  for (const desiredLines of desiredByEntity.values()) {
    for (const sourceLineId of desiredLines) {
      if (!seenLineIds.has(sourceLineId)) {
        throw new Error('Every declared Commerce source line must have a corresponding fact.');
      }
    }
  }
  if (!reconciliations.length) {
    if (rows.length) throw new Error('Commerce source facts require source entity reconciliations.');
    return [];
  }

  await selectIngestTenant(client, tenantId);
  const oldBuckets = [];
  const entityIds = reconciliations.map((item) => item.source_entity_id);
  for (let offset = 0; offset < entityIds.length; offset += 250) {
    const batch = entityIds.slice(offset, offset + 250);
    const deleted = await client.query(
      `DELETE FROM commerce_connector_source_facts
       WHERE tenant_id = $1 AND connector_id = $2 AND source_entity_id = ANY($3::text[])
       RETURNING metric_date::text AS metric_date, region, channel, sku`,
      [tenantId, connectorId, batch],
    );
    oldBuckets.push(...deleted.rows);
  }
  await upsertSourceFacts(client, tenantId, connectorId, rows);
  return uniqueBucketKeys([...oldBuckets, ...rows]);
}

// Serializes tenant ownership claims and rejects cross-connector or snapshot/incremental
// mode switches. Checkpoints are the durable owner record; staged facts are also consulted
// to fail closed if a previous migration/run left facts without a checkpoint. The expected
// checkpoint is an optimistic write fence against a timed-out process resuming after a newer
// run has advanced the connector.
async function assertConnectorOwnership(
  client,
  tenantId,
  connectorId,
  dataMode,
  expectedCheckpoint,
) {
  if (!['snapshot', 'incremental'].includes(dataMode)) {
    throw new Error('Commerce connector ownership requires snapshot or incremental mode.');
  }
  await selectIngestTenant(client, tenantId);
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('commerce-connector-owner:' || $1, 0))",
    [tenantId],
  );
  const checkpoints = await client.query(
    `SELECT connector_id, data_mode, source_fact_state, checkpoint
     FROM commerce_connector_checkpoints
     WHERE tenant_id = $1
     ORDER BY connector_id
     FOR UPDATE`,
    [tenantId],
  );
  const stagedOwners = await client.query(
    `SELECT DISTINCT connector_id
     FROM commerce_connector_source_facts
     WHERE tenant_id = $1
     ORDER BY connector_id`,
    [tenantId],
  );
  const owners = new Set([
    ...checkpoints.rows.map((row) => row.connector_id),
    ...stagedOwners.rows.map((row) => row.connector_id),
  ]);
  const incompatibleOwner = checkpoints.rows.find((row) => (
    row.connector_id !== connectorId && row.data_mode !== dataMode
  ));
  if (incompatibleOwner) {
    throw new Error(
      `Commerce tenant ${tenantId} connector ${incompatibleOwner.connector_id} uses `
      + `${incompatibleOwner.data_mode}; all sources for one tenant must share a data mode.`,
    );
  }
  const checkpoint = checkpoints.rows.find((row) => row.connector_id === connectorId);
  if (!checkpoint && stagedOwners.rows.some((row) => row.connector_id === connectorId)) {
    throw new Error(
      `Commerce connector ${connectorId} has uncheckpointed incremental source facts; `
      + 'an explicit source-fact bootstrap or tenant reset is required.',
    );
  }
  if (!owners.size) {
    const unownedFacts = await client.query(
      'SELECT 1 AS present FROM commerce_daily_metrics WHERE tenant_id = $1 LIMIT 1',
      [tenantId],
    );
    if (unownedFacts.rows.length) {
      throw new Error(
        `Commerce tenant ${tenantId} contains unowned daily metrics; `
        + 'refusing implicit connector takeover. Perform an explicit tenant reset first.',
      );
    }
  }
  if (checkpoint && checkpoint.data_mode !== dataMode) {
    throw new Error(
      `Commerce connector ${connectorId} cannot switch from ${checkpoint.data_mode} to ${dataMode} mode without an explicit tenant reset.`,
    );
  }
  if (checkpoint?.source_fact_state === 'bootstrap_required') {
    throw new Error(
      `Commerce connector ${connectorId} source-fact staging is not bootstrapped; `
      + 'do not advance the existing checkpoint until a full source backfill or explicit tenant reset completes.',
    );
  }
  const currentCheckpoint = checkpoint?.checkpoint ?? null;
  if (currentCheckpoint !== (expectedCheckpoint ?? null)) {
    throw new Error(
      `Commerce connector ${connectorId} checkpoint advanced while this run was in progress; refusing a stale write.`,
    );
  }
}

// The JSONL importer is an official writer and therefore must participate in the same
// durable tenant-owner record as scheduled connectors. A reserved connector id lets repeat
// imports proceed, while a connector-owned tenant fails closed instead of being silently
// overwritten outside the source-fact/snapshot reconciliation contract.
async function claimCommerceDirectWriterOwnership(
  client,
  tenantId,
  connectorId,
  dataMode,
  connectorVersion = '1.0.0',
  sourceSha256 = null,
) {
  if (
    dataMode === 'snapshot'
    && !/^sha256:[0-9a-f]{64}$/u.test(String(sourceSha256 || ''))
  ) {
    throw new Error('A direct snapshot import requires a sha256 source identity.');
  }
  await selectIngestTenant(client, tenantId);
  const existing = await client.query(
    `SELECT checkpoint
     FROM commerce_connector_checkpoints
     WHERE tenant_id = $1 AND connector_id = $2`,
    [tenantId, connectorId],
  );
  const expectedCheckpoint = existing.rows[0]?.checkpoint ?? null;
  await assertConnectorOwnership(
    client,
    tenantId,
    connectorId,
    dataMode,
    expectedCheckpoint,
  );
  await client.query(
    `INSERT INTO commerce_connector_checkpoints
       (tenant_id, connector_id, connector_version, data_mode, source_fact_state,
        checkpoint, source_sha256, updated_at)
     VALUES ($1, $2, $3, $4, 'not_applicable', 'direct-writer', $5, NOW())
     ON CONFLICT (tenant_id, connector_id) DO UPDATE SET
       connector_version = EXCLUDED.connector_version,
       data_mode = EXCLUDED.data_mode,
       source_sha256 = EXCLUDED.source_sha256,
       updated_at = NOW()`,
    [tenantId, connectorId, connectorVersion, dataMode, sourceSha256],
  );
}

// Recomputes commerce_daily_metrics for exactly the (metric_date, region, channel, sku)
// buckets touched by this run, re-aggregating from the *complete* staged order/refund
// history for those buckets (not just the rows this run happened to touch). This is what
// makes a partial incremental window safe to write with an overwriting upsert. The preceding
// delete is equally important: when all staged lines move away from or disappear from a touched
// bucket, no aggregate row remains to conflict-update, so the old daily row must be removed.
async function recomputeDailyMetricsFromSourceFacts(
  client,
  tenantId,
  connectorId,
  bucketKeys,
  availableMetrics,
) {
  if (!bucketKeys.length) return;
  await selectIngestTenant(client, tenantId);
  const metricsLiteral = `ARRAY[${availableMetrics.map((metric) => `'${metric}'`).join(', ')}]::text[]`;
  for (let offset = 0; offset < bucketKeys.length; offset += 200) {
    const batch = bucketKeys.slice(offset, offset + 200);
    const bucketValues = [];
    const tuples = batch.map((key) => {
      bucketValues.push(key.metric_date, key.region, key.channel, key.sku);
      const base = bucketValues.length - 4;
      return `($${base + 1}::date, $${base + 2}, $${base + 3}, $${base + 4})`;
    });
    const tenantParam = `$${bucketValues.length + 1}`;
    const connectorParam = `$${bucketValues.length + 2}`;
    const sourceFactValues = [...bucketValues, tenantId, connectorId];
    const incompatible = await client.query(
      `WITH touched(metric_date, region, channel, sku) AS (VALUES ${tuples.join(', ')})
       SELECT f.metric_date::text AS metric_date, f.region, f.channel, f.sku,
              ARRAY_AGG(DISTINCT f.currency_code ORDER BY f.currency_code) AS currency_codes
       FROM commerce_connector_source_facts AS f
       JOIN touched AS t
         ON t.metric_date = f.metric_date AND t.region = f.region
        AND t.channel = f.channel AND t.sku = f.sku
       WHERE f.tenant_id = ${tenantParam} AND f.connector_id = ${connectorParam}
       GROUP BY f.metric_date, f.region, f.channel, f.sku
       HAVING COUNT(DISTINCT f.currency_code) > 1
       LIMIT 1`,
      sourceFactValues,
    );
    if (incompatible.rows.length) {
      const bucket = incompatible.rows[0];
      throw new Error(
        `Commerce source-fact bucket ${bucket.metric_date}/${bucket.region}/${bucket.channel}/${bucket.sku} `
        + `contains multiple currencies (${(bucket.currency_codes || []).join(', ')}); `
        + 'currency conversion or a full source reset is required.',
      );
    }
    await client.query(
      `WITH touched(metric_date, region, channel, sku) AS (VALUES ${tuples.join(', ')})
       DELETE FROM commerce_daily_metrics AS d
       USING touched AS t
        WHERE d.tenant_id = ${tenantParam}
          AND d.source_id = ${connectorParam}
          AND d.metric_date = t.metric_date AND d.region = t.region
          AND d.channel = t.channel AND d.sku = t.sku`,
      sourceFactValues,
    );
    await client.query(
      `WITH touched(metric_date, region, channel, sku) AS (VALUES ${tuples.join(', ')})
       INSERT INTO commerce_daily_metrics (
         tenant_id, source_id, metric_date, region, channel, sku, category, business_timezone,
         data_mode, currency_code, visits, paid_orders, units, gmv, refund_orders,
         refund_amount, cost_amount, ad_spend, new_customers, stockout_hours,
         ending_inventory, available_metrics, source_updated_at
       )
        SELECT f.tenant_id, f.connector_id, f.metric_date, f.region, f.channel, f.sku,
              MIN(f.category), MIN(f.business_timezone), 'incremental', MIN(f.currency_code),
              0, SUM(f.paid_orders), SUM(f.units), SUM(f.gmv), 0, SUM(f.refund_amount),
              0, 0, 0, 0, 0, ${metricsLiteral}, MAX(f.source_updated_at)
       FROM commerce_connector_source_facts AS f
       JOIN touched AS t
         ON t.metric_date = f.metric_date AND t.region = f.region
        AND t.channel = f.channel AND t.sku = f.sku
       WHERE f.tenant_id = ${tenantParam} AND f.connector_id = ${connectorParam}
        GROUP BY f.tenant_id, f.connector_id, f.metric_date, f.region, f.channel, f.sku
        ON CONFLICT (tenant_id, source_id, metric_date, region, channel, sku) DO UPDATE SET
         category = EXCLUDED.category,
         business_timezone = EXCLUDED.business_timezone,
         data_mode = EXCLUDED.data_mode,
         currency_code = EXCLUDED.currency_code,
         paid_orders = EXCLUDED.paid_orders,
         units = EXCLUDED.units,
         gmv = EXCLUDED.gmv,
         refund_amount = EXCLUDED.refund_amount,
         available_metrics = EXCLUDED.available_metrics,
         source_updated_at = EXCLUDED.source_updated_at,
         ingested_at = NOW()`,
      sourceFactValues,
    );
  }
}

module.exports = {
  COLUMNS,
  AVAILABLE_METRIC_FIELDS,
  parseCoverageProof,
  parseCommerceRow,
  parseCommerceBusinessEvent,
  parseCommerceSourceFactRow,
  parseSourceEntityReconciliation,
  refreshCommerceCatalog,
  publishCommerceCoverage,
  selectIngestTenant,
  upsertCommerceRows,
  replaceCommerceSnapshot,
  replaceCommerceBusinessEvents,
  persistCommerceSourceSnapshot,
  upsertSourceFacts,
  reconcileSourceFacts,
  assertConnectorOwnership,
  claimCommerceDirectWriterOwnership,
  recomputeDailyMetricsFromSourceFacts,
};
