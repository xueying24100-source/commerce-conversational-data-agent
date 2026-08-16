export const COMMERCE_DATA_CONTRACT_VERSION = 'commerce-data-contract/v1' as const;

export const COMMERCE_FLAGSHIP_METRICS = [
  'visits',
  'paid_orders',
  'gmv',
  'conversion_rate',
  'average_order_value',
] as const;

export const COMMERCE_FLAGSHIP_DIMENSIONS = [
  'channel',
  'sku',
  'category',
  'region',
] as const;

export type CommerceFlagshipMetric = typeof COMMERCE_FLAGSHIP_METRICS[number];
export type CommerceFlagshipDimension = typeof COMMERCE_FLAGSHIP_DIMENSIONS[number];
export type CommerceCapabilityAvailability = 'native' | 'derived' | 'unavailable';

export interface CommerceSourceCapabilityMatrixV1 {
  metrics: Record<CommerceFlagshipMetric, CommerceCapabilityAvailability>;
  dimensions: Record<CommerceFlagshipDimension, CommerceCapabilityAvailability>;
  reconciliation: {
    visitsToOrders: 'same_source' | 'audited_cross_source' | 'unavailable';
    ordersToGmv: 'same_source' | 'audited_cross_source' | 'unavailable';
  };
  optional: {
    businessEvents: CommerceCapabilityAvailability;
    inventory: CommerceCapabilityAvailability;
    refunds: CommerceCapabilityAvailability;
  };
}

export interface CommerceSourceDescriptorV1 {
  contractVersion: typeof COMMERCE_DATA_CONTRACT_VERSION;
  adapterId: string;
  adapterVersion: string;
  sourceId: string;
  sourceKind: 'public_snapshot' | 'controlled_fixture' | 'production_connector';
  sourceUri: string;
  sourceRevision: string;
  sourceSha256: `sha256:${string}`;
  license: {
    id: string;
    uri: string;
  };
  businessTimezone: string;
  currencyCode: string;
  fixtureSeed: number | null;
  lineage: {
    algorithm: string;
    algorithmVersion: string;
    generatedFields: string[];
    steps: string[];
  };
  capabilities: CommerceSourceCapabilityMatrixV1;
}

export interface CommerceContractPartitionV1 {
  date: string;
  completeness: 'ready' | 'missing' | 'stale' | 'future';
  factRowCount: number;
  sourceWatermark: string;
}

export interface CommerceContractRecordV1 {
  metric_date: string;
  region: string;
  channel: string;
  sku: string;
  category: string;
  business_timezone: string;
  data_mode: 'snapshot' | 'incremental';
  currency_code: string;
  visits: number;
  paid_orders: number;
  units: number;
  gmv: number;
  available_metrics: CommerceFlagshipMetric[];
  source_updated_at: string;
}

export interface CommerceBusinessEventV1 {
  eventId: string;
  eventType: 'price_change' | 'campaign_change' | 'promotion' | 'restock' | 'stockout';
  occurredAt: string;
  scope: Partial<Record<CommerceFlagshipDimension, string>>;
  source: string;
  confidence: number;
  scenarioMetadata: boolean;
}

export interface CommerceSourceSnapshotV1 {
  contractVersion: typeof COMMERCE_DATA_CONTRACT_VERSION;
  snapshotId: string;
  descriptor: CommerceSourceDescriptorV1;
  coverage: {
    start: string;
    end: string;
    sourceWatermark: string;
    virtualAsOf: string;
  };
  partitions: CommerceContractPartitionV1[];
  records: CommerceContractRecordV1[];
  businessEvents: CommerceBusinessEventV1[];
}

export interface CommerceSourceAdapterInputV1 {
  virtualAsOf: string;
  signal?: AbortSignal;
}

/**
 * Stable boundary between source-specific ingestion and the diagnostic core.
 * Adapters may fetch and normalize data, but they may not choose hypotheses,
 * baselines, findings, actions, or Evidence wording.
 */
