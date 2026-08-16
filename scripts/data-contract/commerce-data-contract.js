const { createHash } = require('node:crypto');

const CONTRACT_VERSION = 'commerce-data-contract/v1';
const FLAGSHIP_METRICS = [
  'visits',
  'paid_orders',
  'gmv',
  'conversion_rate',
  'average_order_value',
];

const OLIST_DAILY_TOTALS_CSV = `date,paidOrders,gmvMinor
2018-01-01,73,694821
2018-01-02,203,2531500
2018-01-03,221,3128673
2018-01-04,255,3483944
2018-01-05,209,2772039
2018-01-06,215,2760967
2018-01-07,195,2943301
2018-01-08,292,3871440
2018-01-09,251,3024891
2018-01-10,277,3847953
2018-01-11,264,4005696
2018-01-12,239,3098894
2018-01-13,216,2809191
2018-01-14,232,3096253
2018-01-15,305,3833030
2018-01-16,301,4423717
2018-01-17,282,3608922
2018-01-18,238,2777477
2018-01-19,232,2995478
2018-01-20,183,2223268
2018-01-21,193,2370893
2018-01-22,309,3704765
2018-01-23,260,3432637
2018-01-24,240,3141379
2018-01-25,230,2952862
2018-01-26,225,3377020
2018-01-27,150,2154461
2018-01-28,152,2367185
2018-01-29,242,2998756
2018-01-30,251,2883957
2018-01-31,252,3230259
2018-02-01,228,2998575
2018-02-02,208,2761353
2018-02-03,190,2308467
2018-02-04,200,2381079
2018-02-05,266,3686624
2018-02-06,266,3390563
2018-02-07,243,3112144
2018-02-08,225,2707486
2018-02-09,208,3057107
2018-02-10,175,2112916
2018-02-11,169,2243508
2018-02-12,214,2325573
2018-02-13,220,2351644
2018-02-14,290,3683097
2018-02-15,276,3196897
2018-02-16,212,2689499
2018-02-17,199,2484148
2018-02-18,200,2449163
2018-02-19,255,2786913
2018-02-20,285,3641209
2018-02-21,261,3210791
2018-02-22,274,3115498
2018-02-23,235,2842470
2018-02-24,189,2421018
2018-02-25,236,2905387
2018-02-26,293,4363216
2018-02-27,296,4015140
2018-02-28,311,4548058
2018-03-01,272,3938163
2018-03-02,265,3177646
2018-03-03,209,2609127
2018-03-04,235,3244190
2018-03-05,259,3811607
2018-03-06,271,3917399
2018-03-07,258,3613789
2018-03-08,233,2799439
2018-03-09,203,2840544
2018-03-10,191,2596494
2018-03-11,218,3132043
2018-03-12,232,3064466
2018-03-13,226,3577624
2018-03-14,198,2352879
2018-03-15,286,4431146
2018-03-16,252,3283219
2018-03-17,180,2007850
2018-03-18,215,3111933
2018-03-19,301,4458019
2018-03-20,295,3543147
2018-03-21,284,3958943
2018-03-22,254,3111941
2018-03-23,219,2962124
2018-03-24,165,2378777
2018-03-25,190,2555729
2018-03-26,270,3572511
2018-03-27,244,3472652
2018-03-28,218,2968344
2018-03-29,193,2884174
2018-03-30,165,2208814
2018-03-31,167,2520373
2018-04-01,207,2939666
2018-04-02,280,3972210
2018-04-03,246,3624651
2018-04-04,257,3798273
2018-04-05,266,3605879
2018-04-06,188,2750744
2018-04-07,164,2551738
2018-04-08,185,2346385
2018-04-09,253,4930873
2018-04-10,201,2787056
2018-04-11,274,4078296
2018-04-12,255,3411758
2018-04-13,199,2985081
2018-04-14,146,1884570
2018-04-15,223,3052404
2018-04-16,279,4035706
2018-04-17,264,3665407
2018-04-18,280,3947271
2018-04-19,290,4308023
2018-04-20,196,2835384
2018-04-21,156,1896634
2018-04-22,200,2735090
2018-04-23,285,3767427
2018-04-24,270,4304678
2018-04-25,283,4094512
2018-04-26,253,3140956
2018-04-27,241,4068004
2018-04-28,168,2342091
2018-04-29,170,1930270
2018-04-30,240,3568261
2018-05-01,254,3296390
2018-05-02,295,3855772
2018-05-03,304,4249777
2018-05-04,265,3973093
2018-05-05,195,2823905
2018-05-06,209,2828825
2018-05-07,369,5321198
2018-05-08,327,4780069
2018-05-09,341,4356122
2018-05-10,278,5038067
2018-05-11,246,3785919
2018-05-12,204,2960414
2018-05-13,206,3131352
2018-05-14,363,5370239
2018-05-15,351,4105486
2018-05-16,356,5623883
2018-05-17,226,3145063
2018-05-18,236,3162152
2018-05-19,138,2508139
2018-05-20,160,1952855`;

