-- Example control-plane grants. Run as the schema owner after commerce-control.sql.
-- Rename roles before production use if your platform uses different identifiers.

BEGIN;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Make reruns authoritative: remove the legacy shared runtime grants and any stale
-- grants from the two split logins before rebuilding the capability sets below.
REVOKE ALL ON SCHEMA public
FROM commerce_control_user, commerce_control_api_user, commerce_control_worker_user;
REVOKE ALL ON ALL TABLES IN SCHEMA public
FROM commerce_control_user, commerce_control_api_user, commerce_control_worker_user;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public
FROM commerce_control_user, commerce_control_api_user, commerce_control_worker_user;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public
FROM commerce_control_user, commerce_control_api_user, commerce_control_worker_user;

REVOKE ALL ON TABLE
  commerce_agent_conversations,
  commerce_agent_messages,
  commerce_agent_runs,
  commerce_agent_evidence,
  commerce_agent_rate_limits,
  commerce_agent_model_budget_daily,
  commerce_agent_model_budget_reservations,
  commerce_agent_jobs,
  commerce_agent_job_events,
  commerce_agent_feedback,
  commerce_agent_feedback_events,
  commerce_agent_reports,
  commerce_agent_report_shares,
  commerce_agent_action_events,
  commerce_agent_action_reviews,
  commerce_tenant_members,
  commerce_feishu_notification_outbox,
  commerce_feishu_notification_events,
  commerce_action_review_schedules,
  commerce_weekly_diagnosis_runs,
  commerce_agent_workers
FROM PUBLIC;

GRANT USAGE ON SCHEMA public
TO commerce_control_api_user, commerce_control_worker_user,
  commerce_maintenance_user, commerce_backup_user;

GRANT SELECT, INSERT, UPDATE ON TABLE
  commerce_agent_conversations,
  commerce_agent_runs,
  commerce_agent_rate_limits,
  commerce_agent_model_budget_daily,
  commerce_agent_model_budget_reservations,
  commerce_agent_jobs,
  commerce_feishu_notification_outbox,
  commerce_action_review_schedules,
  commerce_weekly_diagnosis_runs
TO commerce_control_api_user, commerce_control_worker_user;
GRANT SELECT, INSERT ON TABLE
  commerce_agent_messages,
  commerce_agent_evidence,
  commerce_agent_job_events,
  commerce_agent_feedback,
  commerce_agent_feedback_events,
  commerce_agent_reports,
  commerce_agent_action_events,
  commerce_agent_action_reviews,
  commerce_feishu_notification_events
TO commerce_control_api_user, commerce_control_worker_user;
GRANT SELECT ON TABLE commerce_tenant_members
TO commerce_control_api_user, commerce_control_worker_user;
GRANT SELECT, INSERT ON TABLE commerce_agent_report_shares
TO commerce_control_api_user, commerce_control_worker_user;
GRANT UPDATE (revoked_at) ON TABLE commerce_agent_report_shares
TO commerce_control_api_user, commerce_control_worker_user;
GRANT SELECT ON TABLE commerce_agent_workers TO commerce_control_api_user;
GRANT SELECT, INSERT, UPDATE ON TABLE commerce_agent_workers TO commerce_control_worker_user;
GRANT USAGE, SELECT ON SEQUENCE commerce_agent_job_events_id_seq
TO commerce_control_api_user, commerce_control_worker_user;
GRANT USAGE ON SEQUENCE commerce_agent_feedback_events_id_seq
TO commerce_control_api_user, commerce_control_worker_user;
GRANT USAGE ON SEQUENCE commerce_agent_action_events_id_seq
TO commerce_control_api_user, commerce_control_worker_user;
GRANT USAGE ON SEQUENCE commerce_feishu_notification_events_id_seq
TO commerce_control_api_user, commerce_control_worker_user;

GRANT SELECT, UPDATE ON TABLE
  commerce_agent_runs,
  commerce_agent_jobs,
  commerce_agent_workers
TO commerce_maintenance_user;
GRANT SELECT, DELETE ON TABLE
  commerce_agent_conversations,
  commerce_agent_rate_limits,
  commerce_agent_model_budget_daily,
  commerce_agent_model_budget_reservations,
  commerce_agent_jobs,
  commerce_agent_report_shares,
  commerce_agent_workers
