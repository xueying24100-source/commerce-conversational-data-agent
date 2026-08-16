BEGIN;

CREATE TABLE IF NOT EXISTS commerce_daily_metrics (
  tenant_id         TEXT          NOT NULL,
  source_id         TEXT          NOT NULL,
  metric_date       DATE          NOT NULL,
  region            TEXT          NOT NULL,
  channel           TEXT          NOT NULL,
  sku               TEXT          NOT NULL,
  category          TEXT          NOT NULL,
  business_timezone TEXT          NOT NULL DEFAULT 'Asia/Shanghai',
  data_mode         TEXT          NOT NULL DEFAULT 'snapshot' CHECK (data_mode IN ('snapshot', 'incremental')),
  visits            BIGINT        NOT NULL CHECK (visits >= 0),
  paid_orders       BIGINT        NOT NULL CHECK (paid_orders >= 0),
  units             BIGINT        NOT NULL CHECK (units >= 0),
  gmv               NUMERIC(20,2) NOT NULL CHECK (gmv >= 0),
  refund_orders     BIGINT        NOT NULL CHECK (refund_orders >= 0),
  refund_amount     NUMERIC(20,2) NOT NULL CHECK (refund_amount >= 0),
  cost_amount       NUMERIC(20,2) NOT NULL CHECK (cost_amount >= 0),
  ad_spend          NUMERIC(20,2) NOT NULL CHECK (ad_spend >= 0),
  new_customers     BIGINT        NOT NULL CHECK (new_customers >= 0),
  stockout_hours    NUMERIC(12,2) NOT NULL CHECK (stockout_hours >= 0),
  ending_inventory  BIGINT        NOT NULL CHECK (ending_inventory >= 0),
  available_metrics TEXT[]        NOT NULL DEFAULT ARRAY[
    'visits', 'paid_orders', 'units', 'gmv', 'refund_orders', 'refund_amount',
    'cost_amount', 'ad_spend', 'new_customers', 'stockout_hours', 'ending_inventory'
  ]::text[],
  source_updated_at TIMESTAMPTZ   NOT NULL,
  ingested_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, source_id, metric_date, region, channel, sku)
);

ALTER TABLE commerce_daily_metrics
  ADD COLUMN IF NOT EXISTS source_id TEXT;
DO $commerce_source_id_backfill_required$
BEGIN
  IF EXISTS (SELECT 1 FROM commerce_daily_metrics WHERE source_id IS NULL LIMIT 1) THEN
    RAISE EXCEPTION
      'commerce_daily_metrics.source_id requires an explicit per-tenant backfill'
      USING ERRCODE = '23502',
            HINT = 'Backfill the connector/source identity; do not merge anonymous facts.';
  END IF;
END
$commerce_source_id_backfill_required$;
ALTER TABLE commerce_daily_metrics ALTER COLUMN source_id SET NOT NULL;
ALTER TABLE commerce_daily_metrics DROP CONSTRAINT IF EXISTS commerce_daily_metrics_pkey;
ALTER TABLE commerce_daily_metrics
  ADD CONSTRAINT commerce_daily_metrics_pkey
  PRIMARY KEY (tenant_id, source_id, metric_date, region, channel, sku);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_daily_metrics_serving_bucket_idx
  ON commerce_daily_metrics (tenant_id, metric_date, region, channel, sku);

ALTER TABLE commerce_daily_metrics
  ADD COLUMN IF NOT EXISTS available_metrics TEXT[] NOT NULL DEFAULT ARRAY[
    'visits', 'paid_orders', 'units', 'gmv', 'refund_orders', 'refund_amount',
    'cost_amount', 'ad_spend', 'new_customers', 'stockout_hours', 'ending_inventory'
  ]::text[];
ALTER TABLE commerce_daily_metrics
  ADD COLUMN IF NOT EXISTS business_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE commerce_daily_metrics
  ADD COLUMN IF NOT EXISTS data_mode TEXT NOT NULL DEFAULT 'snapshot';
ALTER TABLE commerce_daily_metrics
  ADD COLUMN IF NOT EXISTS currency_code TEXT;

-- Currency is semantic source data. Existing facts cannot be relabelled as CNY merely to
-- satisfy a new NOT NULL column: that would silently corrupt every non-CNY tenant (including
-- the built-in BRL Olist snapshot). Operators must explicitly backfill each legacy tenant
-- from its source contract before rerunning this migration.
DO $commerce_currency_backfill_required$
BEGIN
  IF EXISTS (
    SELECT 1 FROM commerce_daily_metrics WHERE currency_code IS NULL LIMIT 1
  ) THEN
    RAISE EXCEPTION
      'commerce_daily_metrics.currency_code requires an explicit per-tenant backfill before migration'
      USING ERRCODE = '23502',
            HINT = 'Backfill the real ISO 4217 currency for every legacy tenant; do not assume CNY.';
  END IF;
END
$commerce_currency_backfill_required$;

ALTER TABLE commerce_daily_metrics
  ALTER COLUMN currency_code SET DEFAULT 'CNY';
ALTER TABLE commerce_daily_metrics
  ALTER COLUMN currency_code SET NOT NULL;

CREATE INDEX IF NOT EXISTS commerce_daily_metrics_tenant_date_idx
  ON commerce_daily_metrics (tenant_id, metric_date DESC);
CREATE INDEX IF NOT EXISTS commerce_daily_metrics_tenant_sku_date_idx
  ON commerce_daily_metrics (tenant_id, sku, metric_date DESC);
CREATE INDEX IF NOT EXISTS commerce_daily_metrics_tenant_channel_date_idx
  ON commerce_daily_metrics (tenant_id, channel, metric_date DESC);
CREATE INDEX IF NOT EXISTS commerce_daily_metrics_ingested_at_idx
  ON commerce_daily_metrics (ingested_at DESC);
