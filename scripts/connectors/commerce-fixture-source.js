const fs = require('node:fs');
const path = require('node:path');

const {
  CONTRACT_VERSION,
  sha256Json,
} = require('../data-contract/commerce-data-contract');

const CONTRACT_ROOT = path.resolve(__dirname, '..', '..', 'contracts', 'commerce-data-contract', 'v1');
const FIXTURE_MANIFEST_PATH = path.join(CONTRACT_ROOT, 'fixture-manifest.json');
const FLAGSHIP_METRICS = [
  'visits',
  'paid_orders',
  'gmv',
  'conversion_rate',
  'average_order_value',
];
const FLAGSHIP_DIMENSIONS = ['channel', 'sku', 'category', 'region'];
const BUSINESS_EVENT_TYPES = new Set([
  'price_change',
  'campaign_change',
  'promotion',
  'restock',
  'stockout',
]);
const PLACEHOLDER_DIMENSIONS = new Set(['', 'unknown', 'n/a', 'na', 'null', 'unspecified']);

function requiredText(value, label, maximumLength = 240) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximumLength) {
    throw new Error(`${label} must be non-empty text of at most ${maximumLength} characters.`);
  }
  return normalized;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value || '')) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function inclusiveDates(start, end) {
  if (!validDate(start) || !validDate(end) || start > end) {
    throw new Error('Fixture coverage must be a valid ordered YYYY-MM-DD range.');
  }
  const dates = [];
  for (
    let current = Date.parse(`${start}T00:00:00.000Z`);
    current <= Date.parse(`${end}T00:00:00.000Z`);
    current += 86_400_000
  ) dates.push(new Date(current).toISOString().slice(0, 10));
  return dates;
}

function validateCapabilityMatrix(descriptor) {
  const capabilities = descriptor.capabilities;
  if (!capabilities || typeof capabilities !== 'object') {
    throw new Error('Fixture descriptor capabilities are required.');
  }
  for (const metric of FLAGSHIP_METRICS) {
    if (!['native', 'derived'].includes(capabilities.metrics?.[metric])) {
      throw new Error(`Fixture flagship metric capability is unavailable: ${metric}.`);
    }
  }
  for (const dimension of FLAGSHIP_DIMENSIONS) {
    if (!['native', 'derived'].includes(capabilities.dimensions?.[dimension])) {
      throw new Error(`Fixture flagship dimension capability is unavailable: ${dimension}.`);
    }
  }
  if (!['same_source', 'audited_cross_source'].includes(capabilities.reconciliation?.visitsToOrders)
      || !['same_source', 'audited_cross_source'].includes(capabilities.reconciliation?.ordersToGmv)) {
    throw new Error('Fixture KPI-tree reconciliation must be available.');
  }
  if (!['native', 'derived', 'unavailable'].includes(capabilities.optional?.businessEvents)) {
    throw new Error('Fixture business-event capability is invalid.');
  }
  const derived = [
    ...Object.values(capabilities.metrics || {}),
    ...Object.values(capabilities.dimensions || {}),
  ].includes('derived');
  if (derived && (
    !Number.isSafeInteger(descriptor.fixtureSeed)
    || !requiredText(descriptor.lineage?.algorithm, 'descriptor.lineage.algorithm', 120)
    || !requiredText(descriptor.lineage?.algorithmVersion, 'descriptor.lineage.algorithmVersion', 80)
    || !Array.isArray(descriptor.lineage?.generatedFields)
    || descriptor.lineage.generatedFields.length === 0
    || !Array.isArray(descriptor.lineage?.steps)
    || descriptor.lineage.steps.length === 0
  )) {
    throw new Error('Derived fixture capabilities require a seed and explicit lineage.');
  }
}

