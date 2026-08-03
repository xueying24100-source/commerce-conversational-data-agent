#!/usr/bin/env node

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { loadLocalEnv } = require('../db/load-local-env');
const {
  COLUMNS,
  parseCommerceRow,
  refreshCommerceCatalog,
  selectIngestTenant,
  upsertCommerceRows,
} = require('../db/commerce-ingest-core');
const { loadShopifySource } = require('./shopify-source');
const { loadOlistPublicSource } = require('./olist-public-source');

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

async function loadSource(config, configDirectory, checkpoint, limits, runContext = {}) {
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
    return { body, checkpointAfter: null, transport: 'file' };
  }
  const url = new URL(requiredString(config.source.url, 'source.url'));
  if (url.protocol !== 'https:') throw new Error('HTTP connector URLs must use HTTPS.');
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
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(limits.timeoutMs),
  });
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
  if (!config.source || !['file', 'https', 'shopify', 'olist'].includes(config.source.type)) {
    throw new Error('source.type must be file, https, shopify, or olist.');
  }
  if (!['shopify', 'olist'].includes(config.source.type) && !['jsonl', 'json'].includes(config.format)) {
    throw new Error('format must be jsonl or json for file and https sources.');
  }
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
      { checkpointVersion, connectorVersion },
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
    const rawRecords = source.records || parseRecords(source.body, config.format);
    if (rawRecords.length > limits.maxRows) {
      throw new Error(`Connector exceeded maxRows=${limits.maxRows}.`);
    }
    const rows = rawRecords.map((record, index) => parseCommerceRow(
      projectRecord(record, config.source.type === 'shopify' ? {} : config.fieldMap, tenantId),
      index + 1,
      tenantId,
    ));
    const checkpointAfter = source.checkpointAfter || sourceSha256;
    await transaction(database, async (client) => {
      await upsertCommerceRows(client, rows);
      await refreshCommerceCatalog(client, tenantId);
      await client.query(
        `INSERT INTO commerce_connector_checkpoints
           (tenant_id, connector_id, connector_version, checkpoint, source_sha256, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (tenant_id, connector_id) DO UPDATE SET
           connector_version = EXCLUDED.connector_version,
           checkpoint = EXCLUDED.checkpoint,
           source_sha256 = EXCLUDED.source_sha256,
           updated_at = NOW()`,
        [tenantId, connectorId, connectorVersion, checkpointAfter, sourceSha256],
      );
      await client.query(
        `UPDATE commerce_connector_runs SET status = 'completed', checkpoint_after = $1,
           source_sha256 = $2, imported_rows = $3, source_rows = $4, rejected_rows = $5,
           completed_at = NOW() WHERE id = $6`,
        [
          checkpointAfter,
          sourceSha256,
          rows.length,
          source.sourceRows ?? rawRecords.length,
          source.rejectedRows ?? 0,
          runId,
        ],
      );
    });
    log(JSON.stringify({
      runId,
      connectorId,
      tenantId,
      status: 'completed',
      sourceRows: source.sourceRows ?? rawRecords.length,
      rejectedRows: source.rejectedRows ?? 0,
      importedRows: rows.length,
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

module.exports = { runCommerceConnector };