TO commerce_maintenance_user;
-- Lease recovery appends immutable audit events. The function returns constants rather than
-- event columns, so maintenance needs INSERT only (not SELECT/UPDATE/DELETE) on this table.
REVOKE ALL ON TABLE commerce_agent_job_events FROM commerce_maintenance_user;
GRANT INSERT ON TABLE commerce_agent_job_events TO commerce_maintenance_user;
REVOKE ALL ON SEQUENCE commerce_agent_job_events_id_seq FROM commerce_maintenance_user;
GRANT USAGE ON SEQUENCE commerce_agent_job_events_id_seq TO commerce_maintenance_user;

-- Terminal maintenance paths inspect the latest correction state and append a failure event.
-- They never mutate or delete the user's feedback or its immutable event stream.
REVOKE ALL ON TABLE
  commerce_agent_feedback,
  commerce_agent_feedback_events
FROM commerce_maintenance_user;
GRANT SELECT ON TABLE commerce_agent_feedback TO commerce_maintenance_user;
GRANT SELECT, INSERT ON TABLE commerce_agent_feedback_events TO commerce_maintenance_user;
REVOKE ALL ON SEQUENCE commerce_agent_feedback_events_id_seq FROM commerce_maintenance_user;
GRANT USAGE ON SEQUENCE commerce_agent_feedback_events_id_seq TO commerce_maintenance_user;

-- Functions are executable by PUBLIC unless explicitly revoked. Keep the invoker function
-- available only to the Web/Worker runtime and retention maintenance roles; SECURITY INVOKER
-- then enforces their underlying table and sequence grants.
-- The migration owner retains PostgreSQL's inherent owner capability; it is not a runtime
-- credential. All non-owner roles are reset here before the two runtime grants below.
REVOKE ALL ON FUNCTION public.commerce_reap_expired_jobs()
FROM PUBLIC, commerce_control_user, commerce_control_api_user, commerce_control_worker_user,
  commerce_maintenance_user, commerce_readonly_user, commerce_ingest_user, commerce_backup_user;
GRANT EXECUTE ON FUNCTION public.commerce_reap_expired_jobs()
TO commerce_control_worker_user, commerce_maintenance_user;
REVOKE ALL ON FUNCTION public.commerce_settle_model_budget(TEXT, BIGINT, BIGINT)
FROM PUBLIC, commerce_control_user, commerce_control_api_user, commerce_control_worker_user,
  commerce_maintenance_user, commerce_readonly_user, commerce_ingest_user, commerce_backup_user;
GRANT EXECUTE ON FUNCTION public.commerce_settle_model_budget(TEXT, BIGINT, BIGINT)
TO commerce_control_worker_user, commerce_maintenance_user;
REVOKE ALL ON FUNCTION public.commerce_collect_control_metrics(INTEGER)
FROM PUBLIC, commerce_control_user, commerce_control_api_user, commerce_control_worker_user,
  commerce_maintenance_user, commerce_readonly_user, commerce_ingest_user, commerce_backup_user;
GRANT EXECUTE ON FUNCTION public.commerce_collect_control_metrics(INTEGER)
TO commerce_control_api_user, commerce_control_worker_user;

GRANT SELECT ON TABLE
  commerce_agent_conversations,
  commerce_agent_messages,
  commerce_agent_runs,
  commerce_agent_evidence,
  commerce_agent_rate_limits,
  commerce_agent_model_budget_daily,
  commerce_agent_model_budget_reservations,
  commerce_agent_jobs,
  commerce_agent_job_events,
  commerce_agent_feedback,
  commerce_agent_feedback_events,
  commerce_agent_reports,
  commerce_agent_report_shares,
  commerce_agent_action_events,
  commerce_agent_action_reviews,
  commerce_tenant_members,
  commerce_feishu_notification_outbox,
  commerce_feishu_notification_events,
  commerce_action_review_schedules,
  commerce_weekly_diagnosis_runs,
  commerce_agent_workers
TO commerce_backup_user;
GRANT SELECT ON SEQUENCE
  commerce_agent_job_events_id_seq,
  commerce_agent_feedback_events_id_seq,
  commerce_agent_action_events_id_seq,
  commerce_feishu_notification_events_id_seq
TO commerce_backup_user;

COMMIT;
