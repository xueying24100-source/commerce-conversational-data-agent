import { Pool } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

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

export class CommerceControlSystemContextError extends Error {
  readonly code = 'COMMERCE_CONTROL_SYSTEM_CONTEXT_FORBIDDEN';

  constructor() {
    super('System control context requires the dedicated Commerce Worker database role.');
    this.name = 'CommerceControlSystemContextError';
  }
}

type CommerceControlContext =
  | { mode: 'identity'; tenantId: string; userId: string }
  | { mode: 'feedback_reviewer'; tenantId: string; userId: string }
  | { mode: 'system' };

const controlContext = new AsyncLocalStorage<CommerceControlContext>();

export function withCommerceControlIdentity<T>(
  identity: { tenantId: string; userId: string },
  work: () => Promise<T>,
): Promise<T> {
  return controlContext.run({
    mode: 'identity',
    tenantId: identity.tenantId,
    userId: identity.userId,
  }, work);
}

export function withCommerceControlSystem<T>(work: () => Promise<T>): Promise<T> {
  return controlContext.run({ mode: 'system' }, work);
}

export function withCommerceControlFeedbackReviewer<T>(
  identity: { tenantId: string; userId: string },
  work: () => Promise<T>,
): Promise<T> {
  return controlContext.run({
    mode: 'feedback_reviewer',
    tenantId: identity.tenantId,
    userId: identity.userId,
  }, work);
}

class PgCommerceDatabase implements CommerceDatabase {
  constructor(
    private readonly pool: Pool,
    private readonly controlPlane: boolean,
    private readonly allowSystemContext: boolean,
  ) {}

  private assertControlContext(): void {
    if (
      this.controlPlane
      && controlContext.getStore()?.mode === 'system'
      && !this.allowSystemContext
    ) {
      throw new CommerceControlSystemContextError();
    }
  }

  private async setControlContext(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }) {
    if (!this.controlPlane) return;
    const context = controlContext.getStore();
    this.assertControlContext();
    await client.query(
      `SELECT set_config('commerce.tenant_id', $1, true),
              set_config('commerce.user_id', $2, true),
              set_config('commerce.control_system', $3, true),
              set_config('commerce.feedback_reviewer', $4, true)`,
      context?.mode === 'identity' || context?.mode === 'feedback_reviewer'
        ? [
            context.tenantId,
            context.userId,
            'off',
            context.mode === 'feedback_reviewer' ? 'on' : 'off',
          ]
        : ['', '', context?.mode === 'system' ? 'on' : 'off', 'off'],
    );
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    this.assertControlContext();
    if (!this.controlPlane || !controlContext.getStore()) {
      const result = await this.pool.query(text, [...values]);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? result.rows.length };
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setControlContext(client);
      const result = await client.query(text, [...values]);
      await client.query('COMMIT');
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? result.rows.length };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
    this.assertControlContext();
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
      await this.setControlContext(client);
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

type PoolSlot = 'commerceControlApiPool' | 'commerceControlWorkerPool' | 'commerceAnalyticsPool';
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
  controlPlane: boolean,
  allowSystemContext: boolean,
) {
  if (!connectionString) {
    throw new Error(`${envName} is required.`);
  }
  const pools = globalThis as GlobalPools;
  const pool = pools[slot] ?? createPool(connectionString, readOnly);
  pools[slot] = pool;
  return new PgCommerceDatabase(pool, controlPlane, allowSystemContext);
}

export function getCommerceControlDatabase(): CommerceDatabase {
  const config = getCommerceAgentRuntimeConfig();
  const worker = config.controlRuntimeRole === 'worker';
  return databaseFor(
    worker ? 'commerceControlWorkerPool' : 'commerceControlApiPool',
    config.databaseUrl,
    worker ? 'COMMERCE_CONTROL_WORKER_DATABASE_URL' : 'COMMERCE_CONTROL_API_DATABASE_URL',
    false,
    true,
    worker,
  );
}

export function getCommerceAnalyticsDatabase(): CommerceDatabase {
  const config = getCommerceAgentRuntimeConfig();
  return databaseFor(
    'commerceAnalyticsPool',
    config.analyticsDatabaseUrl,
    'COMMERCE_ANALYTICS_DATABASE_URL',
    true,
    false,
    false,
  );
}

export async function closeCommerceDatabases(): Promise<void> {
  const pools = globalThis as GlobalPools;
  const active = Array.from(new Set([
    pools.commerceControlApiPool,
    pools.commerceControlWorkerPool,
    pools.commerceAnalyticsPool,
  ].filter((pool): pool is Pool => Boolean(pool))));
  delete pools.commerceControlApiPool;
  delete pools.commerceControlWorkerPool;
  delete pools.commerceAnalyticsPool;
  await Promise.all(active.map((pool) => pool.end()));
}