CREATE INDEX IF NOT EXISTS commerce_daily_metrics_tenant_ingested_at_idx
  ON commerce_daily_metrics (tenant_id, ingested_at DESC);

DO $commerce_migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'commerce_daily_metrics'::regclass
      AND conname = 'commerce_daily_metrics_text_bounds'
  ) THEN
    ALTER TABLE commerce_daily_metrics
      ADD CONSTRAINT commerce_daily_metrics_text_bounds
      CHECK (
        char_length(tenant_id) BETWEEN 1 AND 128
        AND char_length(region) BETWEEN 1 AND 120
        AND char_length(channel) BETWEEN 1 AND 120
        AND char_length(sku) BETWEEN 1 AND 120
        AND char_length(category) BETWEEN 1 AND 120
      ) NOT VALID;
  END IF;
END
$commerce_migration$;

DO $commerce_timezone_bounds$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'commerce_daily_metrics'::regclass
      AND conname = 'commerce_daily_metrics_timezone_bounds'
  ) THEN
    ALTER TABLE commerce_daily_metrics
      ADD CONSTRAINT commerce_daily_metrics_timezone_bounds
      CHECK (char_length(business_timezone) BETWEEN 1 AND 80) NOT VALID;
  END IF;
END
$commerce_timezone_bounds$;

DO $commerce_metric_availability$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'commerce_daily_metrics'::regclass
      AND conname = 'commerce_daily_metrics_available_metrics'
  ) THEN
    ALTER TABLE commerce_daily_metrics
      ADD CONSTRAINT commerce_daily_metrics_available_metrics CHECK (
        cardinality(available_metrics) > 0
        AND available_metrics <@ ARRAY[
          'visits', 'paid_orders', 'units', 'gmv', 'refund_orders', 'refund_amount',
          'cost_amount', 'ad_spend', 'new_customers', 'stockout_hours', 'ending_inventory'
        ]::text[]
      ) NOT VALID;
  END IF;
END
$commerce_metric_availability$;

DO $commerce_data_mode$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'commerce_daily_metrics'::regclass
      AND conname = 'commerce_daily_metrics_data_mode'
  ) THEN
    ALTER TABLE commerce_daily_metrics
      ADD CONSTRAINT commerce_daily_metrics_data_mode
      CHECK (data_mode IN ('snapshot', 'incremental')) NOT VALID;
  END IF;
END
$commerce_data_mode$;

DO $commerce_currency_code$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'commerce_daily_metrics'::regclass
      AND conname = 'commerce_daily_metrics_currency_code'
  ) THEN
    ALTER TABLE commerce_daily_metrics
      ADD CONSTRAINT commerce_daily_metrics_currency_code
      CHECK (currency_code ~ '^[A-Z]{3}$') NOT VALID;
  END IF;
END
$commerce_currency_code$;

ALTER TABLE commerce_daily_metrics
  VALIDATE CONSTRAINT commerce_daily_metrics_text_bounds;
ALTER TABLE commerce_daily_metrics
  VALIDATE CONSTRAINT commerce_daily_metrics_timezone_bounds;
ALTER TABLE commerce_daily_metrics
  VALIDATE CONSTRAINT commerce_daily_metrics_available_metrics;
ALTER TABLE commerce_daily_metrics
  VALIDATE CONSTRAINT commerce_daily_metrics_data_mode;
ALTER TABLE commerce_daily_metrics
  VALIDATE CONSTRAINT commerce_daily_metrics_currency_code;

CREATE TABLE IF NOT EXISTS commerce_tenant_data_status (
  tenant_id         TEXT        PRIMARY KEY,
  coverage_start    DATE        NOT NULL,
  coverage_end      DATE        NOT NULL,
  last_ingested_at  TIMESTAMPTZ NOT NULL,
  fact_row_count    BIGINT      NOT NULL CHECK (fact_row_count >= 0),
  business_timezone TEXT        NOT NULL DEFAULT 'Asia/Shanghai',
  data_mode         TEXT        NOT NULL DEFAULT 'snapshot' CHECK (data_mode IN ('snapshot', 'incremental')),
  currency_code     TEXT        NOT NULL DEFAULT 'CNY',
  source_updated_at TIMESTAMPTZ NOT NULL,
  available_metrics TEXT[]      NOT NULL DEFAULT ARRAY[
    'visits', 'paid_orders', 'units', 'gmv', 'refund_orders', 'refund_amount',
    'cost_amount', 'ad_spend', 'new_customers', 'stockout_hours', 'ending_inventory'
  ]::text[],
  refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (coverage_start <= coverage_end)
);

ALTER TABLE commerce_tenant_data_status
  ADD COLUMN IF NOT EXISTS available_metrics TEXT[] NOT NULL DEFAULT ARRAY[
    'visits', 'paid_orders', 'units', 'gmv', 'refund_orders', 'refund_amount',
    'cost_amount', 'ad_spend', 'new_customers', 'stockout_hours', 'ending_inventory'
  ]::text[];
ALTER TABLE commerce_tenant_data_status
  ADD COLUMN IF NOT EXISTS business_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE commerce_tenant_data_status
  ADD COLUMN IF NOT EXISTS data_mode TEXT NOT NULL DEFAULT 'snapshot';
ALTER TABLE commerce_tenant_data_status
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;
ALTER TABLE commerce_tenant_data_status
  ADD COLUMN IF NOT EXISTS currency_code TEXT;
ALTER TABLE commerce_tenant_data_status
  ADD COLUMN IF NOT EXISTS virtual_as_of TIMESTAMPTZ;

-- A status row may be derived only from a tenant whose facts already prove one currency.
UPDATE commerce_tenant_data_status AS status
SET currency_code = facts.currency_code
FROM (
  SELECT tenant_id, MIN(currency_code) AS currency_code
  FROM commerce_daily_metrics
  GROUP BY tenant_id
  HAVING COUNT(DISTINCT currency_code) = 1
) AS facts
WHERE status.tenant_id = facts.tenant_id
  AND status.currency_code IS NULL;

