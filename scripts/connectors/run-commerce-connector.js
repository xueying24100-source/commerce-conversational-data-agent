#!/usr/bin/env node

const { createHash, randomUUID } = require('node:crypto');
const { lookup } = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { Pool } = require('pg');

const { loadLocalEnv } = require('../db/load-local-env');
const {
  COLUMNS,
  assertConnectorOwnership,
  parseCommerceBusinessEvent,
  parseCommerceRow,
  parseCommerceSourceFactRow,
  parseSourceEntityReconciliation,
  publishCommerceCoverage,
  persistCommerceSourceSnapshot,
  reconcileSourceFacts,
  refreshCommerceCatalog,
  replaceCommerceSnapshot,
  replaceCommerceBusinessEvents,
  selectIngestTenant,
  recomputeDailyMetricsFromSourceFacts,
} = require('../db/commerce-ingest-core');
const { SHOPIFY_AVAILABLE_METRICS, loadShopifySource } = require('./shopify-source');
const { loadOlistPublicSource } = require('./olist-public-source');
const { loadCommerceFixtureSource } = require('./commerce-fixture-source');

const root = path.join(__dirname, '..', '..');
loadLocalEnv(root);

function requiredString(value, name, pattern) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || (pattern && !pattern.test(normalized))) {
    throw new Error(`${name} is invalid or missing.`);
  }
  return normalized;
}

function readPath(value, dottedPath) {
  return dottedPath.split('.').reduce(
    (current, part) => current && typeof current === 'object' ? current[part] : undefined,
    value,
  );
}

function boundedInteger(value, name, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function snapshotCoverageContract(config) {
  const start = requiredString(config.coverage?.start, 'coverage.start', /^\d{4}-\d{2}-\d{2}$/u);
  const end = requiredString(config.coverage?.end, 'coverage.end', /^\d{4}-\d{2}-\d{2}$/u);
  const complete = config.coverage?.complete === true;
  if (!complete) {
    throw new Error('Snapshot connectors require coverage.complete=true as an explicit full-snapshot contract.');
  }
  if (!Number.isFinite(Date.parse(`${start}T00:00:00.000Z`))
      || !Number.isFinite(Date.parse(`${end}T00:00:00.000Z`))
      || start > end) {
    throw new Error('Snapshot coverage.start/end must be a valid ordered YYYY-MM-DD range.');
  }
  return { start, end };
}

function connectorCoverageContract(config, ingestMode) {
  if (ingestMode === 'snapshot') return snapshotCoverageContract(config);
  if (config.coverage === undefined) return null;
  const start = requiredString(config.coverage?.start, 'coverage.start', /^\d{4}-\d{2}-\d{2}$/u);
  const end = requiredString(config.coverage?.end, 'coverage.end', /^\d{4}-\d{2}-\d{2}$/u);
  if (config.coverage?.complete !== true || config.coverage?.proof !== 'full_history_reconciliation') {
    throw new Error('Incremental coverage requires an explicit full_history_reconciliation contract.');
  }
  if (!Number.isFinite(Date.parse(`${start}T00:00:00.000Z`))
      || !Number.isFinite(Date.parse(`${end}T00:00:00.000Z`))
      || start > end) {
    throw new Error('Incremental coverage.start/end must be a valid ordered YYYY-MM-DD range.');
  }
  return { start, end };
}

function resolveConnectorMode(config) {
  const requested = config.sourceMode === undefined
    ? null
    : requiredString(config.sourceMode, 'sourceMode');
  if (requested && !['snapshot', 'incremental'].includes(requested)) {
    throw new Error('sourceMode must be snapshot or incremental.');
  }
  if (config.source.type === 'shopify') {
    if (requested && requested !== 'incremental') {
      throw new Error('Shopify connectors require sourceMode=incremental.');
    }
    return 'incremental';
  }
  if (config.source.type === 'https') {
    if (!requested) {
      throw new Error(
        'HTTPS connectors must declare sourceMode explicitly; checkpoint parameters do not prove a complete snapshot.',
      );
    }
    if (requested === 'incremental') {
      throw new Error(
        'Generic HTTPS sourceMode=incremental is unsupported without a stable source-fact reconciliation adapter.',
      );
    }
    return 'snapshot';
  }
  if (requested && requested !== 'snapshot') {
    throw new Error(`${config.source.type} connectors require sourceMode=snapshot.`);
  }
  return 'snapshot';
}

function projectRecord(record, fieldMap, tenantId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Connector records must be JSON objects.');
  }
  const projected = { tenant_id: tenantId };
  for (const [target, source] of Object.entries(fieldMap || {})) {
    if (!COLUMNS.includes(target) || target === 'tenant_id') {
      throw new Error(`fieldMap target is not supported: ${target}`);
    }
    projected[target] = readPath(record, requiredString(source, `fieldMap.${target}`));
  }
  for (const key of [
    'metric_date', 'region', 'channel', 'sku', 'category', 'business_timezone', 'data_mode',
    'currency_code',
    'visits', 'paid_orders',
    'units', 'gmv', 'refund_orders', 'refund_amount', 'cost_amount', 'ad_spend',
    'new_customers', 'stockout_hours', 'ending_inventory', 'available_metrics',
    'source_updated_at',
  ]) {
    if (!(key in projected)) projected[key] = record[key];
  }
  return projected;
}

