const { createCompatibleFixtureSnapshot } = require('../data-contract/commerce-data-contract');

function localDate(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function moveDate(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function moveInstant(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function diagnosticRange(snapshot) {
  const date = localDate(snapshot.coverage.virtualAsOf, snapshot.descriptor.businessTimezone);
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  const start = moveDate(date, -(((weekday + 6) % 7) + 7));
  return { start, end: moveDate(start, 6) };
}

function selected(row, range, operation) {
  return row.metric_date >= range.start
    && row.metric_date <= range.end
    && (!operation.dimension || row[operation.dimension] === operation.value);
}

function scaleInteger(value, factor) {
  return Math.max(0, Math.round(value * factor));
}

function scaleMoney(value, factor) {
  return Math.round(value * 100 * factor) / 100;
}

function refreshCounts(snapshot) {
  const counts = snapshot.records.reduce((map, row) => (
    map.set(row.metric_date, (map.get(row.metric_date) || 0) + 1)
  ), new Map());
  snapshot.partitions.forEach((partition) => {
    if (partition.completeness === 'ready') partition.factRowCount = counts.get(partition.date) || 0;
  });
}

function applyHiddenOperation(snapshot, operation) {
  const range = diagnosticRange(snapshot);
  switch (operation.type) {
    case 'traffic_drop':
      snapshot.records.filter((row) => selected(row, range, operation)).forEach((row) => {
        row.visits = scaleInteger(row.visits, operation.factor);
        row.paid_orders = scaleInteger(row.paid_orders, operation.factor);
        row.units = scaleInteger(row.units, operation.factor);
        row.gmv = scaleMoney(row.gmv, operation.factor);
      });
      break;
    case 'conversion_drop':
      snapshot.records.filter((row) => selected(row, range, operation)).forEach((row) => {
        row.paid_orders = scaleInteger(row.paid_orders, operation.factor);
        row.units = scaleInteger(row.units, operation.factor);
        row.gmv = scaleMoney(row.gmv, operation.factor);
      });
      break;
    case 'aov_drop':
      snapshot.records.filter((row) => selected(row, range, operation)).forEach((row) => {
        row.gmv = scaleMoney(row.gmv, operation.factor);
      });
      break;
    case 'amount_scale':
      snapshot.records.forEach((row) => { row.gmv = scaleMoney(row.gmv, operation.factor); });
      break;
    case 'channel_swap':
      snapshot.records.forEach((row) => {
        if (row.channel === operation.left) row.channel = operation.right;
        else if (row.channel === operation.right) row.channel = operation.left;
      });
      break;
    case 'delete_partition': {
      const date = operation.date || range.start;
      snapshot.records = snapshot.records.filter((row) => row.metric_date !== date);
      const partition = snapshot.partitions.find((item) => item.date === date);
      if (partition) {
        partition.completeness = 'missing';
        partition.factRowCount = 0;
      }
      break;
    }
    case 'stale_partition': {
      const date = operation.date || range.start;
      const partition = snapshot.partitions.find((item) => item.date === date);
      if (partition) partition.completeness = 'stale';
      break;
    }
    case 'missing_capability':
      snapshot.descriptor.capabilities[operation.capabilityGroup || 'metrics'][operation.capability]
        = 'unavailable';
      break;
    case 'zero_day': {
      const date = operation.date || range.start;
      snapshot.records.filter((row) => row.metric_date === date).forEach((row) => {
        row.visits = 0;
        row.paid_orders = 0;
        row.units = 0;
        row.gmv = 0;
      });
      break;
    }
    case 'add_unrelated_sku': {
      const firstByDate = new Map();
      snapshot.records.forEach((row) => {
        if (!firstByDate.has(row.metric_date)) firstByDate.set(row.metric_date, row);
      });
      for (const [date, example] of firstByDate) {
        snapshot.records.push({
          ...example,
          metric_date: date,
          sku: operation.sku,
          category: operation.category || 'Unrelated',
          visits: 0,
          paid_orders: 0,
          units: 0,
          gmv: 0,
        });
      }
      snapshot.records.sort((left, right) => JSON.stringify([
        left.metric_date, left.region, left.channel, left.sku,
      ]).localeCompare(JSON.stringify([
        right.metric_date, right.region, right.channel, right.sku,
      ])));
      break;
    }
    case 'date_shift':
      snapshot.records.forEach((row) => {
        row.metric_date = moveDate(row.metric_date, operation.days);
        row.source_updated_at = moveInstant(row.source_updated_at, operation.days);
      });
      snapshot.partitions.forEach((partition) => {
        partition.date = moveDate(partition.date, operation.days);
        partition.sourceWatermark = moveInstant(partition.sourceWatermark, operation.days);
      });
      snapshot.coverage.start = moveDate(snapshot.coverage.start, operation.days);
      snapshot.coverage.end = moveDate(snapshot.coverage.end, operation.days);
      snapshot.coverage.sourceWatermark = moveInstant(snapshot.coverage.sourceWatermark, operation.days);
      snapshot.coverage.virtualAsOf = moveInstant(snapshot.coverage.virtualAsOf, operation.days);
      break;
    case 'business_event':
      snapshot.businessEvents.push({
        eventId: operation.eventId,
        eventType: operation.eventType,
        occurredAt: operation.occurredAt || `${range.start}T12:00:00.000Z`,
        scope: operation.scope || {},
        source: 'hidden_controlled_scenario_metadata',
        confidence: operation.confidence ?? 0.8,
        scenarioMetadata: true,
      });
      snapshot.descriptor.capabilities.optional.businessEvents = 'derived';
      break;
    case 'countervailing_mix': {
      const channels = [...new Set(snapshot.records.map((row) => row.channel))];
      applyHiddenOperation(snapshot, {
        type: 'traffic_drop', dimension: 'channel', value: channels[0], factor: operation.trafficFactor || 0.55,
      });
      applyHiddenOperation(snapshot, {
        type: 'aov_drop', dimension: 'channel', value: channels[1], factor: operation.aovFactor || 0.55,
      });
      break;
    }
    case 'guardrail_degrade':
    case 'no_op':
      break;
    default:
      throw new Error(`Unsupported hidden metamorphic operation: ${operation.type}.`);
  }
  refreshCounts(snapshot);
}

function createHiddenMetamorphicSnapshot(operations) {
  const snapshot = createCompatibleFixtureSnapshot();
  operations.forEach((operation) => applyHiddenOperation(snapshot, operation));
  return snapshot;
}

module.exports = {
  createHiddenMetamorphicSnapshot,
};