function createSegmentGrid({ channels, regions, products }) {
  return channels.flatMap((channel, channelIndex) => regions.map((region, regionIndex) => {
    const product = products[(channelIndex * regions.length + regionIndex) % products.length];
    return {
      channel: channel.name,
      region: region.name,
      sku: product.sku,
      category: product.category,
      allocationWeight: channel.weight * region.weight * product.weight,
      weekendMultiplier: channel.weekendMultiplier * region.weekendMultiplier,
      trend: channel.trend + region.trend + product.trend,
      finalWindowMultiplier: channel.finalWindowMultiplier * region.finalWindowMultiplier,
      seasonalPhase: channelIndex * 3 + regionIndex * 5,
    };
  }));
}

const OLIST_SEGMENTS = createSegmentGrid({
  channels: [
    { name: 'Organic Search', weight: 0.34, weekendMultiplier: 0.92, trend: 0.08, finalWindowMultiplier: 1.3 },
    { name: 'Paid Social', weight: 0.28, weekendMultiplier: 1.08, trend: 0.03, finalWindowMultiplier: 1.08 },
    { name: 'Email', weight: 0.22, weekendMultiplier: 1.02, trend: -0.02, finalWindowMultiplier: 0.75 },
    { name: 'Direct', weight: 0.16, weekendMultiplier: 1.04, trend: -0.05, finalWindowMultiplier: 0.62 },
  ],
  regions: [
    { name: 'SP', weight: 0.41, weekendMultiplier: 0.98, trend: 0.04, finalWindowMultiplier: 1.08 },
    { name: 'RJ', weight: 0.27, weekendMultiplier: 1.03, trend: -0.01, finalWindowMultiplier: 0.94 },
    { name: 'MG', weight: 0.19, weekendMultiplier: 1.01, trend: 0.02, finalWindowMultiplier: 1.04 },
    { name: 'PR', weight: 0.13, weekendMultiplier: 0.97, trend: -0.03, finalWindowMultiplier: 0.9 },
  ],
  products: [
    { sku: 'OLIST-HB-CORE', category: 'Health & Beauty', weight: 1.08, trend: 0.03 },
    { sku: 'OLIST-HB-PREMIUM', category: 'Health & Beauty', weight: 0.92, trend: -0.01 },
    { sku: 'OLIST-HOME-CORE', category: 'Home & Decor', weight: 1.05, trend: 0.01 },
    { sku: 'OLIST-HOME-PREMIUM', category: 'Home & Decor', weight: 0.95, trend: -0.02 },
    { sku: 'OLIST-SPORT-CORE', category: 'Sports & Leisure', weight: 1.02, trend: 0.02 },
    { sku: 'OLIST-SPORT-PREMIUM', category: 'Sports & Leisure', weight: 0.98, trend: 0 },
    { sku: 'OLIST-ELEC-CORE', category: 'Electronics', weight: 1.04, trend: 0.01 },
    { sku: 'OLIST-ELEC-PREMIUM', category: 'Electronics', weight: 0.96, trend: -0.03 },
  ],
});