DO $commerce_status_currency_backfill_required$
BEGIN
  IF EXISTS (
    SELECT 1 FROM commerce_tenant_data_status WHERE currency_code IS NULL LIMIT 1
  ) THEN
    RAISE EXCEPTION
      'commerce_tenant_data_status.currency_code cannot be inferred from legacy facts'
      USING ERRCODE = '23502',
            HINT = 'Backfill or remove stale status rows after explicitly assigning fact currencies.';
  END IF;
END
$commerce_status_currency_backfill_required$;

ALTER TABLE commerce_tenant_data_status
  ALTER COLUMN currency_code SET DEFAULT 'CNY';
ALTER TABLE commerce_tenant_data_status
  ALTER COLUMN currency_code SET NOT NULL;

UPDATE commerce_tenant_data_status AS status
SET source_updated_at = COALESCE((
  SELECT MAX(fact.source_updated_at)
  FROM commerce_daily_metrics AS fact
  WHERE fact.tenant_id = status.tenant_id
), status.last_ingested_at)
WHERE status.source_updated_at IS NULL;

ALTER TABLE commerce_tenant_data_status
  ALTER COLUMN source_updated_at SET NOT NULL;

DO $commerce_status_data_mode$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'commerce_tenant_data_status'::regclass
      AND conname = 'commerce_tenant_data_status_data_mode'
  ) THEN
    ALTER TABLE commerce_tenant_data_status
      ADD CONSTRAINT commerce_tenant_data_status_data_mode
      CHECK (data_mode IN ('snapshot', 'incremental')) NOT VALID;
  END IF;
END
$commerce_status_data_mode$;

ALTER TABLE commerce_tenant_data_status
  VALIDATE CONSTRAINT commerce_tenant_data_status_data_mode;

DO $commerce_status_currency_code$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'commerce_tenant_data_status'::regclass
      AND conname = 'commerce_tenant_data_status_currency_code'
  ) THEN
    ALTER TABLE commerce_tenant_data_status
      ADD CONSTRAINT commerce_tenant_data_status_currency_code
      CHECK (currency_code ~ '^[A-Z]{3}$') NOT VALID;
  END IF;
END
$commerce_status_currency_code$;

ALTER TABLE commerce_tenant_data_status
  VALIDATE CONSTRAINT commerce_tenant_data_status_currency_code;

-- Immutable Source Adapter metadata is kept separately from serving facts so the public
-- historical Demo can expose upstream provenance, derived-field lineage and its controlled
-- business clock without relabelling generated fields as observed merchant data.
CREATE TABLE IF NOT EXISTS commerce_source_snapshots (
  tenant_id          TEXT        NOT NULL,
  source_id          TEXT        NOT NULL,
  snapshot_id        TEXT        NOT NULL,
  contract_version   TEXT        NOT NULL,
  adapter_id         TEXT        NOT NULL,
  adapter_version    TEXT        NOT NULL,
  upstream_source_id TEXT        NOT NULL,
  source_kind        TEXT        NOT NULL
    CHECK (source_kind IN ('public_snapshot', 'controlled_fixture', 'production_connector')),
  source_uri         TEXT        NOT NULL,
  source_revision    TEXT        NOT NULL,
  source_sha256      TEXT        NOT NULL CHECK (source_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  artifact_sha256    TEXT        NOT NULL CHECK (artifact_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  license            JSONB       NOT NULL CHECK (jsonb_typeof(license) = 'object'),
  fixture_seed       BIGINT,
  lineage            JSONB       NOT NULL CHECK (jsonb_typeof(lineage) = 'object'),
  capabilities       JSONB       NOT NULL CHECK (jsonb_typeof(capabilities) = 'object'),
  virtual_as_of      TIMESTAMPTZ NOT NULL,
  source_watermark   TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, source_id),
  CHECK (source_watermark <= virtual_as_of)
);

CREATE INDEX IF NOT EXISTS commerce_source_snapshots_tenant_clock_idx
  ON commerce_source_snapshots (tenant_id, virtual_as_of);

-- Optional operating events are evidence, never inferred dimensions or synthetic fact rows.
-- scenario_metadata=true is the durable disclosure used by public/controlled demonstrations.
CREATE TABLE IF NOT EXISTS commerce_business_events (
  tenant_id          TEXT             NOT NULL,
  source_id          TEXT             NOT NULL,
  event_id           TEXT             NOT NULL,
  event_type         TEXT             NOT NULL
    CHECK (event_type IN ('price_change', 'campaign_change', 'promotion', 'restock', 'stockout')),
  occurred_at        TIMESTAMPTZ      NOT NULL,
  scope              JSONB            NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  event_source       TEXT             NOT NULL,
  confidence         DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  scenario_metadata  BOOLEAN          NOT NULL,
  ingested_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, source_id, event_id)
);

CREATE INDEX IF NOT EXISTS commerce_business_events_tenant_time_idx
  ON commerce_business_events (tenant_id, occurred_at, event_type);

-- Per-date completeness replaces tenant-wide MAX(watermark) as the integrity signal. Existing
-- facts are deliberately backfilled as requiring verification; the next successful connector
-- transaction rebuilds these rows as ready together with the serving facts and catalog.
CREATE TABLE IF NOT EXISTS commerce_tenant_data_partitions (
  tenant_id         TEXT        NOT NULL,
  partition_date    DATE        NOT NULL,
  data_mode         TEXT        NOT NULL CHECK (data_mode IN ('snapshot', 'incremental')),
  fact_row_count    BIGINT      NOT NULL CHECK (fact_row_count >= 0),
  last_ingested_at  TIMESTAMPTZ NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  completeness_state TEXT       NOT NULL
    CHECK (completeness_state IN ('ready', 'backfill_required')),
  coverage_proof_kind TEXT,
  coverage_connector_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  coverage_run_ids TEXT[]       NOT NULL DEFAULT ARRAY[]::text[],
  refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, partition_date)
);