function validateBusinessEvents(snapshot, virtualAsOf) {
  if (!Array.isArray(snapshot.businessEvents)) {
    throw new Error('Fixture businessEvents must be an array, including when no events exist.');
  }
  if (
    snapshot.businessEvents.length > 0
    && snapshot.descriptor.capabilities.optional.businessEvents === 'unavailable'
  ) {
    throw new Error('Fixture contains business events while its capability is unavailable.');
  }
  const ids = new Set();
  for (const [index, event] of snapshot.businessEvents.entries()) {
    const prefix = `businessEvents[${index}]`;
    const eventId = requiredText(event?.eventId, `${prefix}.eventId`, 160);
    if (ids.has(eventId)) throw new Error(`Duplicate fixture business event: ${eventId}.`);
    ids.add(eventId);
    if (!BUSINESS_EVENT_TYPES.has(event?.eventType)) {
      throw new Error(`${prefix}.eventType is invalid.`);
    }
    const occurredAt = Date.parse(event?.occurredAt);
    if (!Number.isFinite(occurredAt) || occurredAt > virtualAsOf) {
      throw new Error(`${prefix}.occurredAt must be an ISO instant at or before virtualAsOf.`);
    }
    if (!event.scope || typeof event.scope !== 'object' || Array.isArray(event.scope)) {
      throw new Error(`${prefix}.scope must be an object.`);
    }
    for (const [dimension, value] of Object.entries(event.scope)) {
      if (!FLAGSHIP_DIMENSIONS.includes(dimension)) {
        throw new Error(`${prefix}.scope contains an unsupported dimension.`);
      }
      requiredText(value, `${prefix}.scope.${dimension}`, 120);
    }
    requiredText(event.source, `${prefix}.source`, 240);
    if (typeof event.confidence !== 'number'
        || !Number.isFinite(event.confidence)
        || event.confidence < 0
        || event.confidence > 1) {
      throw new Error(`${prefix}.confidence must be between zero and one.`);
    }
    if (typeof event.scenarioMetadata !== 'boolean') {
      throw new Error(`${prefix}.scenarioMetadata must be boolean.`);
    }
    if (snapshot.descriptor.sourceKind === 'public_snapshot' && !event.scenarioMetadata) {
      throw new Error('Public fixture business events must be labelled as simulated scenario metadata.');
    }
  }
}

function validateCommerceFixtureSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Commerce fixture snapshot must be an object.');
  }
  if (snapshot.contractVersion !== CONTRACT_VERSION
      || snapshot.descriptor?.contractVersion !== CONTRACT_VERSION) {
    throw new Error(`Unsupported Commerce fixture contract: ${snapshot.contractVersion}.`);
  }
  requiredText(snapshot.snapshotId, 'snapshotId', 160);
  const descriptor = snapshot.descriptor;
  requiredText(descriptor.adapterId, 'descriptor.adapterId', 160);
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(descriptor.adapterVersion || '')) {
    throw new Error('descriptor.adapterVersion must be semantic version text.');
  }
  requiredText(descriptor.sourceId, 'descriptor.sourceId', 160);
  if (!['public_snapshot', 'controlled_fixture', 'production_connector'].includes(descriptor.sourceKind)) {
    throw new Error('descriptor.sourceKind is invalid.');
  }
  requiredText(descriptor.sourceUri, 'descriptor.sourceUri', 1_000);
  requiredText(descriptor.sourceRevision, 'descriptor.sourceRevision', 240);
  if (!/^sha256:[a-f0-9]{64}$/u.test(descriptor.sourceSha256 || '')) {
    throw new Error('descriptor.sourceSha256 must be a prefixed SHA-256 digest.');
  }
  requiredText(descriptor.license?.id, 'descriptor.license.id', 80);
  requiredText(descriptor.license?.uri, 'descriptor.license.uri', 1_000);
  try {
    new Intl.DateTimeFormat('en', { timeZone: descriptor.businessTimezone }).format();
  } catch {
    throw new Error('descriptor.businessTimezone must be an IANA timezone.');
  }
  if (!/^[A-Z]{3}$/u.test(descriptor.currencyCode || '')) {
    throw new Error('descriptor.currencyCode must be an ISO-4217 code.');
  }
  validateCapabilityMatrix(descriptor);

  const dates = inclusiveDates(snapshot.coverage?.start, snapshot.coverage?.end);
  if (dates.length < 90) throw new Error('Fixture snapshots require at least 90 complete days.');
  const sourceWatermark = Date.parse(snapshot.coverage?.sourceWatermark);
  const virtualAsOf = Date.parse(snapshot.coverage?.virtualAsOf);
  if (!Number.isFinite(sourceWatermark) || !Number.isFinite(virtualAsOf)) {
    throw new Error('Fixture sourceWatermark and virtualAsOf must be ISO timestamps.');
  }
  if (sourceWatermark > virtualAsOf) {
    throw new Error('Fixture sourceWatermark cannot be in the virtual future.');
  }

  if (!Array.isArray(snapshot.partitions) || !Array.isArray(snapshot.records)) {
    throw new Error('Fixture partitions and records must be arrays.');
  }
  const dateSet = new Set(dates);
  const partitions = new Map();
  for (const partition of snapshot.partitions) {
    if (!dateSet.has(partition.date) || partitions.has(partition.date)) {
      throw new Error('Fixture partitions must contain each coverage date exactly once.');
    }
    if (partition.completeness !== 'ready'
        || !Number.isSafeInteger(partition.factRowCount)
        || partition.factRowCount < 0
        || !Number.isFinite(Date.parse(partition.sourceWatermark))) {
      throw new Error(`Fixture partition ${partition.date} is invalid or incomplete.`);
    }
    partitions.set(partition.date, partition);
  }
  if (partitions.size !== dates.length) {
    throw new Error('Fixture partitions must contain each coverage date exactly once.');
  }

  const recordKeys = new Set();
  const categoryBySku = new Map();
  const rowCounts = new Map();
  const coveredDimensions = Object.fromEntries(FLAGSHIP_DIMENSIONS.map((dimension) => [dimension, 0]));
  for (const [index, record] of snapshot.records.entries()) {
    const prefix = `records[${index}]`;
    if (!dateSet.has(record.metric_date)) throw new Error(`${prefix}.metric_date is outside coverage.`);
    for (const dimension of FLAGSHIP_DIMENSIONS) {
      const value = requiredText(record[dimension], `${prefix}.${dimension}`, 120);
      if (!PLACEHOLDER_DIMENSIONS.has(value.toLowerCase())) coveredDimensions[dimension] += 1;
    }
    if (record.business_timezone !== descriptor.businessTimezone
        || record.currency_code !== descriptor.currencyCode
        || record.data_mode !== 'snapshot') {
      throw new Error(`${prefix} source semantics differ from the descriptor.`);
    }
    for (const field of ['visits', 'paid_orders', 'units']) {
      if (!Number.isSafeInteger(record[field]) || record[field] < 0) {
        throw new Error(`${prefix}.${field} must be a non-negative safe integer.`);
      }
    }
    if (record.paid_orders > record.visits
        || typeof record.gmv !== 'number'
        || !Number.isFinite(record.gmv)
        || record.gmv < 0
        || Math.abs(Math.round(record.gmv * 100) - record.gmv * 100) > 1e-8) {
      throw new Error(`${prefix} metric values are invalid.`);
    }
    if (!Array.isArray(record.available_metrics)
        || FLAGSHIP_METRICS.some((metric) => !record.available_metrics.includes(metric))) {
      throw new Error(`${prefix}.available_metrics does not expose the flagship contract.`);
    }
    if (!Number.isFinite(Date.parse(record.source_updated_at))) {
      throw new Error(`${prefix}.source_updated_at must be an ISO timestamp.`);
    }
    const key = [record.metric_date, record.region, record.channel, record.sku].join('\u001f');
    if (recordKeys.has(key)) throw new Error(`Duplicate Commerce fixture primary key: ${key}.`);
    recordKeys.add(key);
    const category = categoryBySku.get(record.sku);
    if (category && category !== record.category) {
      throw new Error(`Fixture SKU ${record.sku} maps to multiple categories.`);
    }
    categoryBySku.set(record.sku, record.category);
    rowCounts.set(record.metric_date, (rowCounts.get(record.metric_date) || 0) + 1);
  }
  for (const date of dates) {
    if (partitions.get(date).factRowCount !== (rowCounts.get(date) || 0)) {
      throw new Error(`Fixture partition ${date} row count does not reconcile.`);
    }
  }
  for (const dimension of FLAGSHIP_DIMENSIONS) {
    const coverage = snapshot.records.length
      ? coveredDimensions[dimension] / snapshot.records.length
      : 0;
    if (coverage < 0.95) throw new Error(`Fixture dimension ${dimension} coverage is below 95%.`);
  }
  validateBusinessEvents(snapshot, virtualAsOf);
  return snapshot;
}