const COMPATIBLE_SEGMENTS = createSegmentGrid({
  channels: [
    { name: 'Marketplace', weight: 0.36, weekendMultiplier: 1.05, trend: 0.04, finalWindowMultiplier: 1.12 },
    { name: 'Affiliate', weight: 0.24, weekendMultiplier: 1.02, trend: -0.01, finalWindowMultiplier: 0.93 },
    { name: 'Search', weight: 0.25, weekendMultiplier: 0.94, trend: 0.03, finalWindowMultiplier: 1.08 },
    { name: 'CRM', weight: 0.15, weekendMultiplier: 0.99, trend: -0.02, finalWindowMultiplier: 0.82 },
  ],
  regions: [
    { name: 'East', weight: 0.31, weekendMultiplier: 0.98, trend: 0.02, finalWindowMultiplier: 1.04 },
    { name: 'South', weight: 0.28, weekendMultiplier: 1.03, trend: -0.01, finalWindowMultiplier: 0.96 },
    { name: 'North', weight: 0.23, weekendMultiplier: 1.01, trend: 0.01, finalWindowMultiplier: 1.02 },
    { name: 'West', weight: 0.18, weekendMultiplier: 0.97, trend: -0.02, finalWindowMultiplier: 0.92 },
  ],
  products: [
    { sku: 'COMPAT-APPAREL-CORE', category: 'Apparel', weight: 1.08, trend: 0.02 },
    { sku: 'COMPAT-APPAREL-PREMIUM', category: 'Apparel', weight: 0.92, trend: -0.01 },
    { sku: 'COMPAT-HOME-CORE', category: 'Home', weight: 1.05, trend: 0.01 },
    { sku: 'COMPAT-HOME-PREMIUM', category: 'Home', weight: 0.95, trend: -0.02 },
    { sku: 'COMPAT-BEAUTY-CORE', category: 'Beauty', weight: 1.04, trend: 0.02 },
    { sku: 'COMPAT-BEAUTY-PREMIUM', category: 'Beauty', weight: 0.96, trend: -0.01 },
    { sku: 'COMPAT-SPORT-CORE', category: 'Sports', weight: 1.02, trend: 0.01 },
    { sku: 'COMPAT-SPORT-PREMIUM', category: 'Sports', weight: 0.98, trend: -0.02 },
  ],
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function sha256Json(value) {
  return sha256Text(canonicalJson(value));
}

function keyedFraction(seed, key) {
  const digest = createHash('sha256').update(`${seed}\u001f${key}`, 'utf8').digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

function allocateInteger(total, weights, seed, key) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Allocation total is invalid.');
  const normalized = weights.map((weight, index) => (
    Math.max(0.000001, weight + (keyedFraction(seed, `${key}:${index}`) - 0.5) * 0.02)
  ));
  const denominator = normalized.reduce((sum, weight) => sum + weight, 0);
  const exact = normalized.map((weight) => total * weight / denominator);
  const output = exact.map(Math.floor);
  let remaining = total - output.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; index < remaining; index += 1) output[order[index].index] += 1;
  return output;
}

function parseOlistDailyTotals() {
  return OLIST_DAILY_TOTALS_CSV.split('\n').slice(1).map((line) => {
    const [date, paidOrders, gmvMinor] = line.split(',');
    return { date, paidOrders: Number(paidOrders), gmvMinor: Number(gmvMinor) };
  });
}

function addUtcDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function createRows({
  dailyTotals,
  segments,
  seed,
  timezone,
  currency,
  sourceUpdatedAt,
}) {
  const rows = [];
  for (const [dayIndex, daily] of dailyTotals.entries()) {
    const weekday = new Date(`${daily.date}T00:00:00.000Z`).getUTCDay();
    const progress = dailyTotals.length <= 1 ? 0 : dayIndex / (dailyTotals.length - 1);
    const inFinalWindow = dayIndex >= dailyTotals.length - 14;
    const activeSegments = segments
      .map((segment, segmentIndex) => ({ segment, segmentIndex }))
      .filter(({ segmentIndex }) => segments.length <= 8 || (segmentIndex + dayIndex) % 2 === 0);
    const weights = activeSegments.map(({ segment }) => {
      const weekend = weekday === 0 || weekday === 6 ? segment.weekendMultiplier : 1;
      const trend = Math.max(0.7, 1 + segment.trend * (progress - 0.5));
      const seasonality = 1 + Math.sin((dayIndex + segment.seasonalPhase) * Math.PI * 2 / 28) * 0.035;
      const finalWindow = inFinalWindow ? segment.finalWindowMultiplier : 1;
      return segment.allocationWeight * weekend * trend * seasonality * finalWindow;
    });
    const orders = allocateInteger(daily.paidOrders, weights, seed, `${daily.date}:orders`);
    const money = allocateInteger(daily.gmvMinor, weights, seed + 1, `${daily.date}:gmv`);
    for (const [activeIndex, { segment, segmentIndex }] of activeSegments.entries()) {
      const conversion = 0.018
        + segmentIndex * 0.004
        + keyedFraction(seed, `${daily.date}:${segment.channel}:conversion`) * 0.008;
      const visits = orders[activeIndex] === 0
        ? Math.round(25 + keyedFraction(seed, `${daily.date}:${segment.channel}:zero-visits`) * 50)
        : Math.max(orders[activeIndex], Math.round(orders[activeIndex] / conversion));
      const units = orders[activeIndex] + Math.floor(
        orders[activeIndex] * (0.08 + keyedFraction(seed, `${daily.date}:${segment.sku}:units`) * 0.17),
      );
      rows.push({
        metric_date: daily.date,
        region: segment.region,
        channel: segment.channel,
        sku: segment.sku,
        category: segment.category,
        business_timezone: timezone,
        data_mode: 'snapshot',
        currency_code: currency,
        visits,
        paid_orders: orders[activeIndex],
        units,
        gmv: money[activeIndex] / 100,
        available_metrics: [...FLAGSHIP_METRICS],
        source_updated_at: sourceUpdatedAt,
      });
    }
  }
  return rows;
}

function partitionsFor(rows, sourceWatermark) {
  const counts = new Map();
  for (const row of rows) counts.set(row.metric_date, (counts.get(row.metric_date) || 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
    ([date, factRowCount]) => ({
      date,
      completeness: 'ready',
      factRowCount,
      sourceWatermark,
    }),
  );
}

function flagshipCapabilities(origin) {
  return {
    metrics: {
      visits: origin === 'olist' ? 'derived' : 'native',
      paid_orders: 'native',
      gmv: 'native',
      conversion_rate: 'derived',
      average_order_value: 'derived',
    },
    dimensions: {
      channel: origin === 'olist' ? 'derived' : 'native',
      sku: origin === 'olist' ? 'derived' : 'native',
      category: origin === 'olist' ? 'derived' : 'native',
      region: origin === 'olist' ? 'derived' : 'native',
    },
    reconciliation: {
      visitsToOrders: 'same_source',
      ordersToGmv: 'same_source',
    },
    optional: {
      businessEvents: 'unavailable',
      inventory: 'unavailable',
      refunds: 'unavailable',
    },
  };
}

function createOlistDerivedSnapshot() {
  const seed = 20260816;
  const sourceWatermark = '2018-05-21T03:00:00.000Z';
  const dailyTotals = parseOlistDailyTotals();
  const records = createRows({
    dailyTotals,
    segments: OLIST_SEGMENTS,
    seed,
    timezone: 'America/Sao_Paulo',
    currency: 'BRL',
    sourceUpdatedAt: '2018-10-17T20:30:18.000Z',
  });
  return {
    contractVersion: CONTRACT_VERSION,
    snapshotId: 'snapshot_olist_same_source_derived_v1',
    descriptor: {
      contractVersion: CONTRACT_VERSION,
      adapterId: 'olist-same-source-derived-adapter',
      adapterVersion: '1.0.0',
      sourceId: 'olist-public-orders',
      sourceKind: 'public_snapshot',
      sourceUri: 'https://github.com/olist/work-at-olist-data',
      sourceRevision: 'd9e49802f3e92d09ee94ab9ccc5e457f207a8959',
      sourceSha256: 'sha256:fb4269549e89bdd5f7bd62568b9150b12b6f1dea0a7a96fcd879448ae9bdd418',
      license: {
        id: 'MIT',
        uri: 'https://github.com/olist/work-at-olist-data/blob/d9e49802f3e92d09ee94ab9ccc5e457f207a8959/LICENSE',
      },
      businessTimezone: 'America/Sao_Paulo',
      currencyCode: 'BRL',
      fixtureSeed: seed,
      lineage: {
        algorithm: 'commerce-fixture-generator',
        algorithmVersion: '1.1.0',
        generatedFields: ['visits', 'channel', 'region', 'sku', 'category', 'units'],
        steps: [
          'verified Olist revision and five source file digests',
          'daily aggregation of native paid_orders and item-price GMV',
          'seeded cross-dimensional segment allocation preserving exact daily native totals',
          'deterministic channel, region and product share shifts for diagnostic drill-downs',
          'seeded visits derivation with bounded conversion rates',
        ],
      },
      capabilities: flagshipCapabilities('olist'),
    },
    coverage: {
      start: dailyTotals[0].date,
      end: dailyTotals[dailyTotals.length - 1].date,
      sourceWatermark,
      virtualAsOf: '2018-05-22T12:00:00.000Z',
    },
    partitions: partitionsFor(records, sourceWatermark),
    records,
    businessEvents: [],
  };
}

function createCompatibleDailyTotals() {
  const start = '2025-01-13';
  const seed = 90421;
  return Array.from({ length: 140 }, (_, index) => {
    const weekly = Math.sin(index * Math.PI * 2 / 7);
    const trend = index * 0.45;
    const jitter = (keyedFraction(seed, `compatible:${index}`) - 0.5) * 22;
    const paidOrders = Math.max(80, Math.round(185 + trend + weekly * 24 + jitter));
    const aovMinor = Math.round(8_900 + Math.cos(index * Math.PI * 2 / 31) * 700);
    return { date: addUtcDays(start, index), paidOrders, gmvMinor: paidOrders * aovMinor };
  });
}

function createCompatibleFixtureSnapshot() {
  const seed = 90421;
  const dailyTotals = createCompatibleDailyTotals();
  const recipeSha256 = sha256Json({
    fixture: 'controlled-commerce-fixture-v1',
    seed,
    algorithm: 'commerce-fixture-generator@1.1.0',
    dailyTotals,
  });
  const sourceWatermark = '2025-06-02T00:00:00.000Z';
  const records = createRows({
    dailyTotals,
    segments: COMPATIBLE_SEGMENTS,
    seed,
    timezone: 'Asia/Shanghai',
    currency: 'CNY',
    sourceUpdatedAt: sourceWatermark,
  });
  return {
    contractVersion: CONTRACT_VERSION,
    snapshotId: 'snapshot_controlled_compatible_v1',
    descriptor: {
      contractVersion: CONTRACT_VERSION,
      adapterId: 'controlled-compatible-adapter',
      adapterVersion: '1.0.0',
      sourceId: 'controlled-commerce-fixture-v1',
      sourceKind: 'controlled_fixture',
      sourceUri: 'local://contracts/commerce-data-contract/v1',
      sourceRevision: '1.0.0',
      sourceSha256: recipeSha256,
      license: {
        id: 'CC0-1.0',
        uri: 'https://creativecommons.org/publicdomain/zero/1.0/',
      },
      businessTimezone: 'Asia/Shanghai',
      currencyCode: 'CNY',
      fixtureSeed: seed,
      lineage: {
        algorithm: 'commerce-fixture-generator',
        algorithmVersion: '1.1.0',
        generatedFields: [
          'metric_date', 'visits', 'paid_orders', 'gmv', 'channel', 'region', 'sku', 'category', 'units',
        ],
        steps: [
          'generate deterministic day totals from fixed trend and seasonal functions',
          'seeded cross-dimensional segment allocation preserving exact daily totals',
          'derive visits with bounded conversion rates',
        ],
      },
      capabilities: flagshipCapabilities('controlled'),
    },
    coverage: {
      start: dailyTotals[0].date,
      end: dailyTotals[dailyTotals.length - 1].date,
      sourceWatermark,
      virtualAsOf: '2025-06-03T12:00:00.000Z',
    },
    partitions: partitionsFor(records, sourceWatermark),
    records,
    businessEvents: [],
  };
}

function createContractFixtureAssets() {
  const olistBaseDaily = {
    schemaVersion: 1,
    sourceId: 'olist-public-orders',
    sourceRevision: 'd9e49802f3e92d09ee94ab9ccc5e457f207a8959',
    sourceSha256: 'sha256:fb4269549e89bdd5f7bd62568b9150b12b6f1dea0a7a96fcd879448ae9bdd418',
    aggregation: 'tenant-local day; included Olist paid statuses; item price excludes freight',
    start: '2018-01-01',
    end: '2018-05-20',
    days: parseOlistDailyTotals(),
  };
  const olist = createOlistDerivedSnapshot();
  const compatible = createCompatibleFixtureSnapshot();
  const fixtureManifest = {
    schemaVersion: 1,
    contractVersion: CONTRACT_VERSION,
    artifacts: [
      {
        id: 'olist-base-daily-totals-v1',
        path: 'sources/olist-base-daily-totals-v1.json',
        sha256: sha256Json(olistBaseDaily),
      },
      {
        id: 'olist-same-source-derived-v1',
        path: 'fixtures/olist-same-source-derived-v1.json',
        seed: 20260816,
        sha256: sha256Json(olist),
        disclosure: 'Visits and drill-down dimensions are deterministic public-data-derived demonstration fields.',
      },
      {
        id: 'controlled-compatible-v1',
        path: 'fixtures/controlled-compatible-v1.json',
        seed: 90421,
        sha256: sha256Json(compatible),
        disclosure: 'Entirely controlled deterministic fixture; not a real merchant.',
      },
    ],
  };
  return { olistBaseDaily, olist, compatible, fixtureManifest };
}

module.exports = {
  CONTRACT_VERSION,
  FLAGSHIP_METRICS,
  canonicalJson,
  createCompatibleFixtureSnapshot,
  createContractFixtureAssets,
  createOlistDerivedSnapshot,
  parseOlistDailyTotals,
  sha256Json,
  sha256Text,
};