ALTER TABLE commerce_tenant_data_partitions
  ADD COLUMN IF NOT EXISTS coverage_proof_kind TEXT;
ALTER TABLE commerce_tenant_data_partitions
  ADD COLUMN IF NOT EXISTS coverage_connector_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE commerce_tenant_data_partitions
  ADD COLUMN IF NOT EXISTS coverage_run_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[];

-- Zero-row dates are explicit, verified business-calendar partitions. Recreate the original
-- auto-named constraint so databases that already ran the first partition migration accept them.
ALTER TABLE commerce_tenant_data_partitions
  DROP CONSTRAINT IF EXISTS commerce_tenant_data_partitions_fact_row_count_check;
ALTER TABLE commerce_tenant_data_partitions
  ADD CONSTRAINT commerce_tenant_data_partitions_fact_row_count_check
  CHECK (fact_row_count >= 0) NOT VALID;
ALTER TABLE commerce_tenant_data_partitions
  VALIDATE CONSTRAINT commerce_tenant_data_partitions_fact_row_count_check;

-- A ready date is valid only when it is bound to the connector scan(s) and run(s) that proved
-- the complete business day. Databases that ran an earlier facts-derived implementation are
-- deliberately downgraded; only a new successful connector transaction may promote them again.
UPDATE commerce_tenant_data_partitions
SET completeness_state = 'backfill_required'
WHERE completeness_state = 'ready'
  AND (
    coverage_proof_kind IS NULL
    OR cardinality(coverage_connector_ids) = 0
    OR cardinality(coverage_run_ids) = 0
  );

DO $commerce_partition_coverage_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'commerce_tenant_data_partitions'::regclass
      AND conname = 'commerce_tenant_data_partitions_coverage_proof_check'
  ) THEN
    ALTER TABLE commerce_tenant_data_partitions
      ADD CONSTRAINT commerce_tenant_data_partitions_coverage_proof_check
      CHECK (
        completeness_state = 'backfill_required'
        OR (
          coverage_proof_kind = 'connector_coverage_intersection'
          AND cardinality(coverage_connector_ids) > 0
          AND cardinality(coverage_connector_ids) = cardinality(coverage_run_ids)
        )
      ) NOT VALID;
  END IF;
END
$commerce_partition_coverage_proof$;
ALTER TABLE commerce_tenant_data_partitions
  VALIDATE CONSTRAINT commerce_tenant_data_partitions_coverage_proof_check;

INSERT INTO commerce_tenant_data_partitions
  (tenant_id, partition_date, data_mode, fact_row_count, last_ingested_at,
   source_updated_at, completeness_state, refreshed_at)
SELECT tenant_id, metric_date, MIN(data_mode), COUNT(*)::bigint, MAX(ingested_at),
       MAX(source_updated_at), 'backfill_required', NOW()
FROM commerce_daily_metrics
GROUP BY tenant_id, metric_date
ON CONFLICT (tenant_id, partition_date) DO NOTHING;

CREATE INDEX IF NOT EXISTS commerce_tenant_data_partitions_state_idx
  ON commerce_tenant_data_partitions (tenant_id, completeness_state, partition_date);

CREATE TABLE IF NOT EXISTS commerce_entity_catalog (
  tenant_id      TEXT        NOT NULL,
  dimension      TEXT        NOT NULL CHECK (dimension IN ('region', 'channel', 'sku', 'category')),
  value          TEXT        NOT NULL CHECK (char_length(value) BETWEEN 1 AND 120),
  fact_row_count BIGINT      NOT NULL CHECK (fact_row_count > 0),
  last_seen_date DATE        NOT NULL,
  refreshed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, dimension, value)
);

CREATE INDEX IF NOT EXISTS commerce_entity_catalog_lookup_idx
  ON commerce_entity_catalog (tenant_id, dimension, LOWER(value));
CREATE INDEX IF NOT EXISTS commerce_entity_catalog_rank_idx
  ON commerce_entity_catalog (tenant_id, dimension, fact_row_count DESC, value);
CREATE INDEX IF NOT EXISTS commerce_entity_catalog_prefix_idx
  ON commerce_entity_catalog (tenant_id, dimension, LOWER(value) text_pattern_ops);

ALTER TABLE commerce_daily_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_daily_metrics FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_tenant_data_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_tenant_data_status FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_entity_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_entity_catalog FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_tenant_data_partitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_tenant_data_partitions FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_source_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_source_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_business_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_business_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commerce_daily_metrics_tenant_select ON commerce_daily_metrics;
CREATE POLICY commerce_daily_metrics_tenant_select ON commerce_daily_metrics
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('commerce.tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_daily_metrics_ingest_insert ON commerce_daily_metrics;
CREATE POLICY commerce_daily_metrics_ingest_insert ON commerce_daily_metrics
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_daily_metrics_ingest_update ON commerce_daily_metrics;
CREATE POLICY commerce_daily_metrics_ingest_update ON commerce_daily_metrics
  FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_daily_metrics_ingest_delete ON commerce_daily_metrics;
CREATE POLICY commerce_daily_metrics_ingest_delete ON commerce_daily_metrics
  FOR DELETE
  USING (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));

DROP POLICY IF EXISTS commerce_tenant_data_status_tenant_select ON commerce_tenant_data_status;
CREATE POLICY commerce_tenant_data_status_tenant_select ON commerce_tenant_data_status
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('commerce.tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_tenant_data_status_ingest_insert ON commerce_tenant_data_status;
CREATE POLICY commerce_tenant_data_status_ingest_insert ON commerce_tenant_data_status
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_tenant_data_status_ingest_update ON commerce_tenant_data_status;
CREATE POLICY commerce_tenant_data_status_ingest_update ON commerce_tenant_data_status
  FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_tenant_data_status_ingest_delete ON commerce_tenant_data_status;
CREATE POLICY commerce_tenant_data_status_ingest_delete ON commerce_tenant_data_status
  FOR DELETE
  USING (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));

