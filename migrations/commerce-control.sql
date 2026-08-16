BEGIN;

-- A rerun may start while the previous FORCE RLS policies are already active. The
-- transaction-local legacy system flag lets the migration owner upgrade those old
-- policies; the separate migration flag is what the hardened policies below accept.
SELECT set_config('commerce.control_system', 'on', true),
       set_config('commerce.control_migration', 'on', true);

CREATE TABLE IF NOT EXISTS commerce_agent_conversations (
  id         TEXT        PRIMARY KEY,
  tenant_id  TEXT        NOT NULL,
  user_id    TEXT        NOT NULL,
  title      TEXT        NOT NULL,
  model      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS commerce_agent_conversations_owner_idx
  ON commerce_agent_conversations (tenant_id, user_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_conversations_owner_binding_idx
  ON commerce_agent_conversations (id, tenant_id, user_id);

CREATE TABLE IF NOT EXISTS commerce_agent_messages (
  id              TEXT        PRIMARY KEY,
  conversation_id TEXT        NOT NULL REFERENCES commerce_agent_conversations(id) ON DELETE CASCADE,
  tenant_id       TEXT        NOT NULL,
  user_id         TEXT        NOT NULL,
  role            TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT        NOT NULL,
  answer_json     JSONB,
  run_id          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS commerce_agent_messages_conversation_idx
  ON commerce_agent_messages (tenant_id, conversation_id, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_messages_run_role_idx
  ON commerce_agent_messages (tenant_id, run_id, role)
  WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_messages_feedback_binding_idx
  ON commerce_agent_messages (id, conversation_id, tenant_id, user_id, run_id);
-- Some child records do not carry a Run yet. Keep the four-column owner binding separate
-- from the five-column message/Run binding so PostgreSQL can enforce both FK shapes.
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_messages_owner_binding_idx
  ON commerce_agent_messages (id, conversation_id, tenant_id, user_id);
CREATE INDEX IF NOT EXISTS commerce_agent_messages_actions_idx
  ON commerce_agent_messages (tenant_id, user_id, created_at DESC)
  WHERE role = 'assistant' AND answer_json IS NOT NULL;

CREATE TABLE IF NOT EXISTS commerce_agent_runs (
  id                TEXT        PRIMARY KEY,
  conversation_id   TEXT        NOT NULL REFERENCES commerce_agent_conversations(id) ON DELETE CASCADE,
  tenant_id         TEXT        NOT NULL,
  user_id           TEXT        NOT NULL,
  request_id        TEXT        NOT NULL,
  request_sha256    TEXT        NOT NULL,
  model             TEXT        NOT NULL,
  provider          TEXT        NOT NULL,
  status            TEXT        NOT NULL,
  input_tokens      INTEGER     NOT NULL DEFAULT 0,
  output_tokens     INTEGER     NOT NULL DEFAULT 0,
  total_tokens      INTEGER     NOT NULL DEFAULT 0,
  error_code        TEXT,
  error_message     TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at  TIMESTAMPTZ NOT NULL,
  completed_at      TIMESTAMPTZ,
  CHECK (request_sha256 ~ '^sha256:[0-9a-f]{64}$')
);

ALTER TABLE commerce_agent_runs
  ADD COLUMN IF NOT EXISTS request_sha256 TEXT;
UPDATE commerce_agent_runs
  SET request_sha256 = 'sha256:' || repeat('0', 64)
  WHERE request_sha256 IS NULL;
ALTER TABLE commerce_agent_runs
  ALTER COLUMN request_sha256 SET NOT NULL;

ALTER TABLE commerce_agent_runs
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
UPDATE commerce_agent_runs
  SET lease_expires_at = COALESCE(completed_at, started_at + INTERVAL '150 seconds')
  WHERE lease_expires_at IS NULL;
ALTER TABLE commerce_agent_runs
  ALTER COLUMN lease_expires_at SET NOT NULL;

-- Fencing for Run attempts: lease_expires_at alone only tells a caller whether ITS OWN lease
-- looks current, it cannot stop a stale attempt (e.g. a Worker that hung past its lease and is
-- only now getting around to writing) from completing/failing/renewing a run that a newer
-- attempt has since reclaimed. generation is a monotonic counter bumped by every claim/reclaim;
-- every subsequent write (renew, complete, fail, evidence) must present the generation it was
-- handed at claim time, so a late write from a superseded attempt matches zero rows instead of
-- corrupting the new attempt's state. lease_owner is descriptive only (ops visibility of which
-- attempt currently holds the run) and is not part of the fencing predicate.
ALTER TABLE commerce_agent_runs
  ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE commerce_agent_runs
  ADD COLUMN IF NOT EXISTS generation INTEGER NOT NULL DEFAULT 0;

UPDATE commerce_agent_runs
  SET status = 'failed', error_code = 'RUN_LEASE_EXPIRED',
      error_message = 'Run lease expired before migration.', completed_at = NOW()
  WHERE status = 'running' AND lease_expires_at < NOW();
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, conversation_id
           ORDER BY started_at DESC, id DESC
         ) AS position
  FROM commerce_agent_runs
  WHERE status = 'running'
)
UPDATE commerce_agent_runs AS run
  SET status = 'failed', error_code = 'RUN_CONCURRENCY_RECONCILED',
      error_message = 'Duplicate active conversation run reconciled by migration.',
      completed_at = NOW()
  FROM ranked
  WHERE run.id = ranked.id AND ranked.position > 1;
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, user_id
           ORDER BY started_at DESC, id DESC
         ) AS position
  FROM commerce_agent_runs
  WHERE status = 'running'
)
UPDATE commerce_agent_runs AS run
  SET status = 'failed', error_code = 'RUN_CONCURRENCY_RECONCILED',
      error_message = 'Duplicate active user run reconciled by migration.',
      completed_at = NOW()
  FROM ranked
  WHERE run.id = ranked.id AND ranked.position > 1;

ALTER TABLE commerce_agent_runs
  DROP CONSTRAINT IF EXISTS commerce_agent_runs_tenant_id_request_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_runs_request_idx
  ON commerce_agent_runs (tenant_id, user_id, request_id);

