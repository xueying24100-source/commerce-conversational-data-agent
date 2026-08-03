import { Pool } from 'pg';

import { getCommerceAgentRuntimeConfig } from './config';

export interface CommerceQueryResult<Row extends Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export interface CommerceSqlClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<CommerceQueryResult<Row>>;
}

export interface CommerceDatabase extends CommerceSqlClient {
  transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
}

class PgCommerceDatabase implements CommerceDatabase {
  constructor(private readonly pool: Pool) {}

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    const result = await this.pool.query(text, [...values]);
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  async transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const adapter: CommerceSqlClient = {
      query: async <Row extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ) => {
        const result = await client.query(text, [...values]);
        return {
          rows: result.rows as Row[],
          rowCount: result.rowCount ?? result.rows.length,
        };
      },
    };
    try {
      await client.query('BEGIN');
      const result = await work(adapter);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}

type PoolSlot = 'commerceControlPool' | 'commerceAnalyticsPool';
type GlobalPools = typeof globalThis & Partial<Record<PoolSlot, Pool>>;

function createPool(connectionString: string, readOnly: boolean): Pool {
  const config = getCommerceAgentRuntimeConfig();
  const analyticsOptions = [
    '-c default_transaction_read_only=on',
    `-c idle_in_transaction_session_timeout=${config.timeoutMs + 30_000}`,
  ].join(' ');
  return new Pool({
    connectionString,
    max: config.pgPoolMax,
    min: 0,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
    statement_timeout: 20_000,
    application_name: 'commerce-data-agent',
    ...(readOnly ? { options: analyticsOptions } : {}),
    ...(config.pgSsl
      ? {
          ssl: {
            rejectUnauthorized: config.pgRejectUnauthorized,
            ...(config.pgCa ? { ca: config.pgCa } : {}),
          },
        }
      : {}),
  });
}

function databaseFor(
  slot: PoolSlot,
  connectionString: string | null,
  envName: string,
  readOnly: boolean,
) {
  if (!connectionString) {
    throw new Error(`${envName} is required.`);
  }
  const pools = globalThis as GlobalPools;
  const pool = pools[slot] ?? createPool(connectionString, readOnly);
  pools[slot] = pool;
  return new PgCommerceDatabase(pool);
}

export function getCommerceControlDatabase(): CommerceDatabase {
  const config = getCommerceAgentRuntimeConfig();
  return databaseFor('commerceControlPool', config.databaseUrl, 'COMMERCE_DATABASE_URL', false);
}

export function getCommerceAnalyticsDatabase(): CommerceDatabase {
  const config = getCommerceAgentRuntimeConfig();
  return databaseFor(
    'commerceAnalyticsPool',
    config.analyticsDatabaseUrl,
    'COMMERCE_ANALYTICS_DATABASE_URL',
    true,
  );
}