DROP POLICY IF EXISTS commerce_tenant_data_partitions_tenant_select ON commerce_tenant_data_partitions;
CREATE POLICY commerce_tenant_data_partitions_tenant_select ON commerce_tenant_data_partitions
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('commerce.tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_tenant_data_partitions_ingest_all ON commerce_tenant_data_partitions;
CREATE POLICY commerce_tenant_data_partitions_ingest_all ON commerce_tenant_data_partitions
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));

DROP POLICY IF EXISTS commerce_entity_catalog_tenant_select ON commerce_entity_catalog;
CREATE POLICY commerce_entity_catalog_tenant_select ON commerce_entity_catalog
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('commerce.tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_entity_catalog_ingest_insert ON commerce_entity_catalog;
CREATE POLICY commerce_entity_catalog_ingest_insert ON commerce_entity_catalog
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_entity_catalog_ingest_update ON commerce_entity_catalog;
CREATE POLICY commerce_entity_catalog_ingest_update ON commerce_entity_catalog
  FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_entity_catalog_ingest_delete ON commerce_entity_catalog;
CREATE POLICY commerce_entity_catalog_ingest_delete ON commerce_entity_catalog
  FOR DELETE
  USING (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));

DROP POLICY IF EXISTS commerce_source_snapshots_tenant_select ON commerce_source_snapshots;
CREATE POLICY commerce_source_snapshots_tenant_select ON commerce_source_snapshots
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('commerce.tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_source_snapshots_ingest_all ON commerce_source_snapshots;
CREATE POLICY commerce_source_snapshots_ingest_all ON commerce_source_snapshots
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));

DROP POLICY IF EXISTS commerce_business_events_tenant_select ON commerce_business_events;
CREATE POLICY commerce_business_events_tenant_select ON commerce_business_events
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('commerce.tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_business_events_ingest_all ON commerce_business_events;
CREATE POLICY commerce_business_events_ingest_all ON commerce_business_events
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));