function fixtureArtifact(fixtureId) {
  const normalized = requiredText(fixtureId, 'source.fixtureId', 160);
  const manifest = JSON.parse(fs.readFileSync(FIXTURE_MANIFEST_PATH, 'utf8'));
  if (manifest.contractVersion !== CONTRACT_VERSION || !Array.isArray(manifest.artifacts)) {
    throw new Error('Commerce fixture manifest is invalid.');
  }
  const artifact = manifest.artifacts.find((candidate) => (
    candidate.id === normalized && /^fixtures\/[A-Za-z0-9._-]+\.json$/u.test(candidate.path || '')
  ));
  if (!artifact || !/^sha256:[a-f0-9]{64}$/u.test(artifact.sha256 || '')) {
    throw new Error(`Commerce fixture is not allowlisted: ${normalized}.`);
  }
  const fixturePath = path.resolve(CONTRACT_ROOT, artifact.path);
  if (!fixturePath.startsWith(`${CONTRACT_ROOT}${path.sep}`)) {
    throw new Error('Commerce fixture path escapes the frozen contract root.');
  }
  return { ...artifact, fixturePath };
}

class FrozenCommerceFixtureAdapterV1 {
  constructor(fixtureId, options = {}) {
    this.artifact = fixtureArtifact(fixtureId);
    const stat = fs.statSync(this.artifact.fixturePath);
    if (!stat.isFile()) throw new Error('Commerce fixture must be a regular file.');
    if (options.maxBytes && stat.size > options.maxBytes) {
      throw new Error('Commerce fixture exceeded maxBytes.');
    }
    this.snapshot = validateCommerceFixtureSnapshot(
      JSON.parse(fs.readFileSync(this.artifact.fixturePath, 'utf8')),
    );
    const actualSha256 = sha256Json(this.snapshot);
    if (actualSha256 !== this.artifact.sha256) {
      throw new Error(`Commerce fixture hash mismatch for ${fixtureId}.`);
    }
    this.descriptor = this.snapshot.descriptor;
  }

  async loadSnapshot(input) {
    if (input?.signal?.aborted) throw new Error('Source Adapter request was aborted.');
    if (input?.virtualAsOf !== this.snapshot.coverage.virtualAsOf) {
      throw new Error('Frozen Commerce fixture only supports its declared virtualAsOf instant.');
    }
    return structuredClone(this.snapshot);
  }
}

function ingestRecords(snapshot) {
  return snapshot.records.map((record) => ({
    ...record,
    refund_orders: 0,
    refund_amount: 0,
    cost_amount: 0,
    ad_spend: 0,
    new_customers: 0,
    stockout_hours: 0,
    ending_inventory: 0,
    // The serving table stores raw additive inputs. Conversion rate and AOV remain
    // derived by the analytics repository from the same-source numerator/denominator.
    available_metrics: ['gmv', 'paid_orders', 'units', 'visits'],
  }));
}

async function loadCommerceFixtureSource(source, checkpoint, limits, runContext = {}) {
  const adapter = new FrozenCommerceFixtureAdapterV1(source.fixtureId, limits);
  const snapshot = await adapter.loadSnapshot({
    virtualAsOf: adapter.snapshot.coverage.virtualAsOf,
    signal: runContext.signal,
  });
  const fixtureSha256 = adapter.artifact.sha256;
  if (runContext.allowUnchanged && checkpoint === fixtureSha256) {
    return {
      unchanged: true,
      checkpointAfter: fixtureSha256,
      sourceSha256: fixtureSha256,
      transport: 'commerce_fixture',
    };
  }
  return {
    records: ingestRecords(snapshot),
    businessEvents: snapshot.businessEvents,
    snapshotMetadata: {
      snapshotId: snapshot.snapshotId,
      artifactSha256: fixtureSha256,
      descriptor: snapshot.descriptor,
      coverage: snapshot.coverage,
    },
    checkpointAfter: fixtureSha256,
    sourceSha256: fixtureSha256,
    sourceRows: snapshot.records.length,
    rejectedRows: 0,
    transport: 'commerce_fixture',
    coverageProof: {
      kind: 'complete_snapshot',
      coverageStart: snapshot.coverage.start,
      coverageEnd: snapshot.coverage.end,
      sourceUpdatedAt: snapshot.coverage.sourceWatermark,
    },
  };
}

module.exports = {
  FrozenCommerceFixtureAdapterV1,
  loadCommerceFixtureSource,
  validateCommerceFixtureSnapshot,
};
