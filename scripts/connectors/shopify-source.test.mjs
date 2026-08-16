import { createRequire } from 'node:module';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
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
  it('paginates a fixed watermark and normalizes orders and refunds into per-line facts', async () => {
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
    // Each order/refund is its own staged line, not pre-merged into a daily bucket: bucket
    // aggregation happens downstream from the full staged history, not from this window alone.
    expect(result.factRows).toEqual([
      expect.objectContaining({
        source_line_id: 'order:gid://shopify/Order/1',
        metric_date: '2026-08-01',
        region: 'SH',
        channel: 'Online Store',
        sku: 'SHOPIFY-ORDER',
        currency_code: 'CNY',
        paid_orders: 1,
        units: 2,
        gmv: 120.5,
        refund_amount: 0,
      }),
      expect.objectContaining({
        source_line_id: 'refund:gid://shopify/Order/1:gid://shopify/Refund/1',
        metric_date: '2026-08-01',
        region: 'SH',
        channel: 'Online Store',
        currency_code: 'CNY',
        paid_orders: 0,
        units: 0,
        gmv: 0,
        refund_amount: 20.25,
      }),
      expect.objectContaining({
        source_line_id: 'order:gid://shopify/Order/3',
        metric_date: '2026-08-01',
        region: 'Unknown',
        channel: 'Shopify',
        currency_code: 'CNY',
        paid_orders: 1,
        units: 1,
        gmv: 30,
        refund_amount: 0,
      }),
    ]);
    expect(result.sourceEntities).toEqual([
      {
        source_entity_id: 'gid://shopify/Order/1',
        source_line_ids: [
          'order:gid://shopify/Order/1',
          'refund:gid://shopify/Order/1:gid://shopify/Refund/1',
        ],
      },
      {
        source_entity_id: 'gid://shopify/Order/2',
        source_line_ids: [],
      },
      {
        source_entity_id: 'gid://shopify/Order/3',
        source_line_ids: ['order:gid://shopify/Order/3'],
      },
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
    )).resolves.toMatchObject({ factRows: [], checkpointAfter: '2026-08-01T12:00:00.000Z' });
  });

  it('does not claim coverage on an ordinary first sync without reconciliation', async () => {
    const fetchImpl = vi.fn(async () => response({
      data: {
        orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
    }));

    const result = await loadShopifySource(
      source(),
      null,
      limits,
      { fetchImpl, now: () => new Date('2026-08-01T12:00:00.000Z') },
    );

    expect(result).not.toHaveProperty('coverageProof');
  });

  it('emits full-history proof only for an empty-checkpoint reconciliation bootstrap', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(JSON.parse(init.body).variables.query).toBe(
        "updated_at:>='2026-06-30T16:00:00.000Z' updated_at:<='2026-08-01T16:30:00.000Z'",
      );
      return response({
        data: {
          orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      });
    });

    const result = await loadShopifySource(
      source({
        fullHistoryReconciliation: true,
        // Asia/Shanghai local midnight at the beginning of the promised first day.
        initialUpdatedAt: '2026-06-30T16:00:00.000Z',
      }),
      null,
      limits,
      { fetchImpl, now: () => new Date('2026-08-01T16:30:00.000Z') },
    );

    expect(result.coverageProof).toEqual({
      kind: 'full_history_reconciliation',
      coverageStart: '2026-07-01',
      // Asia/Shanghai is already 2026-08-02 at the watermark, so 2026-08-01 is complete.
      coverageEnd: '2026-08-01',
      sourceUpdatedAt: '2026-08-01T16:30:00.000Z',
    });
  });

  it('rejects a full-history start that is not midnight in the business time zone before fetch', async () => {
    const fetchImpl = vi.fn();

    await expect(loadShopifySource(
      source({
        fullHistoryReconciliation: true,
        // 2026-07-01T00:00Z is 08:00 in Asia/Shanghai, not the start of a business day.
        initialUpdatedAt: '2026-07-01T00:00:00.000Z',
      }),
      null,
      limits,
      { fetchImpl, now: () => new Date('2026-08-01T16:30:00.000Z') },
    )).rejects.toThrow(/exactly midnight in source\.businessTimeZone/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses calendar dates across DST when deriving the previous complete business day', async () => {
    const fetchImpl = vi.fn(async () => response({
      data: {
        orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
    }));

    const result = await loadShopifySource(
      source({
        businessTimeZone: 'America/New_York',
        fullHistoryReconciliation: true,
        // Local midnight on 2026-03-01 before the daylight-saving transition.
        initialUpdatedAt: '2026-03-01T05:00:00.000Z',
      }),
      null,
      limits,
      // 00:30 on March 9 after the UTC offset changed from -05:00 to -04:00.
      { fetchImpl, now: () => new Date('2026-03-09T04:30:00.000Z') },
    );

    expect(result.coverageProof).toEqual({
      kind: 'full_history_reconciliation',
      coverageStart: '2026-03-01',
      coverageEnd: '2026-03-08',
      sourceUpdatedAt: '2026-03-09T04:30:00.000Z',
    });
  });

  it('fails closed when full-history reconciliation is attempted after a checkpoint exists', async () => {
    const fetchImpl = vi.fn();

    await expect(loadShopifySource(
      source({
        fullHistoryReconciliation: true,
        initialUpdatedAt: '2026-06-30T16:00:00.000Z',
      }),
      '2026-07-28T02:03:04.000Z',
      limits,
      { fetchImpl, now: () => new Date('2026-08-01T12:00:00.000Z') },
    )).rejects.toThrow(/one-time empty-checkpoint bootstrap/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires read_all_orders before claiming history older than Shopify default window', async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(url).toContain('/access_scopes.json');
      return response({ access_scopes: [{ handle: 'read_orders' }] });
    });

    await expect(loadShopifySource(
      source({
        fullHistoryReconciliation: true,
        initialUpdatedAt: '2025-12-31T16:00:00.000Z',
      }),
      null,
      limits,
      { fetchImpl, now: () => new Date('2026-08-01T16:30:00.000Z') },
    )).rejects.toThrow(/read_all_orders/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('continues only after the historical order scope is explicitly verified', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('/access_scopes.json')) {
        return response({ access_scopes: [{ handle: 'read_orders' }, { handle: 'read_all_orders' }] });
      }
      return response({
        data: {
          orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      });
    });

    const result = await loadShopifySource(
      source({
        fullHistoryReconciliation: true,
        initialUpdatedAt: '2025-12-31T16:00:00.000Z',
      }),
      null,
      limits,
      { fetchImpl, now: () => new Date('2026-08-01T16:30:00.000Z') },
    );

    expect(result.coverageProof?.kind).toBe('full_history_reconciliation');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('emits a coordinated incremental scan proof on an ordinary checkpointed sync', async () => {
    const fetchImpl = vi.fn(async () => response({
      data: {
        orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
    }));

    const result = await loadShopifySource(
      source(),
      '2026-07-28T02:03:04.000Z',
      limits,
      { fetchImpl, now: () => new Date('2026-08-01T16:30:00.000Z') },
    );

    expect(result.coverageProof).toEqual({
      kind: 'coordinated_incremental_scan',
      coverageEnd: '2026-08-01',
      sourceUpdatedAt: '2026-08-01T16:30:00.000Z',
    });
  });

  it('fails closed when Shopify says another page exists without an end cursor', async () => {
    const fetchImpl = vi.fn(async () => response({
      data: {
        orders: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] },
      },
    }));

    await expect(loadShopifySource(
      source({
        fullHistoryReconciliation: true,
        initialUpdatedAt: '2026-06-30T16:00:00.000Z',
      }),
      null,
      limits,
      { fetchImpl, now: () => new Date('2026-08-01T12:00:00.000Z') },
    )).rejects.toThrow(/pagination did not provide endCursor/u);
  });

  it('fails closed when complete pagination would exceed maxPages', async () => {
    const fetchImpl = vi.fn(async () => response({
      data: {
        orders: { pageInfo: { hasNextPage: true, endCursor: 'cursor-1' }, nodes: [] },
      },
    }));

    await expect(loadShopifySource(
      source({
        fullHistoryReconciliation: true,
        initialUpdatedAt: '2026-06-30T16:00:00.000Z',
        maxPages: 1,
      }),
      null,
      limits,
      { fetchImpl, now: () => new Date('2026-08-01T12:00:00.000Z') },
    )).rejects.toThrow(/exceeded source\.maxPages/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    )).resolves.toMatchObject({ factRows: [] });
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

  it('carries the detected shop currency onto every normalized fact row', () => {
    const { factRows } = normalizeShopifyOrders([order()], {
      businessTimeZone: 'Asia/Shanghai',
      defaultRegion: 'Unknown',
      defaultChannel: 'Shopify',
      orderSku: 'SHOPIFY-ORDER',
      orderCategory: 'All Products',
    });
    expect(factRows).toHaveLength(1);
    expect(factRows[0].currency_code).toBe('CNY');
  });

  it('fails closed instead of silently mixing currencies from one connector run', () => {
    const config = {
      businessTimeZone: 'Asia/Shanghai',
      defaultRegion: 'Unknown',
      defaultChannel: 'Shopify',
      orderSku: 'SHOPIFY-ORDER',
      orderCategory: 'All Products',
    };
    const usdOrder = order({
      id: 'gid://shopify/Order/9',
      lineItems: {
        pageInfo: { hasNextPage: false },
        nodes: [{
          quantity: 1,
          discountedTotalSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } },
        }],
      },
    });
    expect(() => normalizeShopifyOrders([order(), usdOrder], config))
      .toThrow(/multiple currencies.*CNY.*USD|multiple currencies.*USD.*CNY/u);
  });

  it('keeps each order and refund as an independently upsertable line', () => {
    const config = {
      businessTimeZone: 'Asia/Shanghai',
      defaultRegion: 'Unknown',
      defaultChannel: 'Shopify',
      orderSku: 'SHOPIFY-ORDER',
      orderCategory: 'All Products',
    };
    const orderWithRefund = order({
      refunds: [{
        id: 'gid://shopify/Refund/1',
        createdAt: '2026-08-01T02:00:00.000Z',
        totalRefundedSet: { shopMoney: { amount: '20.25', currencyCode: 'CNY' } },
      }],
    });
    const { factRows, sourceEntities } = normalizeShopifyOrders([orderWithRefund], config);
    const sourceLineIds = factRows.map((row) => row.source_line_id);
    expect(sourceLineIds).toEqual([
      'order:gid://shopify/Order/1',
      'refund:gid://shopify/Order/1:gid://shopify/Refund/1',
    ]);
    expect(new Set(sourceLineIds).size).toBe(sourceLineIds.length);
    expect(factRows.every((row) => row.source_entity_id === 'gid://shopify/Order/1')).toBe(true);
    expect(sourceEntities).toEqual([{
      source_entity_id: 'gid://shopify/Order/1',
      source_line_ids: sourceLineIds,
    }]);
  });

  it('emits an empty entity reconciliation when a previously paid order is now void', () => {
    const config = {
      businessTimeZone: 'Asia/Shanghai',
      defaultRegion: 'Unknown',
      defaultChannel: 'Shopify',
      orderSku: 'SHOPIFY-ORDER',
      orderCategory: 'All Products',
    };
    const { factRows, sourceEntities } = normalizeShopifyOrders([order({
      displayFinancialStatus: 'VOIDED',
      refunds: [],
    })], config);
    expect(factRows).toEqual([]);
    expect(sourceEntities).toEqual([{
      source_entity_id: 'gid://shopify/Order/1',
      source_line_ids: [],
    }]);
  });
});