CREATE INDEX IF NOT EXISTS commerce_agent_runs_conversation_idx
  ON commerce_agent_runs (tenant_id, conversation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS commerce_agent_runs_active_lease_idx
  ON commerce_agent_runs (lease_expires_at)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS commerce_agent_runs_tenant_active_lease_idx
  ON commerce_agent_runs (tenant_id, lease_expires_at)
  WHERE status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_one_active_turn_idx
  ON commerce_agent_runs (tenant_id, conversation_id)
  WHERE status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_one_active_user_turn_idx
  ON commerce_agent_runs (tenant_id, user_id)
  WHERE status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_runs_feedback_binding_idx
  ON commerce_agent_runs (id, conversation_id, tenant_id, user_id);

CREATE TABLE IF NOT EXISTS commerce_agent_evidence (
  id              TEXT        PRIMARY KEY,
  run_id          TEXT        NOT NULL REFERENCES commerce_agent_runs(id) ON DELETE CASCADE,
  conversation_id TEXT        NOT NULL REFERENCES commerce_agent_conversations(id) ON DELETE CASCADE,
  tenant_id       TEXT        NOT NULL,
  operation       TEXT        NOT NULL,
  request_sha256  TEXT        NOT NULL,
  response_sha256 TEXT        NOT NULL,
  source_watermark TIMESTAMPTZ,
  request_json    JSONB       NOT NULL,
  row_count       INTEGER     NOT NULL,
  preview_json    JSONB       NOT NULL,
  preview_truncated BOOLEAN   NOT NULL DEFAULT false,
  fetched_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS commerce_agent_evidence_run_idx
  ON commerce_agent_evidence (tenant_id, run_id, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_evidence_feedback_binding_idx
  ON commerce_agent_evidence (id, run_id, conversation_id, tenant_id);

ALTER TABLE commerce_agent_evidence
  ADD COLUMN IF NOT EXISTS request_json JSONB;
ALTER TABLE commerce_agent_evidence
  ADD COLUMN IF NOT EXISTS source_watermark TIMESTAMPTZ;
ALTER TABLE commerce_agent_evidence
  ADD COLUMN IF NOT EXISTS preview_truncated BOOLEAN;
UPDATE commerce_agent_evidence
  SET preview_truncated = true
  WHERE preview_truncated IS NULL;
ALTER TABLE commerce_agent_evidence
  ALTER COLUMN preview_truncated SET DEFAULT false;
ALTER TABLE commerce_agent_evidence
  ALTER COLUMN preview_truncated SET NOT NULL;
UPDATE commerce_agent_evidence
  SET request_json = '{}'::jsonb
  WHERE request_json IS NULL;
ALTER TABLE commerce_agent_evidence
  ALTER COLUMN request_json SET NOT NULL;

-- Immutable report artifacts are frozen in the same transaction that completes the Run.
-- JSON is the audit source of truth; human-readable formats are rendered from this snapshot.
CREATE TABLE IF NOT EXISTS commerce_agent_reports (
  id               TEXT        PRIMARY KEY,
  tenant_id        TEXT        NOT NULL,
  user_id          TEXT        NOT NULL,
  conversation_id  TEXT        NOT NULL,
  message_id       TEXT        NOT NULL,
  run_id           TEXT        NOT NULL,
  schema_version   INTEGER     NOT NULL CHECK (schema_version = 1),
  release_revision TEXT        NOT NULL,
  content_sha256   TEXT        NOT NULL,
  manifest_json    JSONB       NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (message_id, conversation_id, tenant_id, user_id, run_id)
    REFERENCES commerce_agent_messages (id, conversation_id, tenant_id, user_id, run_id)
    ON DELETE CASCADE,
  FOREIGN KEY (run_id, conversation_id, tenant_id, user_id)
    REFERENCES commerce_agent_runs (id, conversation_id, tenant_id, user_id)
    ON DELETE CASCADE,
  CHECK (char_length(release_revision) BETWEEN 1 AND 200),
  CHECK (content_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (manifest_json->>'artifactType' = 'commerce_agent_report'),
  CHECK ((manifest_json->>'schemaVersion')::integer = schema_version),
  CHECK (manifest_json->>'reportId' = id),
  CHECK (manifest_json->>'contentSha256' = content_sha256)
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_reports_message_idx
  ON commerce_agent_reports (tenant_id, user_id, message_id);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_reports_run_idx
  ON commerce_agent_reports (tenant_id, user_id, run_id);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_reports_owner_binding_idx
  ON commerce_agent_reports (id, tenant_id, user_id);

CREATE TABLE IF NOT EXISTS commerce_agent_report_shares (
  id            TEXT        PRIMARY KEY,
  report_id     TEXT        NOT NULL,
  tenant_id     TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  token_sha256  TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (report_id, tenant_id, user_id)
    REFERENCES commerce_agent_reports (id, tenant_id, user_id) ON DELETE CASCADE,
  CHECK (id ~ '^share_[A-Za-z0-9-]{16,80}$'),
  CHECK (token_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + INTERVAL '7 days'),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_report_shares_token_idx
  ON commerce_agent_report_shares (token_sha256);
CREATE INDEX IF NOT EXISTS commerce_agent_report_shares_report_idx
  ON commerce_agent_report_shares (tenant_id, user_id, report_id, created_at DESC);
CREATE INDEX IF NOT EXISTS commerce_agent_report_shares_expiry_idx
  ON commerce_agent_report_shares (expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS commerce_agent_rate_limits (
  scope_key      TEXT        NOT NULL,
  window_start   TIMESTAMPTZ NOT NULL,
  request_count  INTEGER     NOT NULL,
  PRIMARY KEY (scope_key, window_start)
);
CREATE INDEX IF NOT EXISTS commerce_agent_rate_limits_window_idx
  ON commerce_agent_rate_limits (window_start);

-- Global UTC-day model-cost oracle. Enqueue reserves the hard run envelope under
-- one row lock; terminal processing atomically replaces that reservation with
-- provider-token-derived cost (or the full reservation when usage is unknown).
CREATE TABLE IF NOT EXISTS commerce_agent_model_budget_daily (
  budget_date   DATE          PRIMARY KEY,
  reserved_usd  NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  spent_usd     NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commerce_agent_jobs (
  id                TEXT        PRIMARY KEY,
  tenant_id         TEXT        NOT NULL,
  user_id           TEXT        NOT NULL,
  user_display_name TEXT        NOT NULL,
  auth_mode         TEXT        NOT NULL CHECK (auth_mode IN ('development', 'trusted_proxy')),
  scopes            TEXT[]      NOT NULL,
  kind              TEXT        NOT NULL CHECK (kind IN ('create_conversation', 'conversation_turn')),
  conversation_id   TEXT        REFERENCES commerce_agent_conversations(id) ON DELETE CASCADE,
  request_id        TEXT        NOT NULL,
  request_sha256    TEXT        NOT NULL,
  model             TEXT        NOT NULL,
  message           TEXT        NOT NULL,
  -- The default is an expand/contract compatibility bridge for the immediately previous
  -- application revision, whose enqueue statement did not name this column. Current code
  -- always writes an explicit immutable revision; remove this default only after the N-1
  -- rollback window has closed and no unversioned Jobs remain.
  required_revision TEXT        NOT NULL DEFAULT 'unversioned',
  executed_by_worker_id TEXT,
  status            TEXT        NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'dead_letter')),
  attempt_count     INTEGER     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts      INTEGER     NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner       TEXT,
  lease_expires_at  TIMESTAMPTZ,
  result_json       JSONB,
  error_code        TEXT,
  error_message     TEXT,
  last_error_code   TEXT,
  last_error_message TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (kind = 'create_conversation' AND conversation_id IS NULL)
    OR (kind = 'conversation_turn' AND conversation_id IS NOT NULL)
  )
);

ALTER TABLE commerce_agent_jobs
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS last_error_message TEXT;
ALTER TABLE commerce_agent_jobs
  ADD COLUMN IF NOT EXISTS required_revision TEXT,
  ADD COLUMN IF NOT EXISTS executed_by_worker_id TEXT;
UPDATE commerce_agent_jobs
  SET required_revision = 'unversioned'
  WHERE required_revision IS NULL;
ALTER TABLE commerce_agent_jobs
  ALTER COLUMN required_revision SET DEFAULT 'unversioned';
ALTER TABLE commerce_agent_jobs
  ALTER COLUMN required_revision SET NOT NULL;
ALTER TABLE commerce_agent_jobs
  DROP CONSTRAINT IF EXISTS commerce_agent_jobs_status_check;
ALTER TABLE commerce_agent_jobs
  ADD CONSTRAINT commerce_agent_jobs_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'dead_letter'));

CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_jobs_request_idx
  ON commerce_agent_jobs (tenant_id, user_id, request_id);
DROP INDEX IF EXISTS commerce_agent_jobs_claim_idx;
CREATE INDEX commerce_agent_jobs_claim_idx
  ON commerce_agent_jobs (required_revision, status, available_at, created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS commerce_agent_jobs_owner_idx
  ON commerce_agent_jobs (tenant_id, user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_jobs_owner_binding_idx
  ON commerce_agent_jobs (id, tenant_id, user_id);

CREATE TABLE IF NOT EXISTS commerce_agent_model_budget_reservations (
  job_id                         TEXT          PRIMARY KEY
    REFERENCES commerce_agent_jobs(id) ON DELETE CASCADE,
  budget_date                    DATE          NOT NULL
    REFERENCES commerce_agent_model_budget_daily(budget_date) ON DELETE RESTRICT,
  reserved_usd                   NUMERIC(18,8) NOT NULL CHECK (reserved_usd > 0),
  input_usd_per_million_tokens   NUMERIC(18,8) NOT NULL
    CHECK (input_usd_per_million_tokens > 0),
  output_usd_per_million_tokens  NUMERIC(18,8) NOT NULL
    CHECK (output_usd_per_million_tokens > 0),
  actual_usd                     NUMERIC(18,8),
  settlement                     TEXT CHECK (settlement IN ('actual', 'conservative')),
  created_at                     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  settled_at                     TIMESTAMPTZ,
  CHECK (
    (settled_at IS NULL AND actual_usd IS NULL AND settlement IS NULL)
    OR (settled_at IS NOT NULL AND actual_usd >= 0 AND settlement IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS commerce_agent_model_budget_reservations_day_idx
  ON commerce_agent_model_budget_reservations (budget_date, settled_at);

-- One idempotent settlement primitive is shared by Worker terminal paths, lease
-- recovery and retention cleanup. NULL token counts conservatively charge the
-- full reservation when no provider usage is available.
CREATE OR REPLACE FUNCTION commerce_settle_model_budget(
  p_job_id TEXT,
  p_input_tokens BIGINT DEFAULT NULL,
  p_output_tokens BIGINT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $commerce_settle_budget$
DECLARE
  v_reservation RECORD;
  v_actual_usd NUMERIC(18,8);
BEGIN
  IF (p_input_tokens IS NULL) <> (p_output_tokens IS NULL)
     OR COALESCE(p_input_tokens, 0) < 0
     OR COALESCE(p_output_tokens, 0) < 0 THEN
    RAISE EXCEPTION 'Model budget token usage is invalid.';
  END IF;

  SELECT budget_date, reserved_usd, input_usd_per_million_tokens,
         output_usd_per_million_tokens
  INTO v_reservation
  FROM commerce_agent_model_budget_reservations
  WHERE job_id = p_job_id AND settled_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  v_actual_usd := CASE
    WHEN p_input_tokens IS NULL THEN v_reservation.reserved_usd
    ELSE ROUND((
      p_input_tokens * v_reservation.input_usd_per_million_tokens
      + p_output_tokens * v_reservation.output_usd_per_million_tokens
    ) / 1000000, 8)
  END;

  UPDATE commerce_agent_model_budget_daily
  SET reserved_usd = GREATEST(0, reserved_usd - v_reservation.reserved_usd),
      spent_usd = spent_usd + v_actual_usd,
      updated_at = NOW()
  WHERE budget_date = v_reservation.budget_date;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commerce model budget reservation lost its daily ledger row.';
  END IF;

  UPDATE commerce_agent_model_budget_reservations
  SET actual_usd = v_actual_usd,
      settlement = CASE WHEN p_input_tokens IS NULL THEN 'conservative' ELSE 'actual' END,
      settled_at = NOW()
  WHERE job_id = p_job_id AND settled_at IS NULL;
  RETURN FOUND;
END
$commerce_settle_budget$;

REVOKE ALL ON FUNCTION public.commerce_settle_model_budget(TEXT, BIGINT, BIGINT) FROM PUBLIC;

CREATE TABLE IF NOT EXISTS commerce_agent_job_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id     TEXT        NOT NULL REFERENCES commerce_agent_jobs(id) ON DELETE CASCADE,
  tenant_id  TEXT        NOT NULL,
  user_id    TEXT        NOT NULL,
  event_type TEXT        NOT NULL,
  payload    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS commerce_agent_job_events_stream_idx
  ON commerce_agent_job_events (tenant_id, user_id, job_id, id ASC);

-- Immutable, user-attributed answer feedback. The API derives every ownership/reference
-- column from an already persisted assistant message; clients cannot choose a tenant or user.
-- A received record is an auditable review request, not a claim that the original answer was
-- automatically corrected.
CREATE TABLE IF NOT EXISTS commerce_agent_feedback (
  id              TEXT        PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  user_id         TEXT        NOT NULL,
  conversation_id TEXT        NOT NULL,
  message_id      TEXT        NOT NULL,
  run_id          TEXT        NOT NULL,
  evidence_id     TEXT,
  claim_path      TEXT,
  category        TEXT        NOT NULL CHECK (category IN (
    'wrong_date', 'wrong_metric', 'data_issue', 'unhelpful_recommendation', 'other'
  )),
  comment         TEXT,
  idempotency_key TEXT        NOT NULL,
  request_sha256  TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'received' CHECK (status = 'received'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (message_id, conversation_id, tenant_id, user_id, run_id)
    REFERENCES commerce_agent_messages (id, conversation_id, tenant_id, user_id, run_id)
    ON DELETE CASCADE,
  FOREIGN KEY (run_id, conversation_id, tenant_id, user_id)
    REFERENCES commerce_agent_runs (id, conversation_id, tenant_id, user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (evidence_id, run_id, conversation_id, tenant_id)
    REFERENCES commerce_agent_evidence (id, run_id, conversation_id, tenant_id)
    ON DELETE CASCADE,
  CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  CHECK (request_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 1000),
  CHECK (claim_path IS NULL OR (
    evidence_id IS NOT NULL
    AND char_length(claim_path) BETWEEN 1 AND 240
    AND left(claim_path, 1) = '/'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_feedback_idempotency_idx
  ON commerce_agent_feedback (tenant_id, user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS commerce_agent_feedback_message_idx
  ON commerce_agent_feedback (tenant_id, user_id, message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS commerce_agent_feedback_review_idx
  ON commerce_agent_feedback (status, category, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_feedback_tenant_binding_idx
  ON commerce_agent_feedback (id, tenant_id);
CREATE INDEX IF NOT EXISTS commerce_agent_feedback_tenant_queue_idx
  ON commerce_agent_feedback (tenant_id, created_at DESC, id DESC);

-- Reviewer decisions are append-only. The original user submission remains immutable, while
-- the latest versioned event is the authoritative review status. correction_requested is an
-- explicit hand-off state; it does not claim that a corrective Job or Run already exists.
CREATE TABLE IF NOT EXISTS commerce_agent_feedback_events (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feedback_id        TEXT        NOT NULL,
  tenant_id          TEXT        NOT NULL,
  actor_user_id      TEXT        NOT NULL,
  actor_display_name TEXT        NOT NULL,
  event_type         TEXT        NOT NULL CHECK (event_type IN (
    'reviewed', 'correction_requested', 'correction_enqueued',
    'correction_completed', 'correction_failed', 'resolved', 'dismissed'
  )),
  version            INTEGER     NOT NULL CHECK (version > 0),
  note               TEXT,
  idempotency_key    TEXT        NOT NULL,
  request_sha256     TEXT        NOT NULL,
  job_id             TEXT        REFERENCES commerce_agent_jobs(id) ON DELETE SET NULL,
  run_id             TEXT        REFERENCES commerce_agent_runs(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (feedback_id, tenant_id)
    REFERENCES commerce_agent_feedback(id, tenant_id) ON DELETE CASCADE,
  CHECK (char_length(actor_user_id) BETWEEN 1 AND 128),
  CHECK (char_length(actor_display_name) BETWEEN 1 AND 120),
  CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  CHECK (request_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_feedback_events_version_idx
  ON commerce_agent_feedback_events (tenant_id, feedback_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_feedback_events_idempotency_idx
  ON commerce_agent_feedback_events (tenant_id, actor_user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS commerce_agent_feedback_events_stream_idx
  ON commerce_agent_feedback_events (tenant_id, feedback_id, version ASC);

-- Operator action progress is append-only. The immutable answer remains the source of the
-- proposed action; explicit human transitions are recorded here for refresh-safe tracking.
CREATE TABLE IF NOT EXISTS commerce_agent_action_events (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id          TEXT        NOT NULL,
  user_id            TEXT        NOT NULL,
  conversation_id    TEXT        NOT NULL,
  message_id         TEXT        NOT NULL,
  run_id             TEXT        NOT NULL,
  action_id          TEXT        NOT NULL,
  event_type         TEXT        NOT NULL CONSTRAINT commerce_agent_action_events_event_type_check
                                  CHECK (event_type IN (
                                    'confirmed', 'ignored', 'snoozed', 'reminder_due',
                                    'started', 'blocked', 'resumed', 'completed',
                                    'cancelled', 'reopened', 'reviewed'
                                  )),
  version            INTEGER     NOT NULL CHECK (version > 0),
  actor_user_id      TEXT        NOT NULL,
  actor_display_name TEXT        NOT NULL,
  idempotency_key    TEXT        NOT NULL,
  request_sha256     TEXT        NOT NULL,
  details_json       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (message_id, conversation_id, tenant_id, user_id, run_id)
    REFERENCES commerce_agent_messages (id, conversation_id, tenant_id, user_id, run_id)
    ON DELETE CASCADE,
  FOREIGN KEY (run_id, conversation_id, tenant_id, user_id)
    REFERENCES commerce_agent_runs (id, conversation_id, tenant_id, user_id)
    ON DELETE CASCADE,
  CHECK (action_id ~ '^action_[a-f0-9]{24}$'),
  CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  CHECK (request_sha256 ~ '^sha256:[0-9a-f]{64}$')
);

-- Keep upgrades from older P1 builds idempotent while expanding the append-only event contract.
ALTER TABLE commerce_agent_action_events
  ADD COLUMN IF NOT EXISTS details_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE commerce_agent_action_events
  DROP CONSTRAINT IF EXISTS commerce_agent_action_events_event_type_check;
ALTER TABLE commerce_agent_action_events
  ADD CONSTRAINT commerce_agent_action_events_event_type_check CHECK (event_type IN (
    'confirmed', 'ignored', 'snoozed', 'reminder_due',
    'started', 'blocked', 'resumed', 'completed',
    'cancelled', 'reopened', 'reviewed'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_action_events_version_idx
  ON commerce_agent_action_events (tenant_id, user_id, message_id, action_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_action_events_idempotency_idx
  ON commerce_agent_action_events (tenant_id, user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS commerce_agent_action_events_latest_idx
  ON commerce_agent_action_events (tenant_id, user_id, message_id, action_id, version DESC);

-- A completed effect review is an immutable association between an Action and the durable
-- assistant Run that performed the review. The chat turn remains ordinary conversation data;
-- this receipt prevents the relationship from being inferred from free-form text later.
CREATE TABLE IF NOT EXISTS commerce_agent_action_reviews (
  id                TEXT        PRIMARY KEY,
  tenant_id         TEXT        NOT NULL,
  user_id           TEXT        NOT NULL,
  conversation_id   TEXT        NOT NULL,
  source_message_id TEXT        NOT NULL,
  action_id         TEXT        NOT NULL,
  source_run_id     TEXT        NOT NULL,
  review_run_id     TEXT        NOT NULL,
  review_message_id TEXT        NOT NULL,
  request_id        TEXT        NOT NULL,
  request_sha256    TEXT        NOT NULL,
  question          TEXT        NOT NULL,
  plan_json         JSONB       NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (source_message_id, conversation_id, tenant_id, user_id, source_run_id)
    REFERENCES commerce_agent_messages (id, conversation_id, tenant_id, user_id, run_id)
    ON DELETE CASCADE,
  FOREIGN KEY (review_message_id, conversation_id, tenant_id, user_id, review_run_id)
    REFERENCES commerce_agent_messages (id, conversation_id, tenant_id, user_id, run_id)
    ON DELETE CASCADE,
  FOREIGN KEY (source_run_id, conversation_id, tenant_id, user_id)
    REFERENCES commerce_agent_runs (id, conversation_id, tenant_id, user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (review_run_id, conversation_id, tenant_id, user_id)
    REFERENCES commerce_agent_runs (id, conversation_id, tenant_id, user_id)
    ON DELETE CASCADE,
  CHECK (id ~ '^review_[A-Za-z0-9-]{16,80}$'),
  CHECK (action_id ~ '^action_[a-f0-9]{24}$'),
  CHECK (char_length(request_id) BETWEEN 8 AND 128),
  CHECK (request_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (char_length(question) BETWEEN 2 AND 2000),
  CHECK (plan_json->>'status' = 'ready')
);

ALTER TABLE commerce_agent_action_reviews
  DROP CONSTRAINT IF EXISTS commerce_agent_action_reviews_question_check;
ALTER TABLE commerce_agent_action_reviews
  ADD CONSTRAINT commerce_agent_action_reviews_question_check
  CHECK (char_length(question) BETWEEN 2 AND 2000) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_action_reviews_request_idx
  ON commerce_agent_action_reviews (tenant_id, user_id, request_id);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_action_reviews_message_idx
  ON commerce_agent_action_reviews (tenant_id, user_id, action_id, review_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_action_reviews_action_once_idx
  ON commerce_agent_action_reviews (tenant_id, user_id, source_message_id, action_id);
CREATE INDEX IF NOT EXISTS commerce_agent_action_reviews_action_idx
  ON commerce_agent_action_reviews (tenant_id, user_id, action_id, created_at DESC);

-- Stable tenant member identities are the only values that may be selected as an external
-- notification recipient. Channel identifiers never come from model output.
CREATE TABLE IF NOT EXISTS commerce_tenant_members (
  tenant_id       TEXT        NOT NULL,
  member_id       TEXT        NOT NULL,
  display_name    TEXT        NOT NULL,
  feishu_open_id  TEXT,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  can_receive_notifications BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, member_id),
  CHECK (member_id ~ '^member_[A-Za-z0-9._:-]{4,120}$'),
  CHECK (char_length(display_name) BETWEEN 1 AND 120),
  CHECK (feishu_open_id IS NULL OR char_length(feishu_open_id) BETWEEN 3 AND 160),
  CHECK (NOT can_receive_notifications OR feishu_open_id IS NOT NULL)
);

-- One row is one logical Feishu notification command. The uniqueness key proves logical
-- deduplication; it deliberately does not claim physical exactly-once network delivery.
CREATE TABLE IF NOT EXISTS commerce_feishu_notification_outbox (
  id                  TEXT        PRIMARY KEY,
  tenant_id           TEXT        NOT NULL,
  user_id             TEXT        NOT NULL,
  conversation_id     TEXT        NOT NULL,
  message_id          TEXT        NOT NULL,
  action_id           TEXT        NOT NULL,
  action_version      INTEGER     NOT NULL CHECK (action_version > 0),
  channel             TEXT        NOT NULL DEFAULT 'feishu' CHECK (channel = 'feishu'),
  recipient_member_id TEXT        NOT NULL,
  request_uuid        UUID        NOT NULL,
  approval_request_id TEXT        NOT NULL,
  request_sha256      TEXT        NOT NULL,
  payload_json        JSONB       NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending', 'sending', 'delivered', 'retryable',
                        'delivery_unknown', 'failed_permanent'
                      )),
  attempt_count       INTEGER     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner         TEXT,
  lease_expires_at    TIMESTAMPTZ,
  provider_message_id TEXT,
  last_error          TEXT,
  reissued_from_id    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at        TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, recipient_member_id)
    REFERENCES commerce_tenant_members (tenant_id, member_id),
  FOREIGN KEY (message_id, conversation_id, tenant_id, user_id)
    REFERENCES commerce_agent_messages (id, conversation_id, tenant_id, user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (reissued_from_id)
    REFERENCES commerce_feishu_notification_outbox (id),
  CHECK (id ~ '^outbox_[A-Za-z0-9-]{16,80}$'),
  CHECK (action_id ~ '^action_[a-f0-9]{24}$'),
  CHECK (char_length(approval_request_id) BETWEEN 8 AND 128),
  CHECK (request_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_feishu_outbox_logic_idx
  ON commerce_feishu_notification_outbox (tenant_id, action_id, action_version, channel);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_feishu_outbox_request_uuid_idx
  ON commerce_feishu_notification_outbox (tenant_id, request_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_feishu_outbox_approval_request_idx
  ON commerce_feishu_notification_outbox (tenant_id, user_id, approval_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_feishu_outbox_owner_binding_idx
  ON commerce_feishu_notification_outbox (id, tenant_id, user_id);
CREATE INDEX IF NOT EXISTS commerce_feishu_outbox_claim_idx
  ON commerce_feishu_notification_outbox (status, available_at, created_at)
  WHERE status IN ('pending', 'retryable');
CREATE INDEX IF NOT EXISTS commerce_feishu_outbox_sending_lease_idx
  ON commerce_feishu_notification_outbox (lease_expires_at)
  WHERE status = 'sending';

CREATE TABLE IF NOT EXISTS commerce_feishu_notification_events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outbox_id      TEXT        NOT NULL REFERENCES commerce_feishu_notification_outbox (id) ON DELETE CASCADE,
  tenant_id      TEXT        NOT NULL,
  user_id        TEXT        NOT NULL,
  event_type     TEXT        NOT NULL,
  actor_user_id  TEXT        NOT NULL,
  details_json   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (event_type IN (
    'approved', 'claimed', 'delivered', 'retryable', 'delivery_unknown',
    'failed_permanent', 'reconciled_delivered', 'reconciled_absent',
    'operator_mark_delivered', 'reissued'
  ))
);
CREATE INDEX IF NOT EXISTS commerce_feishu_notification_events_stream_idx
  ON commerce_feishu_notification_events (tenant_id, outbox_id, id ASC);

-- Review schedules are version-fenced. A stale worker can finish its read-only work but the
-- compare-and-set contract prevents it from publishing a verdict for an obsolete action.
CREATE TABLE IF NOT EXISTS commerce_action_review_schedules (
  id                       TEXT        PRIMARY KEY,
  tenant_id                TEXT        NOT NULL,
  user_id                  TEXT        NOT NULL,
  conversation_id          TEXT        NOT NULL,
  message_id               TEXT        NOT NULL,
  action_id                TEXT        NOT NULL,
  action_version           INTEGER     NOT NULL CHECK (action_version > 0),
  state_version            INTEGER     NOT NULL CHECK (state_version > 0),
  completed_at             TIMESTAMPTZ NOT NULL,
  tenant_timezone          TEXT        NOT NULL,
  clock_type               TEXT        NOT NULL CHECK (clock_type IN ('wall', 'virtual')),
  effective_review_start   TIMESTAMPTZ NOT NULL,
  effective_review_end     TIMESTAMPTZ NOT NULL,
  review_after_watermark   TIMESTAMPTZ NOT NULL,
  effective_window_sha256  TEXT        NOT NULL,
  review_contract_json     JSONB       NOT NULL,
  status                   TEXT        NOT NULL DEFAULT 'waiting' CHECK (status IN (
                             'waiting', 'queued', 'running', 'completed',
                             'stale_noop', 'cancelled', 'failed'
                           )),
  job_id                   TEXT,
  verdict_json             JSONB,
  review_run_id            TEXT,
  review_message_id        TEXT,
  reviewed_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (message_id, conversation_id, tenant_id, user_id)
    REFERENCES commerce_agent_messages (id, conversation_id, tenant_id, user_id)
    ON DELETE CASCADE,
  CHECK (id ~ '^review_schedule_[A-Za-z0-9-]{16,80}$'),
  CHECK (action_id ~ '^action_[a-f0-9]{24}$'),
  CHECK (effective_review_start < effective_review_end),
  CHECK (review_after_watermark = effective_review_end),
  CHECK (effective_window_sha256 ~ '^sha256:[0-9a-f]{64}$')
);
ALTER TABLE commerce_action_review_schedules
  ADD COLUMN IF NOT EXISTS job_id TEXT,
  ADD COLUMN IF NOT EXISTS verdict_json JSONB,
  ADD COLUMN IF NOT EXISTS review_run_id TEXT,
  ADD COLUMN IF NOT EXISTS review_message_id TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE commerce_action_review_schedules
  DROP CONSTRAINT IF EXISTS commerce_action_review_schedules_status_check;
ALTER TABLE commerce_action_review_schedules
  ADD CONSTRAINT commerce_action_review_schedules_status_check CHECK (status IN (
    'waiting', 'queued', 'running', 'completed', 'stale_noop', 'cancelled', 'failed'
  ));
CREATE UNIQUE INDEX IF NOT EXISTS commerce_action_review_schedule_logic_idx
  ON commerce_action_review_schedules (
    tenant_id, action_id, action_version, effective_review_start, effective_review_end
  );
CREATE INDEX IF NOT EXISTS commerce_action_review_schedule_waiting_idx
  ON commerce_action_review_schedules (status, review_after_watermark)
  WHERE status = 'waiting';
CREATE UNIQUE INDEX IF NOT EXISTS commerce_action_review_schedule_job_idx
  ON commerce_action_review_schedules (job_id)
  WHERE job_id IS NOT NULL;

-- A policy upgrade does not change the canonical weekly key. Corrections and explicit reruns
-- create an auditable revision and atomically supersede the previous current run.
CREATE TABLE IF NOT EXISTS commerce_weekly_diagnosis_runs (
  id                 TEXT        PRIMARY KEY,
  tenant_id          TEXT        NOT NULL,
  user_id            TEXT        NOT NULL,
  objective          TEXT        NOT NULL DEFAULT 'diagnose_previous_complete_week',
  week_start         DATE        NOT NULL,
  week_end           DATE        NOT NULL,
  tenant_timezone    TEXT        NOT NULL,
  revision           INTEGER     NOT NULL DEFAULT 1 CHECK (revision > 0),
  policy_version     TEXT        NOT NULL,
  canonical_sha256   TEXT        NOT NULL,
  status             TEXT        NOT NULL CHECK (status IN (
                       'waiting', 'queued', 'running', 'completed', 'failed',
                       'skipped_backlog', 'superseded'
                      )),
  is_current         BOOLEAN     NOT NULL DEFAULT TRUE,
  supersedes_run_id  TEXT REFERENCES commerce_weekly_diagnosis_runs (id),
  agent_job_id       TEXT,
  result_conversation_id TEXT,
  result_run_id      TEXT,
  result_message_id  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (week_start < week_end),
  CHECK (week_end - week_start = 7),
  CHECK (canonical_sha256 ~ '^sha256:[0-9a-f]{64}$')
);
ALTER TABLE commerce_weekly_diagnosis_runs
  ADD COLUMN IF NOT EXISTS result_conversation_id TEXT,
  ADD COLUMN IF NOT EXISTS result_run_id TEXT,
  ADD COLUMN IF NOT EXISTS result_message_id TEXT;
ALTER TABLE commerce_weekly_diagnosis_runs
  DROP CONSTRAINT IF EXISTS commerce_weekly_diagnosis_runs_status_check;
-- Older revisions could be made non-current without terminating their active state. Reconcile
-- that legacy shape before installing the expanded status contract.
UPDATE commerce_weekly_diagnosis_runs
SET status = 'superseded', updated_at = NOW()
WHERE NOT is_current AND status IN ('waiting', 'queued', 'running');
ALTER TABLE commerce_weekly_diagnosis_runs
  ADD CONSTRAINT commerce_weekly_diagnosis_runs_status_check CHECK (status IN (
    'waiting', 'queued', 'running', 'completed', 'failed',
    'skipped_backlog', 'superseded'
  )) NOT VALID;
ALTER TABLE commerce_weekly_diagnosis_runs
  VALIDATE CONSTRAINT commerce_weekly_diagnosis_runs_status_check;
CREATE UNIQUE INDEX IF NOT EXISTS commerce_weekly_diagnosis_revision_idx
  ON commerce_weekly_diagnosis_runs (tenant_id, objective, week_start, week_end, revision);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_weekly_diagnosis_current_idx
  ON commerce_weekly_diagnosis_runs (tenant_id, objective, week_start, week_end)
  WHERE is_current;
CREATE INDEX IF NOT EXISTS commerce_weekly_diagnosis_waiting_idx
  ON commerce_weekly_diagnosis_runs (status, week_end)
  WHERE status = 'waiting';
CREATE UNIQUE INDEX IF NOT EXISTS commerce_weekly_diagnosis_job_idx
  ON commerce_weekly_diagnosis_runs (agent_job_id)
  WHERE agent_job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS commerce_weekly_diagnosis_owner_binding_idx
  ON commerce_weekly_diagnosis_runs (id, tenant_id, user_id);

-- Ownership is part of every durable relationship. Global-looking text IDs remain convenient
-- API identifiers, but a child row cannot bind one tenant/user identity to another tenant's
-- parent. The referenced UNIQUE indexes above intentionally reuse existing five-column
-- message/Run bindings where those exact shapes were already present.
CREATE INDEX IF NOT EXISTS commerce_agent_messages_conversation_owner_fk_idx
  ON commerce_agent_messages (conversation_id, tenant_id, user_id);
CREATE INDEX IF NOT EXISTS commerce_agent_messages_run_owner_fk_idx
  ON commerce_agent_messages (run_id, conversation_id, tenant_id, user_id)
  WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_agent_runs_conversation_owner_fk_idx
  ON commerce_agent_runs (conversation_id, tenant_id, user_id);
CREATE INDEX IF NOT EXISTS commerce_agent_jobs_conversation_owner_fk_idx
  ON commerce_agent_jobs (conversation_id, tenant_id, user_id)
  WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_agent_job_events_job_owner_fk_idx
  ON commerce_agent_job_events (job_id, tenant_id, user_id);
CREATE INDEX IF NOT EXISTS commerce_feishu_outbox_message_owner_fk_idx
  ON commerce_feishu_notification_outbox
     (message_id, conversation_id, tenant_id, user_id);
CREATE INDEX IF NOT EXISTS commerce_feishu_outbox_reissued_owner_fk_idx
  ON commerce_feishu_notification_outbox (reissued_from_id, tenant_id, user_id)
  WHERE reissued_from_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_feishu_events_outbox_owner_fk_idx
  ON commerce_feishu_notification_events (outbox_id, tenant_id, user_id);
CREATE INDEX IF NOT EXISTS commerce_review_schedules_message_owner_fk_idx
  ON commerce_action_review_schedules (message_id, conversation_id, tenant_id, user_id);
CREATE INDEX IF NOT EXISTS commerce_review_schedules_job_owner_fk_idx
  ON commerce_action_review_schedules (job_id, tenant_id, user_id)
  WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_review_schedules_result_run_owner_fk_idx
  ON commerce_action_review_schedules
     (review_run_id, conversation_id, tenant_id, user_id)
  WHERE review_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_review_schedules_result_message_owner_fk_idx
  ON commerce_action_review_schedules
     (review_message_id, conversation_id, tenant_id, user_id, review_run_id)
  WHERE review_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_action_reviews_source_message_owner_fk_idx
  ON commerce_agent_action_reviews
     (source_message_id, conversation_id, tenant_id, user_id, source_run_id);
CREATE INDEX IF NOT EXISTS commerce_action_reviews_result_message_owner_fk_idx
  ON commerce_agent_action_reviews
     (review_message_id, conversation_id, tenant_id, user_id, review_run_id);
CREATE INDEX IF NOT EXISTS commerce_action_reviews_source_run_owner_fk_idx
  ON commerce_agent_action_reviews
     (source_run_id, conversation_id, tenant_id, user_id);
CREATE INDEX IF NOT EXISTS commerce_action_reviews_result_run_owner_fk_idx
  ON commerce_agent_action_reviews
     (review_run_id, conversation_id, tenant_id, user_id);
CREATE INDEX IF NOT EXISTS commerce_weekly_diagnosis_supersedes_owner_fk_idx
  ON commerce_weekly_diagnosis_runs (supersedes_run_id, tenant_id, user_id)
  WHERE supersedes_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_weekly_diagnosis_job_owner_fk_idx
  ON commerce_weekly_diagnosis_runs (agent_job_id, tenant_id, user_id)
  WHERE agent_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_weekly_diagnosis_result_conversation_fk_idx
  ON commerce_weekly_diagnosis_runs (result_conversation_id, tenant_id, user_id)
  WHERE result_conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_weekly_diagnosis_result_run_fk_idx
  ON commerce_weekly_diagnosis_runs
     (result_run_id, result_conversation_id, tenant_id, user_id)
  WHERE result_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_weekly_diagnosis_result_message_fk_idx
  ON commerce_weekly_diagnosis_runs
     (result_message_id, result_conversation_id, tenant_id, user_id, result_run_id)
  WHERE result_message_id IS NOT NULL;

DO $commerce_control_owner_foreign_keys$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_agent_messages'::regclass
      AND conname = 'commerce_agent_messages_conversation_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_agent_messages
      ADD CONSTRAINT commerce_agent_messages_conversation_owner_fk
      FOREIGN KEY (conversation_id, tenant_id, user_id)
      REFERENCES public.commerce_agent_conversations (id, tenant_id, user_id)
      ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_agent_messages'::regclass
      AND conname = 'commerce_agent_messages_run_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_agent_messages
      ADD CONSTRAINT commerce_agent_messages_run_owner_fk
      FOREIGN KEY (run_id, conversation_id, tenant_id, user_id)
      REFERENCES public.commerce_agent_runs (id, conversation_id, tenant_id, user_id)
      ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_agent_runs'::regclass
      AND conname = 'commerce_agent_runs_conversation_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_agent_runs
      ADD CONSTRAINT commerce_agent_runs_conversation_owner_fk
      FOREIGN KEY (conversation_id, tenant_id, user_id)
      REFERENCES public.commerce_agent_conversations (id, tenant_id, user_id)
      ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_agent_jobs'::regclass
      AND conname = 'commerce_agent_jobs_conversation_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_agent_jobs
      ADD CONSTRAINT commerce_agent_jobs_conversation_owner_fk
      FOREIGN KEY (conversation_id, tenant_id, user_id)
      REFERENCES public.commerce_agent_conversations (id, tenant_id, user_id)
      ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_agent_job_events'::regclass
      AND conname = 'commerce_agent_job_events_job_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_agent_job_events
      ADD CONSTRAINT commerce_agent_job_events_job_owner_fk
      FOREIGN KEY (job_id, tenant_id, user_id)
      REFERENCES public.commerce_agent_jobs (id, tenant_id, user_id)
      ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_feishu_notification_outbox'::regclass
      AND conname = 'commerce_feishu_outbox_reissued_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_feishu_notification_outbox
      ADD CONSTRAINT commerce_feishu_outbox_reissued_owner_fk
      FOREIGN KEY (reissued_from_id, tenant_id, user_id)
      REFERENCES public.commerce_feishu_notification_outbox (id, tenant_id, user_id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_feishu_notification_events'::regclass
      AND conname = 'commerce_feishu_events_outbox_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_feishu_notification_events
      ADD CONSTRAINT commerce_feishu_events_outbox_owner_fk
      FOREIGN KEY (outbox_id, tenant_id, user_id)
      REFERENCES public.commerce_feishu_notification_outbox (id, tenant_id, user_id)
      ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_action_review_schedules'::regclass
      AND conname = 'commerce_review_schedules_job_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_action_review_schedules
      ADD CONSTRAINT commerce_review_schedules_job_owner_fk
      FOREIGN KEY (job_id, tenant_id, user_id)
      REFERENCES public.commerce_agent_jobs (id, tenant_id, user_id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_action_review_schedules'::regclass
      AND conname = 'commerce_review_schedules_result_run_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_action_review_schedules
      ADD CONSTRAINT commerce_review_schedules_result_run_owner_fk
      FOREIGN KEY (review_run_id, conversation_id, tenant_id, user_id)
      REFERENCES public.commerce_agent_runs (id, conversation_id, tenant_id, user_id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_action_review_schedules'::regclass
      AND conname = 'commerce_review_schedules_result_message_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_action_review_schedules
      ADD CONSTRAINT commerce_review_schedules_result_message_owner_fk
      FOREIGN KEY (review_message_id, conversation_id, tenant_id, user_id, review_run_id)
      REFERENCES public.commerce_agent_messages
        (id, conversation_id, tenant_id, user_id, run_id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_weekly_diagnosis_runs'::regclass
      AND conname = 'commerce_weekly_diagnosis_supersedes_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_weekly_diagnosis_runs
      ADD CONSTRAINT commerce_weekly_diagnosis_supersedes_owner_fk
      FOREIGN KEY (supersedes_run_id, tenant_id, user_id)
      REFERENCES public.commerce_weekly_diagnosis_runs (id, tenant_id, user_id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_weekly_diagnosis_runs'::regclass
      AND conname = 'commerce_weekly_diagnosis_job_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_weekly_diagnosis_runs
      ADD CONSTRAINT commerce_weekly_diagnosis_job_owner_fk
      FOREIGN KEY (agent_job_id, tenant_id, user_id)
      REFERENCES public.commerce_agent_jobs (id, tenant_id, user_id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_weekly_diagnosis_runs'::regclass
      AND conname = 'commerce_weekly_diagnosis_result_conversation_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_weekly_diagnosis_runs
      ADD CONSTRAINT commerce_weekly_diagnosis_result_conversation_owner_fk
      FOREIGN KEY (result_conversation_id, tenant_id, user_id)
      REFERENCES public.commerce_agent_conversations (id, tenant_id, user_id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_weekly_diagnosis_runs'::regclass
      AND conname = 'commerce_weekly_diagnosis_result_run_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_weekly_diagnosis_runs
      ADD CONSTRAINT commerce_weekly_diagnosis_result_run_owner_fk
      FOREIGN KEY (result_run_id, result_conversation_id, tenant_id, user_id)
      REFERENCES public.commerce_agent_runs (id, conversation_id, tenant_id, user_id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commerce_weekly_diagnosis_runs'::regclass
      AND conname = 'commerce_weekly_diagnosis_result_message_owner_fk'
  ) THEN
    ALTER TABLE public.commerce_weekly_diagnosis_runs
      ADD CONSTRAINT commerce_weekly_diagnosis_result_message_owner_fk
      FOREIGN KEY
        (result_message_id, result_conversation_id, tenant_id, user_id, result_run_id)
      REFERENCES public.commerce_agent_messages
        (id, conversation_id, tenant_id, user_id, run_id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
END
$commerce_control_owner_foreign_keys$;

ALTER TABLE commerce_agent_messages
  VALIDATE CONSTRAINT commerce_agent_messages_conversation_owner_fk;
ALTER TABLE commerce_agent_messages
  VALIDATE CONSTRAINT commerce_agent_messages_run_owner_fk;
ALTER TABLE commerce_agent_runs
  VALIDATE CONSTRAINT commerce_agent_runs_conversation_owner_fk;
ALTER TABLE commerce_agent_jobs
  VALIDATE CONSTRAINT commerce_agent_jobs_conversation_owner_fk;
ALTER TABLE commerce_agent_job_events
  VALIDATE CONSTRAINT commerce_agent_job_events_job_owner_fk;
ALTER TABLE commerce_feishu_notification_outbox
  VALIDATE CONSTRAINT commerce_feishu_outbox_reissued_owner_fk;
ALTER TABLE commerce_feishu_notification_events
  VALIDATE CONSTRAINT commerce_feishu_events_outbox_owner_fk;
ALTER TABLE commerce_action_review_schedules
  VALIDATE CONSTRAINT commerce_review_schedules_job_owner_fk;
ALTER TABLE commerce_action_review_schedules
  VALIDATE CONSTRAINT commerce_review_schedules_result_run_owner_fk;
ALTER TABLE commerce_action_review_schedules
  VALIDATE CONSTRAINT commerce_review_schedules_result_message_owner_fk;
ALTER TABLE commerce_weekly_diagnosis_runs
  VALIDATE CONSTRAINT commerce_weekly_diagnosis_supersedes_owner_fk;
ALTER TABLE commerce_weekly_diagnosis_runs
  VALIDATE CONSTRAINT commerce_weekly_diagnosis_job_owner_fk;
ALTER TABLE commerce_weekly_diagnosis_runs
  VALIDATE CONSTRAINT commerce_weekly_diagnosis_result_conversation_owner_fk;
ALTER TABLE commerce_weekly_diagnosis_runs
  VALIDATE CONSTRAINT commerce_weekly_diagnosis_result_run_owner_fk;
ALTER TABLE commerce_weekly_diagnosis_runs
  VALIDATE CONSTRAINT commerce_weekly_diagnosis_result_message_owner_fk;

ALTER TABLE commerce_weekly_diagnosis_runs
  DROP CONSTRAINT IF EXISTS commerce_weekly_diagnosis_result_all_or_none_check;
ALTER TABLE commerce_weekly_diagnosis_runs
  ADD CONSTRAINT commerce_weekly_diagnosis_result_all_or_none_check CHECK (
    (result_conversation_id IS NULL AND result_run_id IS NULL AND result_message_id IS NULL)
    OR
    (result_conversation_id IS NOT NULL AND result_run_id IS NOT NULL
      AND result_message_id IS NOT NULL)
  ) NOT VALID;
ALTER TABLE commerce_weekly_diagnosis_runs
  VALIDATE CONSTRAINT commerce_weekly_diagnosis_result_all_or_none_check;

-- Single source of truth for reclaiming Jobs whose lease expired while running: dead-letters
-- attempts that already exhausted max_attempts, requeues the rest, and appends the matching
-- job_events row for each transition. Both the Worker claim path (job-store.ts) and the
-- retention cleanup script call this function, so a lease-expired Job is always resolved by
-- the same rule regardless of which caller happens to observe it first.
CREATE OR REPLACE FUNCTION commerce_reap_expired_jobs()
RETURNS TABLE(dead_lettered_count INTEGER, requeued_count INTEGER)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $commerce_reap_jobs$
DECLARE
  v_job RECORD;
  v_correction RECORD;
  v_dead_lettered INTEGER;
  v_requeued INTEGER;
BEGIN
  v_dead_lettered := 0;
  v_requeued := 0;

  -- Process one Job at a time so the feedback advisory lock is acquired before the
  -- latest event is read. A single set-based statement would retain an old command
  -- snapshot while waiting on the lock and could still calculate a stale version.
  FOR v_job IN
    SELECT id, tenant_id, user_id
    FROM commerce_agent_jobs
    WHERE status = 'running'
      AND lease_expires_at < clock_timestamp()
      AND attempt_count >= max_attempts
    ORDER BY id
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE commerce_agent_jobs
    SET status = 'dead_letter', error_code = 'JOB_LEASE_EXHAUSTED',
        error_message = 'Worker lease expired too many times.', completed_at = NOW(),
        lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
    WHERE id = v_job.id
      AND status = 'running'
      AND lease_expires_at < clock_timestamp()
      AND attempt_count >= max_attempts;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    v_dead_lettered := v_dead_lettered + 1;
    PERFORM public.commerce_settle_model_budget(v_job.id, NULL, NULL);

    INSERT INTO commerce_agent_job_events (job_id, tenant_id, user_id, event_type, payload)
    VALUES (
      v_job.id, v_job.tenant_id, v_job.user_id, 'dead_lettered',
      jsonb_build_object('status', 'dead_letter', 'code', 'JOB_LEASE_EXHAUSTED')
    );

    FOR v_correction IN
      SELECT DISTINCT feedback_id
      FROM commerce_agent_feedback_events
      WHERE tenant_id = v_job.tenant_id
        AND job_id = v_job.id
        AND event_type = 'correction_enqueued'
    LOOP
      -- Keep this lock key identical to reviewer and Worker transitions. The following
      -- INSERT is a new SQL command, so it obtains a fresh snapshot after the lock.
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'commerce-feedback:' || v_job.tenant_id || ':' || v_correction.feedback_id, 0
      ));
      INSERT INTO commerce_agent_feedback_events
        (feedback_id, tenant_id, actor_user_id, actor_display_name, event_type,
         version, note, idempotency_key, request_sha256, job_id)
      SELECT correction.feedback_id, correction.tenant_id,
             'system:commerce-worker', 'Commerce Agent Worker', 'correction_failed',
             correction.version + 1,
             'JOB_LEASE_EXHAUSTED: Worker lease expired too many times.',
             'correction-terminal:' || v_job.id || ':failed',
           'sha256:' || encode(sha256(convert_to(json_build_object(
               'feedbackId', correction.feedback_id,
               'jobId', v_job.id,
               'eventType', 'correction_failed',
               'runId', NULL::text,
               'errorCode', 'JOB_LEASE_EXHAUSTED'
             )::text, 'UTF8')), 'hex'),
             v_job.id
      FROM commerce_agent_feedback_events AS correction
      WHERE correction.tenant_id = v_job.tenant_id
        AND correction.feedback_id = v_correction.feedback_id
        AND correction.job_id = v_job.id
        AND correction.event_type = 'correction_enqueued'
        AND NOT EXISTS (
          SELECT 1
          FROM commerce_agent_feedback_events AS newer
          WHERE newer.tenant_id = correction.tenant_id
            AND newer.feedback_id = correction.feedback_id
            AND newer.version > correction.version
        )
      ON CONFLICT DO NOTHING
      ;
    END LOOP;
  END LOOP;

  FOR v_job IN
    SELECT id, tenant_id, user_id
    FROM commerce_agent_jobs
    WHERE status = 'running'
      AND lease_expires_at < clock_timestamp()
      AND attempt_count < max_attempts
    ORDER BY id
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE commerce_agent_jobs
    SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
        available_at = NOW(), updated_at = NOW()
    WHERE id = v_job.id
      AND status = 'running'
      AND lease_expires_at < clock_timestamp()
      AND attempt_count < max_attempts;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    v_requeued := v_requeued + 1;
    INSERT INTO commerce_agent_job_events (job_id, tenant_id, user_id, event_type, payload)
    VALUES (
      v_job.id, v_job.tenant_id, v_job.user_id, 'requeued',
      jsonb_build_object('status', 'queued', 'reason', 'lease_expired')
    );
  END LOOP;

  RETURN QUERY SELECT v_dead_lettered, v_requeued;
END
$commerce_reap_jobs$;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Revoke that implicit
-- capability here; deploy/postgres/commerce-control-grants.sql grants it only to the runtime
-- and maintenance roles that also hold the underlying least-privilege table permissions.
REVOKE ALL ON FUNCTION public.commerce_reap_expired_jobs() FROM PUBLIC;

CREATE TABLE IF NOT EXISTS commerce_agent_workers (
  id             TEXT        PRIMARY KEY,
  revision       TEXT        NOT NULL,
  status         TEXT        NOT NULL CHECK (status IN ('running', 'stopped')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS commerce_agent_workers_heartbeat_idx
  ON commerce_agent_workers (status, heartbeat_at DESC);

-- Defense-in-depth tenant isolation for the runtime control plane. API/service calls set
-- commerce.tenant_id and commerce.user_id transaction-locally. Only the dedicated Worker
-- login may activate commerce.control_system; a caller-controlled GUC is never sufficient.
-- The table owner is admitted only while the migration transaction explicitly carries the
-- commerce.control_migration flag used at the top of this file. Missing context sees no rows.
ALTER TABLE commerce_agent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_job_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_job_events FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_feedback FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_feedback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_feedback_events FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_report_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_report_shares FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_action_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_action_events FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_action_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_agent_action_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_tenant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_tenant_members FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_feishu_notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_feishu_notification_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_feishu_notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_feishu_notification_events FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_action_review_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_action_review_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_weekly_diagnosis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_weekly_diagnosis_runs FORCE ROW LEVEL SECURITY;

DO $commerce_control_rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'commerce_agent_conversations',
    'commerce_agent_messages',
    'commerce_agent_runs',
    'commerce_agent_jobs',
    'commerce_agent_job_events',
    'commerce_agent_feedback',
    'commerce_agent_reports',
    'commerce_agent_report_shares',
    'commerce_agent_action_events',
    'commerce_agent_action_reviews',
    'commerce_feishu_notification_outbox',
    'commerce_feishu_notification_events',
    'commerce_action_review_schedules',
    'commerce_weekly_diagnosis_runs'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS commerce_control_identity ON %I', table_name);
    EXECUTE format(
       'CREATE POLICY commerce_control_identity ON %I FOR ALL USING (
         (current_setting(''commerce.control_system'', true) = ''on''
          AND current_user = ''commerce_control_worker_user'')
         OR (current_setting(''commerce.control_migration'', true) = ''on''
             AND current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = %L::regclass)))
         OR (tenant_id = NULLIF(current_setting(''commerce.tenant_id'', true), '''')
             AND user_id = NULLIF(current_setting(''commerce.user_id'', true), ''''))
       ) WITH CHECK (
         (current_setting(''commerce.control_system'', true) = ''on''
          AND current_user = ''commerce_control_worker_user'')
         OR (current_setting(''commerce.control_migration'', true) = ''on''
             AND current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = %L::regclass)))
         OR (tenant_id = NULLIF(current_setting(''commerce.tenant_id'', true), '''')
             AND user_id = NULLIF(current_setting(''commerce.user_id'', true), ''''))
       )',
      table_name,
      table_name,
      table_name
    );
  END LOOP;
END
$commerce_control_rls$;

-- Retention has a separate login with a deliberately smaller SQL grant set. Its
-- role-bound policy cannot be activated by the API login and therefore does not
-- reuse the Worker system switch. Table grants remain the operation-level limit.
DO $commerce_control_maintenance_rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'commerce_agent_conversations',
    'commerce_agent_runs',
    'commerce_agent_jobs',
    'commerce_agent_job_events',
    'commerce_agent_feedback',
    'commerce_agent_feedback_events',
    'commerce_agent_report_shares'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS commerce_control_maintenance ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY commerce_control_maintenance ON %I FOR ALL USING (
         current_setting(''commerce.control_maintenance'', true) = ''on''
         AND current_user = ''commerce_maintenance_user''
       ) WITH CHECK (
         current_setting(''commerce.control_maintenance'', true) = ''on''
         AND current_user = ''commerce_maintenance_user''
       )',
      table_name
    );
  END LOOP;
END
$commerce_control_maintenance_rls$;

DROP POLICY IF EXISTS commerce_tenant_members_select ON commerce_tenant_members;
CREATE POLICY commerce_tenant_members_select ON commerce_tenant_members
  FOR SELECT
  USING (
    (current_setting('commerce.control_system', true) = 'on'
     AND current_user = 'commerce_control_worker_user')
    OR (current_setting('commerce.control_migration', true) = 'on'
        AND current_user = pg_get_userbyid(
          (SELECT relowner FROM pg_class WHERE oid = 'commerce_tenant_members'::regclass)
        ))
    OR tenant_id = NULLIF(current_setting('commerce.tenant_id', true), '')
  );
DROP POLICY IF EXISTS commerce_tenant_members_system_write ON commerce_tenant_members;
CREATE POLICY commerce_tenant_members_system_write ON commerce_tenant_members
  FOR ALL
  USING (
    (current_setting('commerce.control_system', true) = 'on'
     AND current_user = 'commerce_control_worker_user')
    OR (current_setting('commerce.control_migration', true) = 'on'
        AND current_user = pg_get_userbyid(
          (SELECT relowner FROM pg_class WHERE oid = 'commerce_tenant_members'::regclass)
        ))
  )
  WITH CHECK (
    (current_setting('commerce.control_system', true) = 'on'
     AND current_user = 'commerce_control_worker_user')
    OR (current_setting('commerce.control_migration', true) = 'on'
        AND current_user = pg_get_userbyid(
          (SELECT relowner FROM pg_class WHERE oid = 'commerce_tenant_members'::regclass)
        ))
  );

-- A reviewer is tenant-scoped, not system-scoped. It may inspect feedback source material
-- across users in the same tenant, but these policies never permit reviewer UPDATE/DELETE.
DO $commerce_feedback_reviewer_rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'commerce_agent_conversations',
    'commerce_agent_messages',
    'commerce_agent_runs',
    'commerce_agent_evidence',
    'commerce_agent_feedback'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS commerce_feedback_reviewer_select ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY commerce_feedback_reviewer_select ON %I FOR SELECT USING (
         current_setting(''commerce.feedback_reviewer'', true) = ''on''
         AND tenant_id = NULLIF(current_setting(''commerce.tenant_id'', true), '''')
       )',
      table_name
    );
  END LOOP;
END
$commerce_feedback_reviewer_rls$;

DROP POLICY IF EXISTS commerce_feedback_events_identity_select ON commerce_agent_feedback_events;
CREATE POLICY commerce_feedback_events_identity_select ON commerce_agent_feedback_events
  FOR SELECT
  USING (
    (current_setting('commerce.control_system', true) = 'on'
     AND current_user = 'commerce_control_worker_user')
    OR (current_setting('commerce.control_migration', true) = 'on'
        AND current_user = pg_get_userbyid(
          (SELECT relowner FROM pg_class WHERE oid = 'commerce_agent_feedback_events'::regclass)
        ))
    OR (
      tenant_id = NULLIF(current_setting('commerce.tenant_id', true), '')
      AND (
        current_setting('commerce.feedback_reviewer', true) = 'on'
        OR EXISTS (
          SELECT 1 FROM commerce_agent_feedback AS feedback
          WHERE feedback.id = commerce_agent_feedback_events.feedback_id
            AND feedback.tenant_id = commerce_agent_feedback_events.tenant_id
            AND feedback.user_id = NULLIF(current_setting('commerce.user_id', true), '')
        )
      )
    )
  );

DROP POLICY IF EXISTS commerce_feedback_events_reviewer_insert ON commerce_agent_feedback_events;
CREATE POLICY commerce_feedback_events_reviewer_insert ON commerce_agent_feedback_events
  FOR INSERT
  WITH CHECK (
    (current_setting('commerce.control_system', true) = 'on'
     AND current_user = 'commerce_control_worker_user')
    OR (current_setting('commerce.control_migration', true) = 'on'
        AND current_user = pg_get_userbyid(
          (SELECT relowner FROM pg_class WHERE oid = 'commerce_agent_feedback_events'::regclass)
        ))
    OR (
      current_setting('commerce.feedback_reviewer', true) = 'on'
      AND tenant_id = NULLIF(current_setting('commerce.tenant_id', true), '')
      AND actor_user_id = NULLIF(current_setting('commerce.user_id', true), '')
      AND EXISTS (
        SELECT 1 FROM commerce_agent_feedback AS feedback
        WHERE feedback.id = commerce_agent_feedback_events.feedback_id
          AND feedback.tenant_id = commerce_agent_feedback_events.tenant_id
      )
    )
  );

DROP POLICY IF EXISTS commerce_control_identity ON commerce_agent_evidence;
CREATE POLICY commerce_control_identity ON commerce_agent_evidence
  FOR ALL
  USING (
    (current_setting('commerce.control_system', true) = 'on'
     AND current_user = 'commerce_control_worker_user')
    OR (current_setting('commerce.control_migration', true) = 'on'
        AND current_user = pg_get_userbyid(
          (SELECT relowner FROM pg_class WHERE oid = 'commerce_agent_evidence'::regclass)
        ))
    OR (
      tenant_id = NULLIF(current_setting('commerce.tenant_id', true), '')
      AND EXISTS (
        SELECT 1 FROM commerce_agent_runs AS owned_run
        WHERE owned_run.id = commerce_agent_evidence.run_id
          AND owned_run.user_id = NULLIF(current_setting('commerce.user_id', true), '')
      )
    )
  )
  WITH CHECK (
    (current_setting('commerce.control_system', true) = 'on'
     AND current_user = 'commerce_control_worker_user')
    OR (current_setting('commerce.control_migration', true) = 'on'
        AND current_user = pg_get_userbyid(
          (SELECT relowner FROM pg_class WHERE oid = 'commerce_agent_evidence'::regclass)
        ))
    OR (
      tenant_id = NULLIF(current_setting('commerce.tenant_id', true), '')
      AND EXISTS (
        SELECT 1 FROM commerce_agent_runs AS owned_run
        WHERE owned_run.id = commerce_agent_evidence.run_id
          AND owned_run.user_id = NULLIF(current_setting('commerce.user_id', true), '')
      )
    )
  );

-- Prometheus is served by the Web process, whose role must never activate the
-- Worker's unrestricted control-plane context. Expose only fixed aggregates
-- through a narrow SECURITY DEFINER function so monitoring cannot become a
-- tenant-data read primitive. The owner-bound migration flag is transaction
-- local and still requires the function owner to own the RLS-protected tables.
CREATE OR REPLACE FUNCTION commerce_collect_control_metrics(worker_stale_ms INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $commerce_collect_control_metrics$
DECLARE
  snapshot JSONB;
BEGIN
  PERFORM set_config('commerce.control_migration', 'on', true);
  SELECT jsonb_build_object(
    'jobs', COALESCE((
      SELECT jsonb_agg(to_jsonb(job_metric) ORDER BY job_metric.status)
      FROM (
        SELECT status::TEXT AS status, COUNT(*)::BIGINT AS count
        FROM public.commerce_agent_jobs
        GROUP BY status
      ) AS job_metric
    ), '[]'::JSONB),
    'runs', COALESCE((
      SELECT jsonb_agg(to_jsonb(run_metric) ORDER BY run_metric.status)
      FROM (
        SELECT status::TEXT AS status,
               COUNT(*)::BIGINT AS count,
               COALESCE(SUM(EXTRACT(EPOCH FROM (completed_at - started_at)))
                 FILTER (WHERE completed_at IS NOT NULL), 0) AS duration_sum,
               COUNT(completed_at)::BIGINT AS duration_count
        FROM public.commerce_agent_runs
        GROUP BY status
      ) AS run_metric
    ), '[]'::JSONB),
    'totals', (
      SELECT jsonb_build_object(
        'input_tokens', COALESCE(SUM(input_tokens), 0),
        'output_tokens', COALESCE(SUM(output_tokens), 0),
        'total_tokens', COALESCE(SUM(total_tokens), 0),
        'evidence_count', (SELECT COUNT(*)::BIGINT FROM public.commerce_agent_evidence)
      )
      FROM public.commerce_agent_runs
    ),
    'workers', (
      SELECT jsonb_build_object('active', COUNT(*)::BIGINT)
      FROM public.commerce_agent_workers
      WHERE status = 'running'
        AND heartbeat_at >= NOW() - (
          GREATEST(1, LEAST(COALESCE(worker_stale_ms, 60000), 3600000))
          * INTERVAL '1 millisecond'
        )
    ),
    'queue', (
      SELECT jsonb_build_object(
        'depth', COUNT(*)::BIGINT,
        'oldest_seconds', COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)
      )
      FROM public.commerce_agent_jobs
      WHERE status = 'queued'
    ),
    'tool_calls', COALESCE((
      SELECT jsonb_agg(to_jsonb(tool_metric) ORDER BY tool_metric.operation)
      FROM (
        SELECT operation, COUNT(*)::BIGINT AS count
        FROM public.commerce_agent_evidence
        GROUP BY operation
      ) AS tool_metric
    ), '[]'::JSONB),
    'model_budget', (
      SELECT jsonb_build_object(
        'reserved_usd', COALESCE(SUM(reserved_usd), 0),
        'spent_usd', COALESCE(SUM(spent_usd), 0)
      )
      FROM public.commerce_agent_model_budget_daily
      WHERE budget_date = (NOW() AT TIME ZONE 'UTC')::DATE
    ),
    'notifications', COALESCE((
      SELECT jsonb_agg(to_jsonb(notification_metric) ORDER BY notification_metric.status)
      FROM (
        SELECT status::TEXT AS status, COUNT(*)::BIGINT AS count
        FROM public.commerce_feishu_notification_outbox
        GROUP BY status
      ) AS notification_metric
    ), '[]'::JSONB),
    'review_schedules', COALESCE((
      SELECT jsonb_agg(to_jsonb(review_metric) ORDER BY review_metric.status)
      FROM (
        SELECT status::TEXT AS status, COUNT(*)::BIGINT AS count
        FROM public.commerce_action_review_schedules
        GROUP BY status
      ) AS review_metric
    ), '[]'::JSONB),
    'weekly_diagnoses', COALESCE((
      SELECT jsonb_agg(to_jsonb(diagnosis_metric) ORDER BY diagnosis_metric.status)
      FROM (
        SELECT status::TEXT AS status, COUNT(*)::BIGINT AS count
        FROM public.commerce_weekly_diagnosis_runs
        GROUP BY status
      ) AS diagnosis_metric
    ), '[]'::JSONB)
  ) INTO snapshot;
  RETURN snapshot;
END
$commerce_collect_control_metrics$;

REVOKE ALL ON FUNCTION public.commerce_collect_control_metrics(INTEGER) FROM PUBLIC;

COMMIT;