CREATE OR REPLACE FUNCTION commerce_refresh_tenant_catalog(p_tenant_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $commerce_refresh$
BEGIN
  IF p_tenant_id IS NULL OR btrim(p_tenant_id) = '' THEN
    RAISE EXCEPTION 'tenant_id is required for commerce catalog refresh'
      USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT COUNT(DISTINCT business_timezone) > 1
    FROM public.commerce_daily_metrics
    WHERE tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'tenant % contains multiple business time zones', p_tenant_id
      USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT COUNT(DISTINCT data_mode) > 1
    FROM public.commerce_daily_metrics
    WHERE tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'tenant % contains multiple data modes', p_tenant_id
      USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT COUNT(DISTINCT currency_code) > 1
    FROM public.commerce_daily_metrics
    WHERE tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'tenant % contains multiple currency codes', p_tenant_id
      USING ERRCODE = '23514';
  END IF;

  DELETE FROM public.commerce_entity_catalog
  WHERE tenant_id = p_tenant_id;

  INSERT INTO public.commerce_entity_catalog
    (tenant_id, dimension, value, fact_row_count, last_seen_date, refreshed_at)
  SELECT tenant_id, dimension, value, fact_row_count, last_seen_date, NOW()
  FROM (
    SELECT facts.tenant_id, 'region'::text AS dimension, region AS value,
           COUNT(*)::bigint AS fact_row_count, MAX(metric_date) AS last_seen_date
    FROM public.commerce_daily_metrics AS facts
    JOIN public.commerce_tenant_data_partitions AS partitions
      ON partitions.tenant_id = facts.tenant_id
     AND partitions.partition_date = facts.metric_date
     AND partitions.completeness_state = 'ready'
    WHERE facts.tenant_id = p_tenant_id
    GROUP BY facts.tenant_id, region
    UNION ALL
    SELECT facts.tenant_id, 'channel', channel, COUNT(*)::bigint, MAX(metric_date)
    FROM public.commerce_daily_metrics AS facts
    JOIN public.commerce_tenant_data_partitions AS partitions
      ON partitions.tenant_id = facts.tenant_id
     AND partitions.partition_date = facts.metric_date
     AND partitions.completeness_state = 'ready'
    WHERE facts.tenant_id = p_tenant_id
    GROUP BY facts.tenant_id, channel
    UNION ALL
    SELECT facts.tenant_id, 'sku', sku, COUNT(*)::bigint, MAX(metric_date)
    FROM public.commerce_daily_metrics AS facts
    JOIN public.commerce_tenant_data_partitions AS partitions
      ON partitions.tenant_id = facts.tenant_id
     AND partitions.partition_date = facts.metric_date
     AND partitions.completeness_state = 'ready'
    WHERE facts.tenant_id = p_tenant_id
    GROUP BY facts.tenant_id, sku
    UNION ALL
    SELECT facts.tenant_id, 'category', category, COUNT(*)::bigint, MAX(metric_date)
    FROM public.commerce_daily_metrics AS facts
    JOIN public.commerce_tenant_data_partitions AS partitions
      ON partitions.tenant_id = facts.tenant_id
     AND partitions.partition_date = facts.metric_date
     AND partitions.completeness_state = 'ready'
    WHERE facts.tenant_id = p_tenant_id
    GROUP BY facts.tenant_id, category
  ) catalog;

  DELETE FROM public.commerce_tenant_data_status
  WHERE tenant_id = p_tenant_id;

  INSERT INTO public.commerce_tenant_data_status
    (tenant_id, coverage_start, coverage_end, last_ingested_at, fact_row_count,
     business_timezone, data_mode, currency_code, source_updated_at, virtual_as_of,
     available_metrics, refreshed_at)
  SELECT facts.tenant_id,
         MIN(coverage.coverage_start), MAX(coverage.coverage_end),
         MAX(coverage.last_ingested_at), COUNT(*)::bigint,
         MIN(facts.business_timezone),
         MIN(facts.data_mode),
         MIN(facts.currency_code),
         MAX(coverage.source_updated_at),
         CASE
           WHEN (
             SELECT COUNT(DISTINCT snapshots.source_id)
             FROM public.commerce_source_snapshots AS snapshots
             WHERE snapshots.tenant_id = p_tenant_id
           ) = (
             SELECT COUNT(DISTINCT all_facts.source_id)
             FROM public.commerce_daily_metrics AS all_facts
             WHERE all_facts.tenant_id = p_tenant_id
           )
           AND (
             SELECT COUNT(DISTINCT snapshots.virtual_as_of)
             FROM public.commerce_source_snapshots AS snapshots
             WHERE snapshots.tenant_id = p_tenant_id
           ) = 1
           THEN (
             SELECT MIN(snapshots.virtual_as_of)
             FROM public.commerce_source_snapshots AS snapshots
             WHERE snapshots.tenant_id = p_tenant_id
           )
           ELSE NULL
         END,
         ARRAY(
           SELECT candidate.metric
           FROM unnest(ARRAY[
             'visits', 'paid_orders', 'units', 'gmv', 'refund_orders', 'refund_amount',
             'cost_amount', 'ad_spend', 'new_customers', 'stockout_hours', 'ending_inventory'
           ]::text[]) AS candidate(metric)
           WHERE NOT EXISTS (
             SELECT 1 FROM public.commerce_daily_metrics AS unavailable
              WHERE unavailable.tenant_id = p_tenant_id
                AND NOT unavailable.available_metrics @> ARRAY[candidate.metric]::text[]
            )
            ORDER BY candidate.metric
          ),
          NOW()
  FROM public.commerce_daily_metrics AS facts
  JOIN public.commerce_tenant_data_partitions AS partitions
    ON partitions.tenant_id = facts.tenant_id
   AND partitions.partition_date = facts.metric_date
   AND partitions.completeness_state = 'ready'
  CROSS JOIN LATERAL (
    SELECT MIN(complete.partition_date) AS coverage_start,
           MAX(complete.partition_date) AS coverage_end,
           MAX(complete.last_ingested_at) AS last_ingested_at,
           MAX(complete.source_updated_at) AS source_updated_at
    FROM public.commerce_tenant_data_partitions AS complete
    WHERE complete.tenant_id = facts.tenant_id
      AND complete.completeness_state = 'ready'
  ) AS coverage
  WHERE facts.tenant_id = p_tenant_id
  GROUP BY facts.tenant_id
  HAVING MIN(coverage.coverage_start) IS NOT NULL;
END
$commerce_refresh$;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Catalog refresh mutates
-- tenant serving state, so only the explicitly provisioned ingest role may receive it later.
REVOKE ALL ON FUNCTION public.commerce_refresh_tenant_catalog(TEXT) FROM PUBLIC;

-- Order/refund-line-level staging facts for incremental connectors (currently Shopify).
-- Each source line is upserted independently by its stable source_line_id, so a run that
-- only touches a partial window of orders never loses history for a shared daily bucket:
-- commerce_daily_metrics for the affected buckets is recomputed from the full staged
-- history here, not from the current run's window alone.
CREATE TABLE IF NOT EXISTS commerce_connector_source_facts (
  tenant_id         TEXT          NOT NULL,
  connector_id      TEXT          NOT NULL,
  source_entity_id  TEXT          NOT NULL
    CONSTRAINT commerce_connector_source_facts_entity_id_check
    CHECK (char_length(source_entity_id) BETWEEN 1 AND 200),
  source_line_id    TEXT          NOT NULL CHECK (char_length(source_line_id) BETWEEN 1 AND 200),
  metric_date       DATE          NOT NULL,
  region            TEXT          NOT NULL,
  channel           TEXT          NOT NULL,
  sku               TEXT          NOT NULL,
  category          TEXT          NOT NULL,
  business_timezone TEXT          NOT NULL,
  currency_code     TEXT          NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  paid_orders       BIGINT        NOT NULL DEFAULT 0 CHECK (paid_orders >= 0),
  units             BIGINT        NOT NULL DEFAULT 0 CHECK (units >= 0),
  gmv               NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (gmv >= 0),
  refund_amount     NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  source_updated_at TIMESTAMPTZ   NOT NULL,
  ingested_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, connector_id, source_line_id)
);

-- Compatibility for databases that briefly ran the first source-fact staging migration.
-- New writes always supply the Shopify order id explicitly. Existing order facts can be
-- recovered exactly; known Shopify refund ids embed the order GID before the refund GID.
ALTER TABLE commerce_connector_source_facts
  ADD COLUMN IF NOT EXISTS source_entity_id TEXT;
UPDATE commerce_connector_source_facts
SET source_entity_id = CASE
  WHEN source_line_id LIKE 'order:%' THEN SUBSTRING(source_line_id FROM 7)
  WHEN source_line_id ~ '^refund:gid://shopify/Order/[^:]+:'
    THEN SUBSTRING(source_line_id FROM '^refund:(gid://shopify/Order/[^:]+):')
  ELSE source_line_id
END
WHERE source_entity_id IS NULL;
ALTER TABLE commerce_connector_source_facts
  ALTER COLUMN source_entity_id SET NOT NULL;

DO $commerce_source_entity_id$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'commerce_connector_source_facts'::regclass
      AND conname = 'commerce_connector_source_facts_entity_id_check'
  ) THEN
    ALTER TABLE commerce_connector_source_facts
      ADD CONSTRAINT commerce_connector_source_facts_entity_id_check
      CHECK (char_length(source_entity_id) BETWEEN 1 AND 200) NOT VALID;
  END IF;
END
$commerce_source_entity_id$;
ALTER TABLE commerce_connector_source_facts
  VALIDATE CONSTRAINT commerce_connector_source_facts_entity_id_check;

