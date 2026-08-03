-- Example control-plane grants. Run as the schema owner after commerce-control.sql.
-- Rename roles before production use if your platform uses different identifiers.

REVOKE ALL ON TABLE
  commerce_agent_conversations,
  commerce_agent_messages,
  commerce_agent_runs,
  commerce_agent_evidence,
  commerce_agent_rate_limits,
  commerce_agent_jobs,
  commerce_agent_job_events,
  commerce_agent_workers
FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO commerce_control_user, commerce_maintenance_user, commerce_backup_user;

GRANT SELECT, INSERT, UPDATE ON TABLE
  commerce_agent_conversations,
  commerce_agent_runs,
  commerce_agent_rate_limits,
  commerce_agent_jobs,
  commerce_agent_workers
TO commerce_control_user;
GRANT SELECT, INSERT ON TABLE
  commerce_agent_messages,
  commerce_agent_evidence,
  commerce_agent_job_events
TO commerce_control_user;
GRANT USAGE, SELECT ON SEQUENCE commerce_agent_job_events_id_seq TO commerce_control_user;

GRANT SELECT, UPDATE ON TABLE
  commerce_agent_runs,
  commerce_agent_jobs,
  commerce_agent_workers
TO commerce_maintenance_user;
GRANT SELECT, DELETE ON TABLE
  commerce_agent_conversations,
  commerce_agent_rate_limits,
  commerce_agent_jobs,
  commerce_agent_workers
TO commerce_maintenance_user;

GRANT SELECT ON TABLE
  commerce_agent_conversations,
  commerce_agent_messages,
  commerce_agent_runs,
  commerce_agent_evidence,
  commerce_agent_rate_limits,
  commerce_agent_jobs,
  commerce_agent_job_events,
  commerce_agent_workers
TO commerce_backup_user;
GRANT SELECT ON SEQUENCE commerce_agent_job_events_id_seq TO commerce_backup_user;

ALTER ROLE commerce_control_user NOINHERIT NOBYPASSRLS;
ALTER ROLE commerce_maintenance_user NOINHERIT NOBYPASSRLS;
ALTER ROLE commerce_backup_user NOINHERIT BYPASSRLS;
