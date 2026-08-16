import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  OLIST_AVAILABLE_METRICS,
  loadOlistPublicSource,
  manifestSha256,
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
  'o1,2,p2,s1,2017-01-02 00:00:00,5.50,1.00',
  'o1,1,p1,s1,2017-01-02 00:00:00,10.00,1.00',
  'o2,1,p3,s2,2017-01-03 00:00:00,20.00,2.00',
  'o3,1,p4,s2,2017-01-03 00:00:00,99.00,3.00',
  'o4,1,p5,s3,2017-01-03 00:00:00,7.25,1.00',
].join('\n');
const products = [
  'product_id,product_category_name,product_name_lenght,product_description_lenght,product_photos_qty,product_weight_g,product_length_cm,product_height_cm,product_width_cm',
  'p1,beleza_saude,10,20,1,100,10,10,10',
  'p2,esporte_lazer,10,20,1,100,10,10,10',
  'p3,beleza_saude,10,20,1,100,10,10,10',
  'p4,pc_gamer,10,20,1,100,10,10,10',
  'p5,,10,20,1,100,10,10,10',
].join('\n');
const categoryTranslations = [
  'product_category_name,product_category_name_english',
  'beleza_saude,health_beauty',
  'esporte_lazer,sports_leisure',
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
    products: file('products', products, [
      'product_id',
      'product_category_name',
      'product_name_lenght',
      'product_description_lenght',
      'product_photos_qty',
      'product_weight_g',
      'product_length_cm',
      'product_height_cm',
      'product_width_cm',
    ]),
    categoryTranslations: file('category-translations', categoryTranslations, [
      'product_category_name',
      'product_category_name_english',
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
  [manifest.files.products.url, products],
  [manifest.files.categoryTranslations.url, categoryTranslations],
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
const checkpoint = `olist:${revision}:${manifestSha256(manifest)}`;
const exampleConfig = JSON.parse(readFileSync(
  new URL('../../config/commerce-connector.olist.example.json', import.meta.url),
  'utf8',
));

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

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({
      checkpointAfter: checkpoint,
      transport: 'olist',
      sourceRows: 5,
      rejectedRows: 1,
    });
    expect(result.sourceSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.records).toEqual([
      expect.objectContaining({
        metric_date: '2017-01-01',
        region: 'SP',
        sku: 'p1',
        category: 'health_beauty',
        business_timezone: 'America/Sao_Paulo',
        gmv: 10,
        units: 1,
        paid_orders: 1,
        new_customers: 1,
        data_mode: 'snapshot',
        currency_code: 'BRL',
        available_metrics: OLIST_AVAILABLE_METRICS,
      }),
      expect.objectContaining({
        metric_date: '2017-01-01',
        region: 'SP',
        sku: 'p2',
        category: 'sports_leisure',
        gmv: 5.5,
        units: 1,
        paid_orders: 0,
        new_customers: 0,
      }),
      expect.objectContaining({
        metric_date: '2017-01-02',
        region: 'MG',
        sku: 'p5',
        category: 'Uncategorized',
        gmv: 7.25,
        units: 1,
        paid_orders: 1,
        new_customers: 1,
      }),
      expect.objectContaining({
        metric_date: '2017-01-02',
        region: 'RJ',
        sku: 'p3',
        category: 'health_beauty',
        gmv: 20,
        units: 1,
        paid_orders: 1,
        new_customers: 0,
      }),
    ]);
    expect(result.records.reduce((sum, record) => sum + record.gmv, 0)).toBe(42.75);
    expect(result.records.reduce((sum, record) => sum + record.units, 0)).toBe(4);
    expect(result.records.reduce((sum, record) => sum + record.paid_orders, 0)).toBe(3);
    expect(result.records.reduce((sum, record) => sum + record.new_customers, 0)).toBe(2);
  });

  it('skips all downloads when the immutable revision checkpoint is unchanged', async () => {
    const fetchImpl = successfulFetch();
    await expect(loadOlistPublicSource(config, checkpoint, limits, {
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
    expect(fetchImpl).toHaveBeenCalledTimes(6);
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

  it('enforces the normalized product-bucket row limit', async () => {
    await expect(loadOlistPublicSource(config, null, { ...limits, maxRows: 3 }, {
      manifest,
      fetchImpl: successfulFetch(),
    })).rejects.toThrow(/exceeded maxRows=3/u);
  });

  it('keeps example limits above the measured pinned-snapshot footprint', () => {
    expect(exampleConfig.maxRows).toBeGreaterThanOrEqual(150_000);
    expect(exampleConfig.maxRows).toBeGreaterThan(99_633);
    expect(exampleConfig.maxBytes).toBeGreaterThanOrEqual(100_000_000);
  });
});