function parseRecords(body, format) {
  if (format === 'json') {
    const value = JSON.parse(body);
    if (!Array.isArray(value)) throw new Error('JSON connector response must be an array.');
    return value;
  }
  return body.split(/\r?\n/u).filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Connector JSONL line ${index + 1} is invalid JSON.`);
    }
  });
}

function privateNetworkAddress(address) {
  const normalized = String(address || '').toLowerCase().split('%')[0];
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  const candidate = mapped || normalized;
  if (net.isIPv4(candidate)) {
    const [first, second] = candidate.split('.').map(Number);
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 198 && [18, 19].includes(second))
      || first >= 224;
  }
  if (net.isIPv6(candidate)) {
    return candidate === '::'
      || candidate === '::1'
      || candidate.startsWith('fc')
      || candidate.startsWith('fd')
      || /^fe[89ab]/u.test(candidate)
      || candidate.startsWith('ff');
  }
  return true;
}

async function validateHttpsSourceUrl(source, value, resolver = lookup) {
  const url = value instanceof URL ? new URL(value.href) : new URL(requiredString(value, 'source.url'));
  if (url.protocol !== 'https:') throw new Error('HTTP connector URLs must use HTTPS.');
  if (url.username || url.password) throw new Error('HTTPS connector URLs must not embed credentials.');
  const allowedHosts = Array.isArray(source.allowedHosts)
    ? source.allowedHosts.map((host) => requiredString(host, 'source.allowedHosts[]').toLowerCase())
    : [];
  if (!allowedHosts.length || new Set(allowedHosts).size !== allowedHosts.length) {
    throw new Error('HTTPS connectors require a non-empty, duplicate-free source.allowedHosts list.');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (!allowedHosts.includes(hostname)) {
    throw new Error(`HTTPS connector host ${hostname} is not in source.allowedHosts.`);
  }
  const resolved = net.isIP(hostname)
    ? [{ address: hostname }]
    : await resolver(hostname, { all: true, verbatim: true });
  if (!Array.isArray(resolved) || !resolved.length) {
    throw new Error(`HTTPS connector host ${hostname} did not resolve.`);
  }
  if (resolved.some((entry) => privateNetworkAddress(entry.address))) {
    throw new Error(`HTTPS connector host ${hostname} resolved to a prohibited network address.`);
  }
  return url;
}

async function loadSource(config, configDirectory, checkpoint, limits, runContext = {}) {
  if (config.source.type === 'commerce_fixture') {
    return loadCommerceFixtureSource(config.source, checkpoint, limits, {
      ...runContext,
      allowUnchanged: runContext.checkpointVersion === runContext.connectorVersion,
    });
  }
  if (config.source.type === 'olist') {
    return loadOlistPublicSource(config.source, checkpoint, limits, {
      allowUnchanged: runContext.checkpointVersion === runContext.connectorVersion,
    });
  }
  if (config.source.type === 'shopify') {
    return loadShopifySource(config.source, checkpoint, limits);
  }
  if (config.source.type === 'file') {
    const sourcePath = path.resolve(configDirectory, requiredString(config.source.path, 'source.path'));
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) throw new Error('Connector file source must be a regular file.');
    if (stat.size > limits.maxBytes) throw new Error('Connector file exceeded maxBytes.');
    const body = fs.readFileSync(sourcePath, 'utf8');
    return {
      body,
      checkpointAfter: null,
      transport: 'file',
      coverageProof: {
        kind: 'complete_snapshot',
        coverageStart: runContext.snapshotCoverage.start,
        coverageEnd: runContext.snapshotCoverage.end,
        sourceUpdatedAt: new Date(stat.mtimeMs).toISOString(),
      },
    };
  }
  let url = await validateHttpsSourceUrl(config.source, config.source.url);
  if (checkpoint && config.source.checkpointQueryParam) {
    url.searchParams.set(config.source.checkpointQueryParam, checkpoint);
  }
  const headers = { Accept: config.format === 'json' ? 'application/json' : 'application/x-ndjson' };
  if (config.source.bearerTokenEnv) {
    const bearerTokenEnv = requiredString(
      config.source.bearerTokenEnv,
      'source.bearerTokenEnv',
      /^[A-Z][A-Z0-9_]{2,127}$/u,
    );
    const token = process.env[bearerTokenEnv];
    if (!token) throw new Error(`${config.source.bearerTokenEnv} is required for the connector.`);
    headers.Authorization = `Bearer ${token}`;
  }
  let response;
  const initialOrigin = url.origin;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    response = await fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(limits.timeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location) throw new Error('HTTPS connector redirect omitted Location.');
    if (redirects === 3) throw new Error('HTTPS connector exceeded 3 redirects.');
    const redirected = await validateHttpsSourceUrl(config.source, new URL(location, url));
    if (redirected.origin !== initialOrigin) {
      throw new Error('HTTPS connector redirects must remain on the original origin.');
    }
    url = redirected;
  }
  if (!response.ok) throw new Error(`Connector source returned HTTP ${response.status}.`);
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > limits.maxBytes) {
    throw new Error('Connector response exceeded maxBytes.');
  }
  return {
    body,
    checkpointAfter: config.source.checkpointResponseHeader
      ? response.headers.get(config.source.checkpointResponseHeader)
      : null,
    transport: 'https',
    coverageProof: {
      kind: 'complete_snapshot',
      coverageStart: runContext.snapshotCoverage.start,
      coverageEnd: runContext.snapshotCoverage.end,
      sourceUpdatedAt: response.headers.get('last-modified') || new Date().toISOString(),
    },
  };
}

function poolOptions(connectionString, applicationName) {
  const sslEnabled = /^(?:1|true|yes|on)$/i.test(process.env.COMMERCE_PG_SSL || '');
  const rejectUnauthorized = !/^(?:0|false|no|off)$/i.test(
    process.env.COMMERCE_PG_REJECT_UNAUTHORIZED || 'true',
  );
  const ca = process.env.COMMERCE_PG_CA?.replace(/\\n/g, '\n').trim();
  if (process.env.NODE_ENV === 'production' && (!sslEnabled || !rejectUnauthorized)) {
    throw new Error('Production connectors require verified PostgreSQL TLS.');
  }
  return {
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000,
    application_name: applicationName,
    ...(sslEnabled ? { ssl: { rejectUnauthorized, ...(ca ? { ca } : {}) } } : {}),
  };
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function runCommerceConnector(options = {}) {
  const startedAt = Date.now();
  const configArgument = options.config ? null : options.configArgument || process.argv[2];
  if (!options.config && !configArgument) {
    throw new Error('Usage: npm run connector:commerce -- <connector.json>');
  }
  const configPath = configArgument ? path.resolve(root, configArgument) : null;
  const config = options.config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const configDirectory = options.configDirectory
    || (configPath ? path.dirname(configPath) : root);
  if (config.schemaVersion !== 1) throw new Error('Connector schemaVersion must be 1.');
  const connectorId = requiredString(config.connectorId, 'connectorId', /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u);
  const connectorVersion = requiredString(config.connectorVersion, 'connectorVersion', /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u);
  const tenantId = requiredString(config.tenantId, 'tenantId', /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u);
  if (!config.source || ![
    'file', 'https', 'shopify', 'olist', 'commerce_fixture',
  ].includes(config.source.type)) {
    throw new Error('source.type must be file, https, shopify, olist, or commerce_fixture.');
  }
  if (!['shopify', 'olist', 'commerce_fixture'].includes(config.source.type)
      && !['jsonl', 'json'].includes(config.format)) {
    throw new Error('format must be jsonl or json for file and https sources.');
  }
  const isShopify = config.source.type === 'shopify';
  const ingestMode = resolveConnectorMode(config);
  const declaredCoverage = connectorCoverageContract(config, ingestMode);
  const limits = {
    maxRows: boundedInteger(config.maxRows, 'maxRows', 1_000_000, 1, 5_000_000),
    maxBytes: boundedInteger(config.maxBytes, 'maxBytes', 100_000_000, 1_024, 1_000_000_000),
    timeoutMs: boundedInteger(config.source.timeoutMs, 'source.timeoutMs', 30_000, 1_000, 300_000),
    retentionDays: boundedInteger(
      process.env.COMMERCE_CONNECTOR_RUN_RETENTION_DAYS,
      'COMMERCE_CONNECTOR_RUN_RETENTION_DAYS',
      90,
      7,
      3_650,
    ),
    staleRunMinutes: boundedInteger(
      process.env.COMMERCE_CONNECTOR_STALE_RUN_MINUTES,
      'COMMERCE_CONNECTOR_STALE_RUN_MINUTES',
      180,
      10,
      10_080,
    ),
  };
  const connectionString = process.env.COMMERCE_ANALYTICS_INGEST_DATABASE_URL
    || (process.env.NODE_ENV === 'production' ? null : process.env.COMMERCE_DATABASE_URL || process.env.DATABASE_URL);
  if (!connectionString && !options.database) {
    throw new Error('COMMERCE_ANALYTICS_INGEST_DATABASE_URL is required.');
  }
  const ownsDatabase = !options.database;
  const database = options.database
    || new Pool(poolOptions(connectionString, `commerce-connector-${connectorId}`));
  const sourceLoader = options.loadSource || loadSource;
  const log = options.log || console.log;
  const runId = `connector_run_${randomUUID()}`;
  let checkpointBefore = null;
  try {
    let checkpointVersion = null;
    checkpointBefore = await transaction(database, async (client) => {
      await selectIngestTenant(client, tenantId);
      const checkpoint = await client.query(
        `SELECT checkpoint, connector_version FROM commerce_connector_checkpoints
         WHERE tenant_id = $1 AND connector_id = $2`,
        [tenantId, connectorId],
      );
      await assertConnectorOwnership(
        client,
        tenantId,
        connectorId,
        ingestMode,
        checkpoint.rows[0]?.checkpoint || null,
      );
      checkpointVersion = checkpoint.rows[0]?.connector_version || null;
      await client.query(
        `UPDATE commerce_connector_runs
         SET status = 'failed', error_code = 'CONNECTOR_STALE_RUN',
             error_message = 'Connector process stopped before completion.', completed_at = NOW()
         WHERE tenant_id = $1 AND connector_id = $2 AND status = 'running'
           AND started_at < NOW() - ($3::integer * INTERVAL '1 minute')`,
        [tenantId, connectorId, limits.staleRunMinutes],
      );
      await client.query(
        `DELETE FROM commerce_connector_runs
         WHERE tenant_id = $1 AND connector_id = $2 AND status <> 'running'
           AND completed_at < NOW() - ($3::integer * INTERVAL '1 day')`,
        [tenantId, connectorId, limits.retentionDays],
      );
      await client.query(
        `INSERT INTO commerce_connector_runs
           (id, tenant_id, connector_id, connector_version, transport, status, checkpoint_before)
         VALUES ($1, $2, $3, $4, $5, 'running', $6)`,
        [runId, tenantId, connectorId, connectorVersion, config.source.type, checkpoint.rows[0]?.checkpoint || null],
      );
      return checkpoint.rows[0]?.checkpoint || null;
    });
    const source = await sourceLoader(
      config,
      configDirectory,
      checkpointBefore,
      limits,
      { checkpointVersion, connectorVersion, snapshotCoverage: declaredCoverage },
    );
    const sourceSha256 = source.sourceSha256
      || `sha256:${createHash('sha256').update(source.body).digest('hex')}`;
    if (source.unchanged) {
      await transaction(database, async (client) => {
        await selectIngestTenant(client, tenantId);
        await client.query(
          `UPDATE commerce_connector_runs SET status = 'skipped', source_sha256 = $1,
             checkpoint_after = $2, completed_at = NOW() WHERE id = $3`,
          [sourceSha256, source.checkpointAfter || checkpointBefore, runId],
        );
      });
      log(JSON.stringify({
        runId,
        connectorId,
        tenantId,
        status: 'skipped',
        sourceRows: 0,
        importedRows: 0,
        sourceSha256,
        durationMs: Date.now() - startedAt,
      }));
      return;
    }
    if (
      source.transport === 'file'
      && checkpointVersion === connectorVersion
      && checkpointBefore === sourceSha256
    ) {
      await transaction(database, async (client) => {
        await selectIngestTenant(client, tenantId);
        await client.query(
          `UPDATE commerce_connector_runs SET status = 'skipped', source_sha256 = $1,
             checkpoint_after = $1, completed_at = NOW() WHERE id = $2`,
          [sourceSha256, runId],
        );
      });
      log(JSON.stringify({
        runId,
        connectorId,
        tenantId,
        status: 'skipped',
        importedRows: 0,
        durationMs: Date.now() - startedAt,
      }));
      return;
    }
    const checkpointAfter = source.checkpointAfter || sourceSha256;
    let coverageProof = source.coverageProof || null;
    if (!isShopify) {
      if (
        coverageProof?.kind !== 'complete_snapshot'
        || coverageProof.coverageStart !== declaredCoverage.start
        || coverageProof.coverageEnd !== declaredCoverage.end
      ) {
        throw new Error('Snapshot source coverage proof must exactly match the configured complete coverage contract.');
      }
    } else if (coverageProof) {
      if (coverageProof.kind === 'full_history_reconciliation') {
        if (
          !declaredCoverage
          || coverageProof.coverageStart !== declaredCoverage.start
          || coverageProof.coverageEnd !== declaredCoverage.end
        ) {
          throw new Error('Shopify full-history coverage proof must match its explicit reconciliation contract.');
        }
      } else if (coverageProof.kind !== 'coordinated_incremental_scan') {
        throw new Error('Shopify returned an unsupported coverage proof.');
      }
    } else if (declaredCoverage || checkpointBefore) {
      throw new Error('Shopify declared complete coverage but the source run did not perform a full-history reconciliation.');
    }
    async function fenceConnectorWrite(client) {
      await assertConnectorOwnership(
        client,
        tenantId,
        connectorId,
        ingestMode,
        checkpointBefore,
      );
      const run = await client.query(
        'SELECT status FROM commerce_connector_runs WHERE id = $1 FOR UPDATE',
        [runId],
      );
      if (run.rows[0]?.status !== 'running') {
        throw new Error('Commerce connector run is no longer active; refusing a stale write.');
      }
    }
    async function finalizeConnectorRun(client, importedRows) {
      await client.query(
        `INSERT INTO commerce_connector_checkpoints
           (tenant_id, connector_id, connector_version, data_mode, source_fact_state,
            checkpoint, source_sha256, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (tenant_id, connector_id) DO UPDATE SET
           connector_version = EXCLUDED.connector_version,
           data_mode = EXCLUDED.data_mode,
           source_fact_state = EXCLUDED.source_fact_state,
           checkpoint = EXCLUDED.checkpoint,
           source_sha256 = EXCLUDED.source_sha256,
           updated_at = NOW()`,
        [
          tenantId,
          connectorId,
          connectorVersion,
          ingestMode,
          isShopify ? 'ready' : 'not_applicable',
          checkpointAfter,
          sourceSha256,
        ],
      );
      if (coverageProof) {
        await publishCommerceCoverage(
          client,
          tenantId,
          connectorId,
          ingestMode,
          runId,
          coverageProof,
        );
      }
      await refreshCommerceCatalog(client, tenantId);
      await client.query(
        `UPDATE commerce_connector_runs SET status = 'completed', checkpoint_after = $1,
           source_sha256 = $2, imported_rows = $3, source_rows = $4, rejected_rows = $5,
           coverage_start = $6, coverage_end = $7, coverage_proof_kind = $8,
           completed_at = NOW() WHERE id = $9`,
        [
          checkpointAfter,
          sourceSha256,
          importedRows,
          source.sourceRows ?? importedRows,
          source.rejectedRows ?? 0,
          coverageProof?.kind === 'coordinated_incremental_scan'
            ? null
            : coverageProof?.coverageStart || null,
          coverageProof?.coverageEnd || null,
          coverageProof?.kind || null,
          runId,
        ],
      );
    }

    let importedRowCount;
    let sourceRowCount;
    if (isShopify) {
      // Shopify is order/refund-line incremental, not a full-window snapshot: writing straight
      // into commerce_daily_metrics with the generic upsertCommerceRows path would let a
      // partial window overwrite a bucket's full history with only the rows this run touched.
      // Instead each line is staged by a stable source_line_id, and only the specific buckets
      // this run's lines belong to are recomputed from the *complete* staged history.
      const factRows = source.factRows || [];
      const sourceEntities = source.sourceEntities || [];
      if (factRows.length > limits.maxRows) {
        throw new Error(`Connector exceeded maxRows=${limits.maxRows}.`);
      }
      if (sourceEntities.length > limits.maxRows) {
        throw new Error(`Connector exceeded maxRows=${limits.maxRows}.`);
      }
      const parsedFactRows = factRows.map((record, index) => parseCommerceSourceFactRow(
        record,
        connectorId,
        index + 1,
        tenantId,
      ));
      const parsedSourceEntities = sourceEntities.map((record, index) => (
        parseSourceEntityReconciliation(record, index + 1)
      ));
      await transaction(database, async (client) => {
        await fenceConnectorWrite(client);
        const bucketKeys = await reconcileSourceFacts(
          client,
          tenantId,
          connectorId,
          parsedFactRows,
          parsedSourceEntities,
        );
        await recomputeDailyMetricsFromSourceFacts(
          client,
          tenantId,
          connectorId,
          bucketKeys,
          SHOPIFY_AVAILABLE_METRICS,
        );
        await finalizeConnectorRun(client, parsedFactRows.length);
      });
      importedRowCount = parsedFactRows.length;
      sourceRowCount = source.sourceRows ?? factRows.length;
    } else {
      const rawRecords = source.records || parseRecords(source.body, config.format);
      if (rawRecords.length > limits.maxRows) {
        throw new Error(`Connector exceeded maxRows=${limits.maxRows}.`);
      }
      const rows = rawRecords.map((record, index) => parseCommerceRow(
        projectRecord(record, config.fieldMap, tenantId),
        index + 1,
        tenantId,
        connectorId,
      ));
      await transaction(database, async (client) => {
        await fenceConnectorWrite(client);
        await replaceCommerceSnapshot(client, tenantId, connectorId, rows);
        if (source.snapshotMetadata) {
          await persistCommerceSourceSnapshot(
            client,
            tenantId,
            connectorId,
            source.snapshotMetadata,
          );
          const businessEvents = (source.businessEvents || []).map((event, index) => (
            parseCommerceBusinessEvent(event, index + 1, tenantId, connectorId)
          ));
          await replaceCommerceBusinessEvents(
            client,
            tenantId,
            connectorId,
            businessEvents,
          );
        }
        await finalizeConnectorRun(client, rows.length);
      });
      importedRowCount = rows.length;
      sourceRowCount = source.sourceRows ?? rawRecords.length;
    }
    log(JSON.stringify({
      runId,
      connectorId,
      tenantId,
      status: 'completed',
      sourceRows: sourceRowCount,
      rejectedRows: source.rejectedRows ?? 0,
      importedRows: importedRowCount,
      sourceSha256,
      durationMs: Date.now() - startedAt,
    }));
  } catch (error) {
    await transaction(database, async (client) => {
      await selectIngestTenant(client, tenantId);
      await client.query(
        `UPDATE commerce_connector_runs SET status = 'failed', error_code = 'CONNECTOR_FAILED',
           error_message = $1, completed_at = NOW() WHERE id = $2`,
        [String(error instanceof Error ? error.message : error).slice(0, 1_000), runId],
      );
    }).catch(() => undefined);
    throw error;
  } finally {
    if (ownsDatabase) await database.end();
  }
}

if (require.main === module) {
  runCommerceConnector().catch((error) => {
    console.error('[commerce-connector] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  privateNetworkAddress,
  resolveConnectorMode,
  runCommerceConnector,
  validateHttpsSourceUrl,
};
