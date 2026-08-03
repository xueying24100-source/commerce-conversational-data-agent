#!/usr/bin/env node

const path = require('node:path');
const { Pool } = require('pg');

const { loadLocalEnv } = require('../db/load-local-env');

const root = path.join(__dirname, '..', '..');
loadLocalEnv(root);

async function main() {
  const tenantId = process.argv[2] || 'tenant_olist_demo';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(tenantId)) {
    throw new Error('tenant_id is invalid.');
  }
  const connectionString = process.env.COMMERCE_ANALYTICS_DATABASE_URL
    || process.env.COMMERCE_DATABASE_URL;
  if (!connectionString) throw new Error('COMMERCE_ANALYTICS_DATABASE_URL is required.');
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    application_name: 'commerce-olist-demo-check',
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SELECT set_config('commerce.tenant_id', $1, true)`, [tenantId]);
    const result = await client.query(
      `SELECT
         status.coverage_start::text,
         status.coverage_end::text,
         status.business_timezone,
         status.fact_row_count::text,
         status.available_metrics,
         (SELECT SUM(gmv)::text FROM commerce_daily_metrics
          WHERE tenant_id = status.tenant_id) AS gmv,
         (SELECT SUM(paid_orders)::text FROM commerce_daily_metrics
          WHERE tenant_id = status.tenant_id) AS paid_orders,
         (SELECT SUM(units)::text FROM commerce_daily_metrics
          WHERE tenant_id = status.tenant_id) AS units,
         (SELECT SUM(new_customers)::text FROM commerce_daily_metrics
          WHERE tenant_id = status.tenant_id) AS new_customers,
         (SELECT json_agg(run)
          FROM (
            SELECT status, transport, source_rows, rejected_rows, imported_rows,
                   checkpoint_after
            FROM commerce_connector_runs
            WHERE tenant_id = status.tenant_id
            ORDER BY started_at DESC
            LIMIT 3
          ) AS run) AS recent_runs
       FROM commerce_tenant_data_status AS status
       WHERE status.tenant_id = $1`,
      [tenantId],
    );
    if (!result.rows[0]) throw new Error(`No Commerce catalog exists for ${tenantId}.`);
    console.log(JSON.stringify({ tenantId, ...result.rows[0] }));
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[olist-demo-check] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