CREATE INDEX IF NOT EXISTS commerce_connector_source_facts_bucket_idx
  ON commerce_connector_source_facts (tenant_id, connector_id, metric_date, region, channel, sku);
CREATE INDEX IF NOT EXISTS commerce_connector_source_facts_entity_idx
  ON commerce_connector_source_facts (tenant_id, connector_id, source_entity_id);

ALTER TABLE commerce_connector_source_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_connector_source_facts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commerce_connector_source_facts_tenant_select ON commerce_connector_source_facts;
CREATE POLICY commerce_connector_source_facts_tenant_select ON commerce_connector_source_facts
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('commerce.tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_connector_source_facts_ingest_all ON commerce_connector_source_facts;
CREATE POLICY commerce_connector_source_facts_ingest_all ON commerce_connector_source_facts
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));

CREATE TABLE IF NOT EXISTS commerce_connector_checkpoints (
  tenant_id        TEXT        NOT NULL,
  connector_id     TEXT        NOT NULL,
  connector_version TEXT       NOT NULL,
  data_mode        TEXT        NOT NULL
    CONSTRAINT commerce_connector_checkpoints_data_mode_check
    CHECK (data_mode IN ('snapshot', 'incremental')),
  source_fact_state TEXT       NOT NULL
    CONSTRAINT commerce_connector_checkpoints_source_fact_state_check
    CHECK (source_fact_state IN ('not_applicable', 'bootstrap_required', 'ready')),
  checkpoint       TEXT,
  source_sha256    TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, connector_id)
);

ALTER TABLE commerce_connector_checkpoints
  ADD COLUMN IF NOT EXISTS data_mode TEXT NOT NULL DEFAULT 'snapshot';
ALTER TABLE commerce_connector_checkpoints
  ALTER COLUMN data_mode SET DEFAULT 'snapshot';
ALTER TABLE commerce_connector_checkpoints
  ADD COLUMN IF NOT EXISTS source_fact_state TEXT NOT NULL DEFAULT 'not_applicable';
ALTER TABLE commerce_connector_checkpoints
  ALTER COLUMN source_fact_state SET DEFAULT 'not_applicable';
-- Backfill connectors created before the mode column from staged facts. A second pass after
-- commerce_connector_runs exists below also recognizes old Shopify checkpoints whose staging
-- facts have not been populated yet.
UPDATE commerce_connector_checkpoints AS checkpoint
SET data_mode = 'incremental',
    source_fact_state = CASE
      WHEN checkpoint.source_fact_state = 'ready' THEN 'ready'
      ELSE 'bootstrap_required'
    END
WHERE EXISTS (
  SELECT 1
  FROM commerce_connector_source_facts AS fact
  WHERE fact.tenant_id = checkpoint.tenant_id
    AND fact.connector_id = checkpoint.connector_id
);

DO $commerce_checkpoint_data_mode$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'commerce_connector_checkpoints'::regclass
      AND conname = 'commerce_connector_checkpoints_data_mode_check'
  ) THEN
    ALTER TABLE commerce_connector_checkpoints
      ADD CONSTRAINT commerce_connector_checkpoints_data_mode_check
      CHECK (data_mode IN ('snapshot', 'incremental')) NOT VALID;
  END IF;
END
$commerce_checkpoint_data_mode$;
ALTER TABLE commerce_connector_checkpoints
  VALIDATE CONSTRAINT commerce_connector_checkpoints_data_mode_check;

DO $commerce_checkpoint_source_fact_state$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'commerce_connector_checkpoints'::regclass
      AND conname = 'commerce_connector_checkpoints_source_fact_state_check'
  ) THEN
    ALTER TABLE commerce_connector_checkpoints
      ADD CONSTRAINT commerce_connector_checkpoints_source_fact_state_check
      CHECK (source_fact_state IN ('not_applicable', 'bootstrap_required', 'ready')) NOT VALID;
  END IF;
END
$commerce_checkpoint_source_fact_state$;
ALTER TABLE commerce_connector_checkpoints
  VALIDATE CONSTRAINT commerce_connector_checkpoints_source_fact_state_check;

CREATE TABLE IF NOT EXISTS commerce_connector_runs (
  id                 TEXT        PRIMARY KEY,
  tenant_id          TEXT        NOT NULL,
  connector_id       TEXT        NOT NULL,
  connector_version  TEXT        NOT NULL,
  transport          TEXT        NOT NULL CHECK (
    transport IN ('file', 'https', 'shopify', 'olist', 'commerce_fixture')
  ),
  status             TEXT        NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  checkpoint_before  TEXT,
  checkpoint_after   TEXT,
  source_sha256      TEXT,
  source_rows        INTEGER     NOT NULL DEFAULT 0 CHECK (source_rows >= 0),
  rejected_rows      INTEGER     NOT NULL DEFAULT 0 CHECK (rejected_rows >= 0),
  imported_rows      INTEGER     NOT NULL DEFAULT 0 CHECK (imported_rows >= 0),
  error_code         TEXT,
  error_message      TEXT,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ
);

ALTER TABLE commerce_connector_runs
  ADD COLUMN IF NOT EXISTS source_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commerce_connector_runs
  ADD COLUMN IF NOT EXISTS rejected_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commerce_connector_runs
  ADD COLUMN IF NOT EXISTS coverage_start DATE;
ALTER TABLE commerce_connector_runs
  ADD COLUMN IF NOT EXISTS coverage_end DATE;
ALTER TABLE commerce_connector_runs
  ADD COLUMN IF NOT EXISTS coverage_proof_kind TEXT;