export interface CommerceSourceAdapterV1 {
  readonly descriptor: CommerceSourceDescriptorV1;
  loadSnapshot(input: CommerceSourceAdapterInputV1): Promise<CommerceSourceSnapshotV1>;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PLACEHOLDER_DIMENSIONS = new Set(['', 'unknown', 'n/a', 'na', 'null', 'unspecified']);
const BUSINESS_EVENT_TYPES = new Set<CommerceBusinessEventV1['eventType']>([
  'price_change',
  'campaign_change',
  'promotion',
  'restock',
  'stockout',
]);

function parseDate(value: string, label: string): number {
  if (!DATE_PATTERN.test(value)) throw new Error(`${label} must use YYYY-MM-DD.`);
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a valid calendar date.`);
  }
  return parsed;
}

function assertIanaTimezone(value: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
  } catch {
    throw new Error('descriptor.businessTimezone must be an IANA timezone.');
  }
}

function inclusiveDates(start: string, end: string): string[] {
  const startMs = parseDate(start, 'coverage.start');
  const endMs = parseDate(end, 'coverage.end');
  if (startMs > endMs) throw new Error('coverage.start must not be after coverage.end.');
  const output: string[] = [];
  for (let current = startMs; current <= endMs; current += 86_400_000) {
    output.push(new Date(current).toISOString().slice(0, 10));
  }
  return output;
}

function assertDescriptor(descriptor: CommerceSourceDescriptorV1): void {
  if (descriptor.contractVersion !== COMMERCE_DATA_CONTRACT_VERSION) {
    throw new Error(`Unsupported Commerce data contract: ${descriptor.contractVersion}.`);
  }
  if (!SHA256_PATTERN.test(descriptor.sourceSha256)) {
    throw new Error('descriptor.sourceSha256 must be a prefixed SHA-256 digest.');
  }
  if (!/^[A-Z]{3}$/u.test(descriptor.currencyCode)) {
    throw new Error('descriptor.currencyCode must be an ISO-4217 code.');
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(descriptor.adapterVersion)) {
    throw new Error('descriptor.adapterVersion must be semantic version text.');
  }
  if (!descriptor.sourceId.trim() || !descriptor.sourceUri.trim() || !descriptor.sourceRevision.trim()) {
    throw new Error('Source descriptor identity fields must be non-empty.');
  }
  if (!descriptor.license.id.trim() || !descriptor.license.uri.trim()) {
    throw new Error('Source descriptor license identity must be explicit.');
  }
  assertIanaTimezone(descriptor.businessTimezone);
  for (const metric of COMMERCE_FLAGSHIP_METRICS) {
    if (descriptor.capabilities.metrics[metric] === 'unavailable') {
      throw new Error(`Flagship metric capability is unavailable: ${metric}.`);
    }
  }
  for (const dimension of COMMERCE_FLAGSHIP_DIMENSIONS) {
    if (descriptor.capabilities.dimensions[dimension] === 'unavailable') {
      throw new Error(`Flagship dimension capability is unavailable: ${dimension}.`);
    }
  }
  if (
    descriptor.capabilities.reconciliation.visitsToOrders === 'unavailable'
    || descriptor.capabilities.reconciliation.ordersToGmv === 'unavailable'
  ) {
    throw new Error('Flagship KPI-tree reconciliation must be available.');
  }
  const hasDerivedCapability = [
    ...Object.values(descriptor.capabilities.metrics),
    ...Object.values(descriptor.capabilities.dimensions),
  ].includes('derived');
  if (
    hasDerivedCapability
    && (
      descriptor.fixtureSeed === null
      || !Number.isSafeInteger(descriptor.fixtureSeed)
      || !descriptor.lineage.algorithm.trim()
      || !descriptor.lineage.algorithmVersion.trim()
      || descriptor.lineage.generatedFields.length === 0
      || descriptor.lineage.steps.length === 0
    )
  ) {
    throw new Error('Derived capabilities require a seed and explicit lineage.');
  }
}

function assertIntegerMetric(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function assertRecord(
  record: CommerceContractRecordV1,
  descriptor: CommerceSourceDescriptorV1,
  allowedDates: Set<string>,
  rowNumber: number,
): void {
  const prefix = `records[${rowNumber}]`;
  parseDate(record.metric_date, `${prefix}.metric_date`);
  if (!allowedDates.has(record.metric_date)) {
    throw new Error(`${prefix}.metric_date is outside the declared coverage.`);
  }
  for (const dimension of COMMERCE_FLAGSHIP_DIMENSIONS) {
    const sourceField = dimension === 'sku' ? 'sku' : dimension;
    const value = record[sourceField];
    if (typeof value !== 'string' || !value.trim() || value.length > 120) {
      throw new Error(`${prefix}.${sourceField} is invalid.`);
    }
  }
  if (record.business_timezone !== descriptor.businessTimezone) {
    throw new Error(`${prefix}.business_timezone differs from the source descriptor.`);
  }
  if (record.currency_code !== descriptor.currencyCode) {
    throw new Error(`${prefix}.currency_code differs from the source descriptor.`);
  }
  if (!['snapshot', 'incremental'].includes(record.data_mode)) {
    throw new Error(`${prefix}.data_mode is invalid.`);
  }
  assertIntegerMetric(record.visits, `${prefix}.visits`);
  assertIntegerMetric(record.paid_orders, `${prefix}.paid_orders`);
  assertIntegerMetric(record.units, `${prefix}.units`);
  if (record.paid_orders > record.visits) {
    throw new Error(`${prefix}.paid_orders cannot exceed visits.`);
  }
  if (
    !Number.isFinite(record.gmv)
    || record.gmv < 0
    || !Number.isSafeInteger(Math.round(record.gmv * 100))
    || Math.abs(Math.round(record.gmv * 100) - record.gmv * 100) > 1e-8
  ) {
    throw new Error(`${prefix}.gmv must be non-negative with at most two decimals.`);
  }
  if (
    record.available_metrics.length !== COMMERCE_FLAGSHIP_METRICS.length
    || COMMERCE_FLAGSHIP_METRICS.some((metric) => !record.available_metrics.includes(metric))
  ) {
    throw new Error(`${prefix}.available_metrics does not expose the flagship contract.`);
  }
  if (!Number.isFinite(Date.parse(record.source_updated_at))) {
    throw new Error(`${prefix}.source_updated_at must be an ISO timestamp.`);
  }
}

function assertBusinessEvents(snapshot: CommerceSourceSnapshotV1, virtualAsOf: number): void {
  if (!Array.isArray(snapshot.businessEvents)) {
    throw new Error('businessEvents must be an array, including when no events exist.');
  }
  if (
    snapshot.businessEvents.length > 0
    && snapshot.descriptor.capabilities.optional.businessEvents === 'unavailable'
  ) {
    throw new Error('Snapshot contains business events while its capability is unavailable.');
  }
  const eventIds = new Set<string>();
  snapshot.businessEvents.forEach((event, index) => {
    const prefix = `businessEvents[${index}]`;
    if (!event.eventId.trim() || event.eventId.length > 160) {
      throw new Error(`${prefix}.eventId is invalid.`);
    }
    if (eventIds.has(event.eventId)) {
      throw new Error(`Duplicate business event: ${event.eventId}.`);
    }
    eventIds.add(event.eventId);
    if (!BUSINESS_EVENT_TYPES.has(event.eventType)) {
      throw new Error(`${prefix}.eventType is invalid.`);
    }
    const occurredAt = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredAt) || occurredAt > virtualAsOf) {
      throw new Error(`${prefix}.occurredAt must be an ISO instant at or before virtualAsOf.`);
    }
    if (!event.scope || typeof event.scope !== 'object' || Array.isArray(event.scope)) {
      throw new Error(`${prefix}.scope must be an object.`);
    }
    for (const [dimension, value] of Object.entries(event.scope)) {
      if (!COMMERCE_FLAGSHIP_DIMENSIONS.includes(dimension as CommerceFlagshipDimension)) {
        throw new Error(`${prefix}.scope contains an unsupported dimension.`);
      }
      if (typeof value !== 'string' || !value.trim() || value.length > 120) {
        throw new Error(`${prefix}.scope.${dimension} is invalid.`);
      }
    }
    if (!event.source.trim() || event.source.length > 240) {
      throw new Error(`${prefix}.source is invalid.`);
    }
    if (!Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1) {
      throw new Error(`${prefix}.confidence must be between zero and one.`);
    }
    if (typeof event.scenarioMetadata !== 'boolean') {
      throw new Error(`${prefix}.scenarioMetadata must be boolean.`);
    }
    if (snapshot.descriptor.sourceKind === 'public_snapshot' && !event.scenarioMetadata) {
      throw new Error('Public snapshot business events must be labelled as scenario metadata.');
    }
  });
}

/** Fail-closed structural validation used before a snapshot reaches Agent Core. */
export function validateCommerceSourceSnapshotV1(snapshot: CommerceSourceSnapshotV1): void {
  if (snapshot.contractVersion !== COMMERCE_DATA_CONTRACT_VERSION) {
    throw new Error(`Unsupported Commerce snapshot contract: ${snapshot.contractVersion}.`);
  }
  assertDescriptor(snapshot.descriptor);
  const dates = inclusiveDates(snapshot.coverage.start, snapshot.coverage.end);
  if (dates.length < 90) throw new Error('Flagship snapshots require at least 90 complete days.');
  const sourceWatermark = Date.parse(snapshot.coverage.sourceWatermark);
  if (!Number.isFinite(sourceWatermark)) {
    throw new Error('coverage.sourceWatermark must be an ISO timestamp.');
  }
  const virtualAsOf = Date.parse(snapshot.coverage.virtualAsOf);
  if (!Number.isFinite(virtualAsOf)) {
    throw new Error('coverage.virtualAsOf must be an ISO timestamp.');
  }
  if (sourceWatermark > virtualAsOf) {
    throw new Error('coverage.sourceWatermark cannot be in the virtual future.');
  }
  assertBusinessEvents(snapshot, virtualAsOf);
  const expectedDates = new Set(dates);
  const partitions = new Map(snapshot.partitions.map((partition) => [partition.date, partition]));
  if (partitions.size !== snapshot.partitions.length || partitions.size !== expectedDates.size) {
    throw new Error('Snapshot partitions must contain each coverage date exactly once.');
  }
  for (const date of dates) {
    const partition = partitions.get(date);
    if (!partition || partition.completeness !== 'ready') {
      throw new Error(`Required partition ${date} is not ready.`);
    }
    assertIntegerMetric(partition.factRowCount, `partition ${date} factRowCount`);
    if (!Number.isFinite(Date.parse(partition.sourceWatermark))) {
      throw new Error(`partition ${date} has an invalid sourceWatermark.`);
    }
  }
  const keys = new Set<string>();
  const categoryBySku = new Map<string, string>();
  const recordsByDate = new Map<string, number>();
  const nonPlaceholderCounts = new Map<CommerceFlagshipDimension, number>(
    COMMERCE_FLAGSHIP_DIMENSIONS.map((dimension) => [dimension, 0]),
  );
  snapshot.records.forEach((record, index) => {
    assertRecord(record, snapshot.descriptor, expectedDates, index);
    const key = [record.metric_date, record.region, record.channel, record.sku].join('\u001f');
    if (keys.has(key)) throw new Error(`Duplicate Commerce primary key: ${key}.`);
    keys.add(key);
    const existingCategory = categoryBySku.get(record.sku);
    if (existingCategory && existingCategory !== record.category) {
      throw new Error(`SKU ${record.sku} maps to multiple categories in one snapshot.`);
    }
    categoryBySku.set(record.sku, record.category);
    recordsByDate.set(record.metric_date, (recordsByDate.get(record.metric_date) || 0) + 1);
    for (const dimension of COMMERCE_FLAGSHIP_DIMENSIONS) {
      const value = record[dimension].trim().toLowerCase();
      if (!PLACEHOLDER_DIMENSIONS.has(value)) {
        nonPlaceholderCounts.set(dimension, (nonPlaceholderCounts.get(dimension) || 0) + 1);
      }
    }
  });
  for (const date of dates) {
    const observed = recordsByDate.get(date) || 0;
    const declared = partitions.get(date)?.factRowCount;
    if (declared !== observed) {
      throw new Error(`Partition ${date} declares ${declared} rows but contains ${observed}.`);
    }
  }
  for (const dimension of COMMERCE_FLAGSHIP_DIMENSIONS) {
    const coverage = snapshot.records.length
      ? (nonPlaceholderCounts.get(dimension) || 0) / snapshot.records.length
      : 0;
    if (coverage < 0.95) {
      throw new Error(`Dimension ${dimension} non-placeholder coverage is below 95%.`);
    }
  }
}
