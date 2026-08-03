-- Example analytics-plane grants. Run as the schema owner after commerce-analytics.sql.
-- Rename roles before production use if your platform uses different identifiers.

REVOKE ALL ON TABLE
  commerce_daily_metrics,
  commerce_tenant_data_status,
  commerce_entity_catalog,
  commerce_connector_checkpoints,
  commerce_connector_runs
FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO commerce_readonly_user, commerce_ingest_user, commerce_backup_user;

GRANT SELECT ON TABLE
  commerce_daily_metrics,
  commerce_tenant_data_status,
  commerce_entity_catalog,
  commerce_connector_checkpoints,
  commerce_connector_runs
TO commerce_readonly_user;
ALTER ROLE commerce_readonly_user
  SET default_transaction_read_only = on;

GRANT SELECT, INSERT, UPDATE ON TABLE commerce_daily_metrics TO commerce_ingest_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  commerce_tenant_data_status,
  commerce_entity_catalog,
  commerce_connector_checkpoints,
  commerce_connector_runs
TO commerce_ingest_user;
GRANT EXECUTE ON FUNCTION commerce_refresh_tenant_catalog(TEXT) TO commerce_ingest_user;

GRANT SELECT ON TABLE
  commerce_daily_metrics,
  commerce_tenant_data_status,
  commerce_entity_catalog,
  commerce_connector_checkpoints,
  commerce_connector_runs
TO commerce_backup_user;

ALTER ROLE commerce_readonly_user NOINHERIT NOBYPASSRLS;
ALTER ROLE commerce_ingest_user NOINHERIT NOBYPASSRLS;
ALTER ROLE commerce_backup_user NOINHERIT BYPASSRLS;
