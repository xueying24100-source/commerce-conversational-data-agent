-- Example analytics-plane grants. Run as the schema owner after commerce-analytics.sql.
-- Rename roles before production use if your platform uses different identifiers.

BEGIN;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

REVOKE ALL ON TABLE
  commerce_daily_metrics,
  commerce_tenant_data_status,
  commerce_tenant_data_partitions,
  commerce_entity_catalog,
  commerce_connector_source_facts,
  commerce_connector_date_coverage,
  commerce_connector_checkpoints,
  commerce_connector_runs
FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO commerce_readonly_user, commerce_ingest_user, commerce_backup_user;

GRANT SELECT ON TABLE
  commerce_daily_metrics,
  commerce_tenant_data_status,
  commerce_tenant_data_partitions,
  commerce_entity_catalog,
  commerce_connector_date_coverage,
  commerce_connector_checkpoints,
  commerce_connector_runs
TO commerce_readonly_user;
-- Snapshot replacement and empty-bucket reconciliation both require DELETE on the published
-- daily table. The tenant-scoped ingest RLS policy remains the enforcement boundary.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE commerce_daily_metrics TO commerce_ingest_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  commerce_connector_source_facts
TO commerce_ingest_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  commerce_tenant_data_status,
  commerce_tenant_data_partitions,
  commerce_entity_catalog,
  commerce_connector_date_coverage,
  commerce_connector_source_facts,
  commerce_connector_checkpoints,
  commerce_connector_runs
TO commerce_ingest_user;
REVOKE ALL ON FUNCTION public.commerce_refresh_tenant_catalog(TEXT)
FROM PUBLIC, commerce_readonly_user, commerce_ingest_user, commerce_backup_user;
GRANT EXECUTE ON FUNCTION public.commerce_refresh_tenant_catalog(TEXT) TO commerce_ingest_user;

GRANT SELECT ON TABLE
  commerce_daily_metrics,
  commerce_tenant_data_status,
  commerce_tenant_data_partitions,
  commerce_entity_catalog,
  commerce_connector_source_facts,
  commerce_connector_date_coverage,
  commerce_connector_checkpoints,
  commerce_connector_runs
TO commerce_backup_user;

COMMIT;
