import { createRequire } from 'node:module';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  SHOPIFY_AVAILABLE_METRICS,
  loadShopifySource,
  normalizeShopifyOrders,
} = require('./shopify-source.js');

const limits = {
  maxRows: 1_000,
  maxBytes: 1_000_000,
  timeoutMs: 5_000,
};

function response(payload, init = {}) {
  return new Response(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    { status: 200, ...init },
  );
}

function source(overrides = {}) {
  return {
    type: 'shopify',
    apiVersion: '2026-07',
    initialUpdatedAt: '2026-07-01T00:00:00.000Z',
    businessTimeZone: 'Asia/Shanghai',
    pageSize: 2,
    maxPages: 10,
    maxRetries: 3,
    maxRetryDelayMs: 10_000,
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    id: 'gid://shopify/Order/1',
    createdAt: '2026-07-31T16:30:00.000Z',
    updatedAt: '2026-08-01T03:00:00.000Z',
    test: false,
    displayFinancialStatus: 'PAID',
    shippingAddress: { provinceCode: 'SH', countryCodeV2: 'CN' },
    channelInformation: { channelDefinition: { channelName: 'Online Store' } },
    customer: { numberOfOrders: 1 },
    lineItems: {
      pageInfo: { hasNextPage: false },
      nodes: [{
        quantity: 2,
        discountedTotalSet: { shopMoney: { amount: '120.50', currencyCode: 'CNY' } },
      }],
    },
    refunds: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv('SHOPIFY_SHOP_DOMAIN', 'commerce-demo.myshopify.com');
  vi.stubEnv('SHOPIFY_ADMIN_ACCESS_TOKEN', 'test-token-never-log');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Shopify Commerce source adapter', () => {
  it('paginates a fixed watermark and normalizes orders and refunds', async () => {
    const calls = [];
    const firstOrder = order({
      refunds: [{
        id: 'gid://shopify/Refund/1',
        createdAt: '2026-08-01T02:00:00.000Z',
        totalRefundedSet: { shopMoney: { amount: '20.25', currencyCode: 'CNY' } },
      }],
    });
    const testOrder = order({ id: 'gid://shopify/Order/2', test: true });
    const secondOrder = order({
      id: 'gid://shopify/Order/3',
      createdAt: '2026-08-01T06:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      shippingAddress: null,
      channelInformation: null,
      customer: { numberOfOrders: 4 },
      lineItems: {
        pageInfo: { hasNextPage: false },
        nodes: [{
          quantity: 1,
          discountedTotalSet: { shopMoney: { amount: '30.00', currencyCode: 'CNY' } },
        }],
      },
    });
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return calls.length === 1
        ? response({
          data: {
            orders: {
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
              nodes: [firstOrder, testOrder],
            },
          },
        })
        : response({
          data: {
            orders: {
              pageInfo: { hasNextPage: false, endCursor: 'cursor-2' },
              nodes: [secondOrder],
            },
          },
        });
    });

    const result = await loadShopifySource(
      source(),
      null,
      limits,
      { fetchImpl, now: () => new Date('2026-08-01T12:00:00.000Z') },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(
      'https://commerce-demo.myshopify.com/admin/api/2026-07/graphql.json',
    );
    expect(calls[0].body.variables).toEqual({
      first: 2,
      after: null,
      query: "updated_at:>='2026-07-01T00:00:00.000Z' updated_at:<='2026-08-01T12:00:00.000Z'",
    });
    expect(calls[1].body.variables.after).toBe('cursor-1');
    expect(calls[0].init.headers['X-Shopify-Access-Token']).toBe('test-token-never-log');
    expect(result).toMatchObject({
      checkpointAfter: '2026-08-01T12:00:00.000Z',
      transport: 'shopify',
      sourceRows: 3,
    });
    expect(result.records).toEqual([
      expect.objectContaining({
        metric_date: '2026-08-01',
        region: 'SH',
        channel: 'Online Store',
        sku: 'SHOPIFY-ORDER',
        paid_orders: 1,
        units: 2,
        gmv: 120.5,
        refund_orders: 0,
        refund_amount: 20.25,
        new_customers: 0,
        data_mode: 'incremental',
        available_metrics: SHOPIFY_AVAILABLE_METRICS,
      }),
      expect.objectContaining({
        metric_date: '2026-08-01',
        region: 'Unknown',
        channel: 'Shopify',
        paid_orders: 1,
        units: 1,
        gmv: 30,
        new_customers: 0,
      }),
    ]);
  });

  it('resumes from the stored checkpoint', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(JSON.parse(init.body).variables.query).toContain(
        "updated_at:>='2026-07-28T02:03:04.000Z'",
      );
      return response({
        data: {
          orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      });
    });

    await expect(loadShopifySource(
      source(),
      '2026-07-28T02:03:04Z',
      limits,
      { fetchImpl, now: () => new Date('2026-08-01T12:00:00.000Z') },
    )).resolves.toMatchObject({ records: [], checkpointAfter: '2026-08-01T12:00:00.000Z' });
  });

  it('honors Retry-After and retries GraphQL throttling without leaking credentials', async () => {
    const sleepImpl = vi.fn(async () => undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '2' },
      }))
      .mockResolvedValueOnce(response({
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
      }))
      .mockResolvedValueOnce(response({
        data: {
          orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      }));

    await expect(loadShopifySource(
      source(),
      null,
      limits,
      {
        fetchImpl,
        sleepImpl,
        now: () => new Date('2026-08-01T12:00:00.000Z'),
      },
    )).resolves.toMatchObject({ records: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl.mock.calls).toEqual([[2_000], [1_000]]);
  });

  it('fails closed when Shopify requires nested line-item pagination', () => {
    expect(() => normalizeShopifyOrders([
      order({ lineItems: { pageInfo: { hasNextPage: true }, nodes: [] } }),
    ], {
      businessTimeZone: 'Asia/Shanghai',
      defaultRegion: 'Unknown',
      defaultChannel: 'Shopify',
      orderSku: 'SHOPIFY-ORDER',
      orderCategory: 'All Products',
    })).toThrow(/Bulk Operations/u);
  });
});
