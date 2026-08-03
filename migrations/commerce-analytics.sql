BEGIN;

CREATE TABLE IF NOT EXISTS commerce_daily_metrics (
  tenant_id         TEXT          NOT NULL,
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
  PRIMARY KEY (tenant_id, metric_date, region, channel, sku)
);

ALTER TABLE commerce_daily_metrics
  ADD COLUMN IF NOT EXISTS available_metrics TEXT[] NOT NULL DEFAULT ARRAY[
    'visits', 'paid_orders', 'units', 'gmv', 'refund_orders', 'refund_amount',
    'cost_amount', 'ad_spend', 'new_customers', 'stockout_hours', 'ending_inventory'
  ]::text[];
ALTER TABLE commerce_daily_metrics
  ADD COLUMN IF NOT EXISTS business_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE commerce_daily_metrics
  ADD COLUMN IF NOT EXISTS data_mode TEXT NOT NULL DEFAULT 'snapshot';

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

ALTER TABLE commerce_daily_metrics
  VALIDATE CONSTRAINT commerce_daily_metrics_text_bounds;
ALTER TABLE commerce_daily_metrics
  VALIDATE CONSTRAINT commerce_daily_metrics_timezone_bounds;
ALTER TABLE commerce_daily_metrics
  VALIDATE CONSTRAINT commerce_daily_metrics_available_metrics;
ALTER TABLE commerce_daily_metrics
  VALIDATE CONSTRAINT commerce_daily_metrics_data_mode;

CREATE TABLE IF NOT EXISTS commerce_tenant_data_status (
  tenant_id         TEXT        PRIMARY KEY,
  coverage_start    DATE        NOT NULL,
  coverage_end      DATE        NOT NULL,
  last_ingested_at  TIMESTAMPTZ NOT NULL,
  fact_row_count    BIGINT      NOT NULL CHECK (fact_row_count >= 0),
  business_timezone TEXT        NOT NULL DEFAULT 'Asia/Shanghai',
  data_mode         TEXT        NOT NULL DEFAULT 'snapshot' CHECK (data_mode IN ('snapshot', 'incremental')),
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

  DELETE FROM public.commerce_entity_catalog
  WHERE tenant_id = p_tenant_id;

  INSERT INTO public.commerce_entity_catalog
    (tenant_id, dimension, value, fact_row_count, last_seen_date, refreshed_at)
  SELECT tenant_id, dimension, value, fact_row_count, last_seen_date, NOW()
  FROM (
    SELECT tenant_id, 'region'::text AS dimension, region AS value,
           COUNT(*)::bigint AS fact_row_count, MAX(metric_date) AS last_seen_date
    FROM public.commerce_daily_metrics
    WHERE tenant_id = p_tenant_id
    GROUP BY tenant_id, region
    UNION ALL
    SELECT tenant_id, 'channel', channel, COUNT(*)::bigint, MAX(metric_date)
    FROM public.commerce_daily_metrics
    WHERE tenant_id = p_tenant_id
    GROUP BY tenant_id, channel
    UNION ALL
    SELECT tenant_id, 'sku', sku, COUNT(*)::bigint, MAX(metric_date)
    FROM public.commerce_daily_metrics
    WHERE tenant_id = p_tenant_id
    GROUP BY tenant_id, sku
    UNION ALL
    SELECT tenant_id, 'category', category, COUNT(*)::bigint, MAX(metric_date)
    FROM public.commerce_daily_metrics
    WHERE tenant_id = p_tenant_id
    GROUP BY tenant_id, category
  ) catalog;

  DELETE FROM public.commerce_tenant_data_status
  WHERE tenant_id = p_tenant_id;

  INSERT INTO public.commerce_tenant_data_status
    (tenant_id, coverage_start, coverage_end, last_ingested_at, fact_row_count,
     business_timezone, data_mode, source_updated_at, available_metrics, refreshed_at)
  SELECT tenant_id, MIN(metric_date), MAX(metric_date), MAX(ingested_at), COUNT(*)::bigint,
         MIN(business_timezone),
         MIN(data_mode),
         MAX(source_updated_at),
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
  FROM public.commerce_daily_metrics
  WHERE tenant_id = p_tenant_id
  GROUP BY tenant_id;
END
$commerce_refresh$;

CREATE TABLE IF NOT EXISTS commerce_connector_checkpoints (
  tenant_id        TEXT        NOT NULL,
  connector_id     TEXT        NOT NULL,
  connector_version TEXT       NOT NULL,
  checkpoint       TEXT,
  source_sha256    TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, connector_id)
);

CREATE TABLE IF NOT EXISTS commerce_connector_runs (
  id                 TEXT        PRIMARY KEY,
  tenant_id          TEXT        NOT NULL,
  connector_id       TEXT        NOT NULL,
  connector_version  TEXT        NOT NULL,
  transport          TEXT        NOT NULL CHECK (transport IN ('file', 'https', 'shopify', 'olist')),
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
  DROP CONSTRAINT IF EXISTS commerce_connector_runs_transport_check;
ALTER TABLE commerce_connector_runs
  ADD CONSTRAINT commerce_connector_runs_transport_check
  CHECK (transport IN ('file', 'https', 'shopify', 'olist'));

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

COMMIT;