DO $commerce_connector_run_coverage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'commerce_connector_runs'::regclass
      AND conname = 'commerce_connector_runs_coverage_check'
  ) THEN
    ALTER TABLE commerce_connector_runs
      ADD CONSTRAINT commerce_connector_runs_coverage_check
      CHECK (
        (coverage_start IS NULL AND coverage_end IS NULL AND coverage_proof_kind IS NULL)
        OR (
          coverage_start IS NULL
          AND coverage_end IS NOT NULL
          AND coverage_proof_kind = 'coordinated_incremental_scan'
        )
        OR (
          coverage_start IS NOT NULL
          AND coverage_end IS NOT NULL
          AND coverage_start <= coverage_end
          AND coverage_proof_kind IN (
            'complete_snapshot', 'full_history_reconciliation', 'coordinated_incremental_scan'
          )
        )
      ) NOT VALID;
  END IF;
END
$commerce_connector_run_coverage$;
ALTER TABLE commerce_connector_runs
  VALIDATE CONSTRAINT commerce_connector_runs_coverage_check;

UPDATE commerce_connector_checkpoints AS checkpoint
SET data_mode = 'incremental',
    source_fact_state = CASE
      WHEN checkpoint.source_fact_state = 'ready' THEN 'ready'
      ELSE 'bootstrap_required'
    END
WHERE EXISTS (
  SELECT 1
  FROM commerce_connector_runs AS run
  WHERE run.tenant_id = checkpoint.tenant_id
    AND run.connector_id = checkpoint.connector_id
    AND run.transport = 'shopify'
);

ALTER TABLE commerce_connector_runs
  DROP CONSTRAINT IF EXISTS commerce_connector_runs_transport_check;
ALTER TABLE commerce_connector_runs
  ADD CONSTRAINT commerce_connector_runs_transport_check
  CHECK (transport IN ('file', 'https', 'shopify', 'olist', 'commerce_fixture'));

DO $commerce_connector_row_counts$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'commerce_connector_runs'::regclass
      AND conname = 'commerce_connector_runs_row_counts_check'
  ) THEN
    ALTER TABLE commerce_connector_runs
      ADD CONSTRAINT commerce_connector_runs_row_counts_check
      CHECK (source_rows >= 0 AND rejected_rows >= 0 AND imported_rows >= 0) NOT VALID;
  END IF;
END
$commerce_connector_row_counts$;
ALTER TABLE commerce_connector_runs
  VALIDATE CONSTRAINT commerce_connector_runs_row_counts_check;

CREATE INDEX IF NOT EXISTS commerce_connector_runs_tenant_idx
  ON commerce_connector_runs (tenant_id, connector_id, started_at DESC);
CREATE TABLE IF NOT EXISTS commerce_connector_date_coverage (
  tenant_id         TEXT        NOT NULL,
  connector_id      TEXT        NOT NULL,
  partition_date    DATE        NOT NULL,
  run_id            TEXT        NOT NULL,
  proof_kind        TEXT        NOT NULL
    CHECK (proof_kind IN (
      'complete_snapshot', 'full_history_reconciliation', 'coordinated_incremental_scan'
    )),
  source_updated_at TIMESTAMPTZ NOT NULL,
  proved_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, connector_id, partition_date)
);

ALTER TABLE commerce_connector_date_coverage
  DROP CONSTRAINT IF EXISTS commerce_connector_date_coverage_proof_kind_check;
ALTER TABLE commerce_connector_date_coverage
  ADD CONSTRAINT commerce_connector_date_coverage_proof_kind_check
  CHECK (proof_kind IN (
    'complete_snapshot', 'full_history_reconciliation', 'coordinated_incremental_scan'
  )) NOT VALID;
ALTER TABLE commerce_connector_date_coverage
  VALIDATE CONSTRAINT commerce_connector_date_coverage_proof_kind_check;

CREATE INDEX IF NOT EXISTS commerce_connector_date_coverage_tenant_date_idx
  ON commerce_connector_date_coverage (tenant_id, partition_date, connector_id);

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, connector_id
           ORDER BY started_at DESC, id DESC
         ) AS position
  FROM commerce_connector_runs
  WHERE status = 'running'
)
UPDATE commerce_connector_runs AS run
  SET status = 'failed', error_code = 'CONNECTOR_CONCURRENCY_RECONCILED',
      error_message = 'Duplicate active connector run reconciled by migration.',
      completed_at = NOW()
  FROM ranked
  WHERE run.id = ranked.id AND ranked.position > 1;
CREATE UNIQUE INDEX IF NOT EXISTS commerce_connector_runs_active_idx
  ON commerce_connector_runs (tenant_id, connector_id)
  WHERE status = 'running';

ALTER TABLE commerce_connector_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_connector_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_connector_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_connector_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_connector_date_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_connector_date_coverage FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commerce_connector_checkpoints_tenant_select ON commerce_connector_checkpoints;
CREATE POLICY commerce_connector_checkpoints_tenant_select ON commerce_connector_checkpoints
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('commerce.tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_connector_checkpoints_ingest_all ON commerce_connector_checkpoints;
CREATE POLICY commerce_connector_checkpoints_ingest_all ON commerce_connector_checkpoints
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));

DROP POLICY IF EXISTS commerce_connector_runs_tenant_select ON commerce_connector_runs;
CREATE POLICY commerce_connector_runs_tenant_select ON commerce_connector_runs
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('commerce.tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_connector_runs_ingest_all ON commerce_connector_runs;
CREATE POLICY commerce_connector_runs_ingest_all ON commerce_connector_runs
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));

DROP POLICY IF EXISTS commerce_connector_date_coverage_tenant_select
  ON commerce_connector_date_coverage;
CREATE POLICY commerce_connector_date_coverage_tenant_select
  ON commerce_connector_date_coverage
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('commerce.tenant_id', true), ''));
DROP POLICY IF EXISTS commerce_connector_date_coverage_ingest_all
  ON commerce_connector_date_coverage;
CREATE POLICY commerce_connector_date_coverage_ingest_all
  ON commerce_connector_date_coverage
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('commerce.ingest_tenant_id', true), ''));

COMMIT;
