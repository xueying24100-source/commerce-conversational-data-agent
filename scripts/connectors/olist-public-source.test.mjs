import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  OLIST_AVAILABLE_METRICS,
  loadOlistPublicSource,
} = require('./olist-public-source.js');

const revision = 'a'.repeat(40);
const customers = [
  'customer_id,customer_unique_id,customer_zip_code_prefix,customer_city,customer_state',
  'c1,u1,10000,"sao, paulo",SP',
  'c2,u1,20000,rio de janeiro,RJ',
  'c3,u2,30000,belo horizonte,MG',
].join('\n');
const items = [
  'order_id,order_item_id,product_id,seller_id,shipping_limit_date,price,freight_value',
  'o1,1,p1,s1,2017-01-02 00:00:00,10.00,1.00',
  'o1,2,p2,s1,2017-01-02 00:00:00,5.50,1.00',
  'o2,1,p3,s2,2017-01-03 00:00:00,20.00,2.00',
  'o3,1,p4,s2,2017-01-03 00:00:00,99.00,3.00',
  'o4,1,p5,s3,2017-01-03 00:00:00,7.25,1.00',
].join('\n');
const orders = [
  'order_id,customer_id,order_status,order_purchase_timestamp,order_approved_at,order_delivered_carrier_date,order_delivered_customer_date,order_estimated_delivery_date',
  'o1,c1,delivered,2017-01-01 10:00:00,2017-01-01 11:00:00,2017-01-02 00:00:00,2017-01-03 00:00:00,2017-01-04 00:00:00',
  'o2,c2,shipped,2017-01-02 10:00:00,2017-01-02 11:00:00,2017-01-03 00:00:00,,2017-01-05 00:00:00',
  'o3,c3,canceled,2017-01-02 11:00:00,,,,2017-01-05 00:00:00',
  'o4,c3,delivered,2017-01-02 12:00:00,2017-01-02 13:00:00,2017-01-03 00:00:00,2017-01-04 00:00:00,2017-01-05 00:00:00',
  'o5,c3,shipped,2017-01-03 12:00:00,2017-01-03 13:00:00,2017-01-04 00:00:00,,2017-01-06 00:00:00',
].join('\n');

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function file(name, text, headers) {
  return {
    path: `${name}.csv`,
    url: `https://example.test/${name}.csv`,
    sha256: sha256(text),
    headers,
  };
}

const manifest = {
  revision,
  files: {
    customers: file('customers', customers, [
      'customer_id',
      'customer_unique_id',
      'customer_zip_code_prefix',
      'customer_city',
      'customer_state',
    ]),
    items: file('items', items, [
      'order_id',
      'order_item_id',
      'product_id',
      'seller_id',
      'shipping_limit_date',
      'price',
      'freight_value',
    ]),
    orders: file('orders', orders, [
      'order_id',
      'customer_id',
      'order_status',
      'order_purchase_timestamp',
      'order_approved_at',
      'order_delivered_carrier_date',
      'order_delivered_customer_date',
      'order_estimated_delivery_date',
    ]),
  },
};

const bodies = new Map([
  [manifest.files.customers.url, customers],
  [manifest.files.items.url, items],
  [manifest.files.orders.url, orders],
]);
const config = {
  type: 'olist',
  datasetRevision: revision,
  businessTimeZone: 'America/Sao_Paulo',
  snapshotUpdatedAt: '2018-10-17T20:30:18.000Z',
  maxRetries: 2,
};
const limits = { maxRows: 100, maxBytes: 1_000_000, timeoutMs: 5_000 };

function successfulFetch() {
  return vi.fn(async (url) => new Response(bodies.get(url), { status: 200 }));
}

describe('Olist public Commerce source adapter', () => {
  it('verifies, joins and aggregates the pinned relational CSV snapshot', async () => {
    const fetchImpl = successfulFetch();
    const result = await loadOlistPublicSource(config, null, limits, {
      manifest,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      checkpointAfter: `olist:${revision}`,
      transport: 'olist',
      sourceRows: 5,
      rejectedRows: 1,
    });
    expect(result.sourceSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.records).toEqual([
      expect.objectContaining({
        metric_date: '2017-01-01',
        region: 'SP',
        business_timezone: 'America/Sao_Paulo',
        gmv: 15.5,
        units: 2,
        paid_orders: 1,
        new_customers: 1,
        data_mode: 'snapshot',
        available_metrics: OLIST_AVAILABLE_METRICS,
      }),
      expect.objectContaining({
        metric_date: '2017-01-02',
        region: 'MG',
        gmv: 7.25,
        units: 1,
        paid_orders: 1,
        new_customers: 1,
      }),
      expect.objectContaining({
        metric_date: '2017-01-02',
        region: 'RJ',
        gmv: 20,
        units: 1,
        paid_orders: 1,
        new_customers: 0,
      }),
    ]);
  });

  it('skips all downloads when the immutable revision checkpoint is unchanged', async () => {
    const fetchImpl = successfulFetch();
    await expect(loadOlistPublicSource(config, `olist:${revision}`, limits, {
      manifest,
      fetchImpl,
      allowUnchanged: true,
    })).resolves.toMatchObject({ unchanged: true, records: [], sourceRows: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honors Retry-After for transient public-host throttling', async () => {
    const sleepImpl = vi.fn(async () => undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '2' },
      }))
      .mockImplementation(async (url) => new Response(bodies.get(url), { status: 200 }));

    await expect(loadOlistPublicSource(config, null, limits, {
      manifest,
      fetchImpl,
      sleepImpl,
    })).resolves.toMatchObject({ sourceRows: 5, rejectedRows: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleepImpl).toHaveBeenCalledWith(2_000);
  });

  it('fails closed when an upstream CSV no longer matches its pinned checksum', async () => {
    const fetchImpl = vi.fn(async (url) => new Response(
      url === manifest.files.customers.url ? `${customers}\ntampered` : bodies.get(url),
      { status: 200 },
    ));
    await expect(loadOlistPublicSource(config, null, limits, {
      manifest,
      fetchImpl,
    })).rejects.toThrow(/checksum mismatch/u);
  });

  it('fails when relational join rejects more orders than the configured quality budget', async () => {
    await expect(loadOlistPublicSource({ ...config, maxRejectedRows: 0 }, null, limits, {
      manifest,
      fetchImpl: successfulFetch(),
    })).rejects.toThrow(/exceeding source.maxRejectedRows=0/u);
  });
});
