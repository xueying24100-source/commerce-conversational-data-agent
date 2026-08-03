BEGIN;

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
  fetched_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS commerce_agent_evidence_run_idx
  ON commerce_agent_evidence (tenant_id, run_id, created_at ASC);

ALTER TABLE commerce_agent_evidence
  ADD COLUMN IF NOT EXISTS request_json JSONB;
ALTER TABLE commerce_agent_evidence
  ADD COLUMN IF NOT EXISTS source_watermark TIMESTAMPTZ;
UPDATE commerce_agent_evidence
  SET request_json = '{}'::jsonb
  WHERE request_json IS NULL;
ALTER TABLE commerce_agent_evidence
  ALTER COLUMN request_json SET NOT NULL;

CREATE TABLE IF NOT EXISTS commerce_agent_rate_limits (
  scope_key      TEXT        NOT NULL,
  window_start   TIMESTAMPTZ NOT NULL,
  request_count  INTEGER     NOT NULL,
  PRIMARY KEY (scope_key, window_start)
);
CREATE INDEX IF NOT EXISTS commerce_agent_rate_limits_window_idx
  ON commerce_agent_rate_limits (window_start);

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
  DROP CONSTRAINT IF EXISTS commerce_agent_jobs_status_check;
ALTER TABLE commerce_agent_jobs
  ADD CONSTRAINT commerce_agent_jobs_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'dead_letter'));

CREATE UNIQUE INDEX IF NOT EXISTS commerce_agent_jobs_request_idx
  ON commerce_agent_jobs (tenant_id, user_id, request_id);
CREATE INDEX IF NOT EXISTS commerce_agent_jobs_claim_idx
  ON commerce_agent_jobs (status, available_at, created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS commerce_agent_jobs_owner_idx
  ON commerce_agent_jobs (tenant_id, user_id, created_at DESC);

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

COMMIT;
