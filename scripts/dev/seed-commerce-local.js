#!/usr/bin/env node

const path = require('node:path');
const { Pool } = require('pg');

const {
  parseCommerceRow,
  refreshCommerceCatalog,
  upsertCommerceRows,
} = require('../db/commerce-ingest-core');
const { loadLocalEnv } = require('../db/load-local-env');

const root = path.join(__dirname, '..', '..');
loadLocalEnv(root);
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}

const PROFILES = [
  {
    region: 'East', channel: 'Search', sku: 'SKU-CORE', category: 'Apparel',
    visits: 520, conversion: 0.086, unitRate: 1.12, price: 89,
    refundRate: 0.025, costRate: 0.44, adRate: 0.15, newRate: 0.58,
  },
  {
    region: 'East', channel: 'Marketplace', sku: 'SKU-HOME', category: 'Home',
    visits: 390, conversion: 0.074, unitRate: 1.08, price: 129,
    refundRate: 0.04, costRate: 0.51, adRate: 0.11, newRate: 0.42,
  },
  {
    region: 'West', channel: 'Affiliate', sku: 'SKU-RISK', category: 'Electronics',
    visits: 260, conversion: 0.062, unitRate: 1.03, price: 219,
    refundRate: 0.065, costRate: 0.57, adRate: 0.09, newRate: 0.31,
  },
  {
    region: 'North', channel: 'Direct', sku: 'SKU-BEAUTY', category: 'Beauty',
    visits: 310, conversion: 0.098, unitRate: 1.18, price: 69,
    refundRate: 0.018, costRate: 0.39, adRate: 0.06, newRate: 0.47,
  },
];

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function buildRows(tenantId, now = new Date()) {
  const sourceUpdatedAt = now.toISOString();
  const today = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  const rows = [];
  for (let daysAgo = 119; daysAgo >= 0; daysAgo -= 1) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - daysAgo);
    const weekdayFactor = [0.82, 0.96, 1.03, 1.06, 1.09, 1.14, 0.9][date.getUTCDay()];
    const pulse = 1 + (((date.getUTCDate() * 7) % 11) - 5) / 100;
    for (const profile of PROFILES) {
      let recentFactor = 1;
      let conversion = profile.conversion;
      if (daysAgo < 30 && profile.channel === 'Search') {
        recentFactor = 1.16;
        conversion += 0.008;
      }
      if (daysAgo < 30 && profile.channel === 'Marketplace') recentFactor = 0.91;
      if (daysAgo < 14 && profile.sku === 'SKU-RISK') recentFactor = 0.78;

      const visits = Math.round(profile.visits * weekdayFactor * pulse * recentFactor);
      const paidOrders = Math.max(1, Math.round(visits * conversion));
      const units = Math.max(paidOrders, Math.round(paidOrders * profile.unitRate));
      const gmv = roundMoney(units * profile.price);
      const refundOrders = Math.round(paidOrders * profile.refundRate);
      const stockoutHours = profile.sku === 'SKU-RISK' && daysAgo < 21
        ? 4 + ((21 - daysAgo) % 8)
        : (date.getUTCDate() + profile.sku.length) % 3 === 0 ? 1 : 0;
      const endingInventory = profile.sku === 'SKU-RISK'
        ? Math.max(0, 2 + Math.floor(daysAgo / 4))
        : 48 + ((date.getUTCDate() * 3 + profile.sku.length) % 35);

      rows.push(parseCommerceRow({
        tenant_id: tenantId,
        metric_date: isoDate(date),
        region: profile.region,
        channel: profile.channel,
        sku: profile.sku,
        category: profile.category,
        visits,
        paid_orders: paidOrders,
        units,
        gmv,
        refund_orders: refundOrders,
        refund_amount: roundMoney(refundOrders * profile.price),
        cost_amount: roundMoney(gmv * profile.costRate),
        ad_spend: roundMoney(gmv * profile.adRate),
        new_customers: Math.round(paidOrders * profile.newRate),
        stockout_hours: stockoutHours,
        ending_inventory: endingInventory,
        source_updated_at: sourceUpdatedAt,
      }, rows.length + 1));
    }
  }
  return rows;
}

function localConnectionString() {
  return process.env.COMMERCE_ANALYTICS_INGEST_DATABASE_URL?.trim()
    || process.env.COMMERCE_ANALYTICS_MIGRATION_DATABASE_URL?.trim()
    || process.env.COMMERCE_DATABASE_URL?.trim()
    || process.env.COMMERCE_TEST_DATABASE_URL?.trim()
    || process.env.COMMERCE_LIVE_E2E_DATABASE_URL?.trim()
    || '';
}

function assertLocalDatabase(connectionString) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Local Commerce seed is disabled in production.');
  }
  const parsed = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Local Commerce seed requires a PostgreSQL URL.');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Local Commerce seed only accepts a loopback PostgreSQL host.');
  }
}

async function main() {
  const connectionString = localConnectionString();
  if (!connectionString) throw new Error('A local Commerce PostgreSQL URL is required.');
  assertLocalDatabase(connectionString);
  const tenantId = process.env.COMMERCE_DEV_TENANT_ID?.trim() || 'tenant_local';
  const rows = buildRows(tenantId);
  const database = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000,
    application_name: 'commerce-local-seed',
  });
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await upsertCommerceRows(client, rows);
    await refreshCommerceCatalog(client, tenantId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await database.end();
  }
  console.log(JSON.stringify({ tenantId, importedRows: rows.length, synthetic: true }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Commerce local seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = { assertLocalDatabase, buildRows };
