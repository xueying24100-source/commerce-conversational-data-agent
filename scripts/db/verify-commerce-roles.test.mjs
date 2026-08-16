import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  SPECS,
  assertDistinctRoles,
  releaseRevision,
  roleEvidence,
  sslOptions,
  writeRoleEvidence,
} = require('./verify-commerce-roles.js');

const original = {
  NODE_ENV: process.env.NODE_ENV,
  COMMERCE_PG_SSL: process.env.COMMERCE_PG_SSL,
  COMMERCE_PG_REJECT_UNAUTHORIZED: process.env.COMMERCE_PG_REJECT_UNAUTHORIZED,
  COMMERCE_PG_CA: process.env.COMMERCE_PG_CA,
  COMMERCE_RELEASE_REVISION: process.env.COMMERCE_RELEASE_REVISION,
  COMMERCE_ROLE_EVIDENCE_PATH: process.env.COMMERCE_ROLE_EVIDENCE_PATH,
};
const evidenceFiles = [];

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const filename of evidenceFiles.splice(0)) fs.rmSync(filename, { force: true });
});

function entry(name, role) {
  return { spec: { name }, role };
}

function check(name, checkName) {
  return SPECS.find((spec) => spec.name === name)?.checks
    .find(([candidate]) => candidate === checkName)?.[1] || '';
}

function expectIndividualPrivileges(sql, table, privileges) {
  for (const privilege of privileges) {
    expect(sql).toContain(`has_table_privilege(current_user, '${table}', '${privilege}')`);
  }
  expect(sql).not.toMatch(
    /has_table_privilege\([^,]+,\s*'[^']+',\s*'[^']*,[^']*'\)/u,
  );
}

describe('Commerce database role verification', () => {
  it('rejects shared runtime and privileged role credentials', () => {
    expect(() => assertDistinctRoles([
      entry('control_api', 'shared'),
      entry('control_migration', 'shared'),
    ])).toThrow('must use different PostgreSQL roles');
  });

  it('accepts split role names', () => {
    expect(() => assertDistinctRoles([
      entry('control_api', 'control_api'),
      entry('control_worker', 'control_worker'),
      entry('control_migration', 'migration'),
      entry('control_maintenance', 'maintenance'),
      entry('control_backup', 'backup'),
      entry('analytics_readonly', 'readonly'),
      entry('analytics_ingest', 'ingest'),
      entry('analytics_migration', 'migration'),
      entry('analytics_backup', 'backup'),
    ])).not.toThrow();
  });

  it('keeps all seven responsibility groups mutually exclusive', () => {
    const groups = [
      ['control_api', ['control_api']],
      ['control_worker', ['control_worker']],
      ['analytics_readonly', ['analytics_readonly']],
      ['analytics_ingest', ['analytics_ingest']],
      ['control_maintenance', ['control_maintenance']],
      ['migration', ['control_migration', 'analytics_migration']],
      ['backup', ['control_backup', 'analytics_backup']],
    ];
    const baseline = groups.flatMap(([group, specs]) => (
      specs.map((name) => entry(name, `${group}_role`))
    ));

    for (let left = 0; left < groups.length; left += 1) {
      for (let right = left + 1; right < groups.length; right += 1) {
        const collision = baseline.map((candidate) => ({ ...candidate }));
        for (const specName of groups[right][1]) {
          collision.find((candidate) => candidate.spec.name === specName).role = `${groups[left][0]}_role`;
        }
        expect(
          () => assertDistinctRoles(collision),
          `${groups[left][0]} must be distinct from ${groups[right][0]}`,
        ).toThrow('must use different PostgreSQL roles');
      }
    }
  });

  it('requires verified TLS in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.COMMERCE_PG_SSL = '1';
    process.env.COMMERCE_PG_REJECT_UNAUTHORIZED = '1';
    process.env.COMMERCE_PG_CA = 'line-1\\nline-2';
    expect(sslOptions()).toEqual({ rejectUnauthorized: true, ca: 'line-1\nline-2' });
    process.env.COMMERCE_PG_REJECT_UNAUTHORIZED = '0';
    expect(() => sslOptions()).toThrow('verified PostgreSQL TLS');
  });

  it('requires an immutable revision for production role evidence', () => {
    process.env.NODE_ENV = 'production';
    process.env.COMMERCE_RELEASE_REVISION = 'unversioned';
    expect(() => releaseRevision()).toThrow('immutable revision');
    process.env.COMMERCE_RELEASE_REVISION = 'abc1234';
    expect(releaseRevision()).toBe('abc1234');
  });

  it('writes revision-bound role evidence without connection URLs or passwords', () => {
    process.env.NODE_ENV = 'production';
    process.env.COMMERCE_RELEASE_REVISION = 'abc1234';
    const filename = path.join(
      process.cwd(),
      'tmp',
      `commerce-role-evidence-${process.pid}-${Date.now()}.json`,
    );
    evidenceFiles.push(filename);
    process.env.COMMERCE_ROLE_EVIDENCE_PATH = filename;
    const roles = [{
      name: 'control_api',
      role: 'commerce_control_api_user',
      readOnly: false,
      checks: { control_jobs_write: true },
    }];

    expect(writeRoleEvidence(roles)).toEqual(roleEvidence(roles, 'abc1234'));
    const source = fs.readFileSync(filename, 'utf8');
    expect(JSON.parse(source)).toEqual({
      schemaVersion: 1,
      service: 'commerce-data-agent',
      revision: 'abc1234',
      status: 'passed',
      roles,
    });
    expect(source).not.toMatch(/postgres(?:ql)?:\/\//u);
    expect(source).not.toContain('password');
  });

  it('verifies source-fact and snapshot-delete capabilities for ingest and backup roles', () => {
    const ingest = SPECS.find((spec) => spec.name === 'analytics_ingest');
    const backup = SPECS.find((spec) => spec.name === 'analytics_backup');
    expect(ingest.checks).toEqual(expect.arrayContaining([
      expect.arrayContaining([
        'analytics_ingest_write',
        expect.stringMatching(/commerce_daily_metrics/u),
      ]),
      expect.arrayContaining([
        'analytics_ingest_source_facts_write',
        expect.stringMatching(/commerce_connector_source_facts/u),
      ]),
    ]));
    expect(backup.checks).toEqual(expect.arrayContaining([
      expect.arrayContaining([
        'analytics_backup_source_facts_select',
        expect.stringMatching(/commerce_connector_source_facts.*SELECT/u),
      ]),
    ]));
    expectIndividualPrivileges(
      check('analytics_ingest', 'analytics_ingest_write'),
      'public.commerce_daily_metrics',
      ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    );
    expectIndividualPrivileges(
      check('analytics_ingest', 'analytics_ingest_source_facts_write'),
      'public.commerce_connector_source_facts',
      ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    );
  });

  it('requires every privilege instead of PostgreSQL any-of privilege lists', () => {
    expectIndividualPrivileges(
      check('control_worker', 'control_jobs_write'),
      'public.commerce_agent_jobs',
      ['SELECT', 'INSERT', 'UPDATE'],
    );
    expectIndividualPrivileges(
      check('control_maintenance', 'maintenance_jobs'),
      'public.commerce_agent_jobs',
      ['SELECT', 'UPDATE', 'DELETE'],
    );
    expectIndividualPrivileges(
      check('control_maintenance', 'maintenance_feedback_events_append'),
      'public.commerce_agent_feedback_events',
      ['SELECT', 'INSERT'],
    );
    expectIndividualPrivileges(
      check('control_maintenance', 'maintenance_report_shares_cleanup'),
      'public.commerce_agent_report_shares',
      ['SELECT', 'DELETE'],
    );
    expectIndividualPrivileges(
      check('control_worker', 'control_feedback_append_only'),
      'public.commerce_agent_feedback',
      ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    );
    expectIndividualPrivileges(
      check('control_worker', 'control_feedback_events_append_only'),
      'public.commerce_agent_feedback_events',
      ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    );
    expectIndividualPrivileges(
      check('control_worker', 'control_reports_append_only'),
      'public.commerce_agent_reports',
      ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    );
    expect(check('control_worker', 'control_report_shares_mutable')).toMatch(/has_column_privilege[\s\S]*revoked_at[\s\S]*UPDATE/u);
  });

  it('denies business-table writes and public schema creation outside migration duties', () => {
    for (const [specName, checkName] of [
      ['analytics_readonly', 'analytics_no_business_writes'],
      ['control_backup', 'control_backup_no_business_writes'],
      ['analytics_backup', 'analytics_backup_no_business_writes'],
    ]) {
      const sql = check(specName, checkName);
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        expect(sql).toContain(`'${privilege}'`);
      }
      expect(sql).toMatch(/SELECT NOT EXISTS/u);
    }

    for (const spec of SPECS.filter((candidate) => !candidate.name.endsWith('_migration'))) {
      expect(spec.checks).toEqual(expect.arrayContaining([
        expect.arrayContaining([
          expect.stringMatching(/no_schema_create$/u),
          expect.stringMatching(/NOT has_schema_privilege\(current_user, 'public', 'CREATE'\)/u),
        ]),
      ]));
    }
  });

  it('keeps deployment grants aligned with the verified source-fact capabilities', () => {
    const grants = fs.readFileSync(
      path.join(process.cwd(), 'deploy', 'postgres', 'commerce-analytics-grants.sql'),
      'utf8',
    );
    expect(grants).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE commerce_daily_metrics TO commerce_ingest_user/u);
    expect(grants).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE\s+commerce_connector_source_facts\s+TO commerce_ingest_user/u);
    expect(grants).toMatch(/GRANT SELECT ON TABLE[\s\S]*commerce_connector_source_facts,[\s\S]*TO commerce_backup_user/u);
  });

  it('verifies the least-privilege maintenance lease-recovery capabilities', () => {
    const runtime = SPECS.find((spec) => spec.name === 'control_worker');
    const maintenance = SPECS.find((spec) => spec.name === 'control_maintenance');
    const backup = SPECS.find((spec) => spec.name === 'control_backup');

    expect(runtime.checks).toEqual(expect.arrayContaining([
      expect.arrayContaining([
        'control_reap_execute',
        expect.stringMatching(/commerce_reap_expired_jobs\(\).*EXECUTE/u),
      ]),
    ]));
    expect(maintenance.checks).toEqual(expect.arrayContaining([
      expect.arrayContaining([
        'maintenance_job_events_insert',
        expect.stringMatching(/commerce_agent_job_events.*INSERT/u),
      ]),
      expect.arrayContaining([
        'maintenance_job_events_append_only',
        expect.stringMatching(/NOT has_table_privilege[\s\S]*SELECT[\s\S]*UPDATE[\s\S]*DELETE/u),
      ]),
      expect.arrayContaining([
        'maintenance_job_events_sequence',
        expect.stringMatching(/commerce_agent_job_events_id_seq.*USAGE/u),
      ]),
      expect.arrayContaining([
        'maintenance_job_events_sequence_limited',
        expect.stringMatching(/NOT has_sequence_privilege[\s\S]*SELECT[\s\S]*UPDATE/u),
      ]),
      expect.arrayContaining([
        'maintenance_feedback_select',
        expect.stringMatching(/commerce_agent_feedback.*SELECT/u),
      ]),
      expect.arrayContaining([
        'maintenance_feedback_events_append',
        expect.stringMatching(/commerce_agent_feedback_events[\s\S]*SELECT[\s\S]*INSERT/u),
      ]),
      expect.arrayContaining([
        'maintenance_feedback_events_append_only',
        expect.stringMatching(/NOT has_table_privilege[\s\S]*UPDATE[\s\S]*DELETE/u),
      ]),
      expect.arrayContaining([
        'maintenance_feedback_events_sequence',
        expect.stringMatching(/commerce_agent_feedback_events_id_seq.*USAGE/u),
      ]),
      expect.arrayContaining([
        'maintenance_feedback_events_sequence_limited',
        expect.stringMatching(/NOT has_sequence_privilege[\s\S]*SELECT[\s\S]*UPDATE/u),
      ]),
      expect.arrayContaining([
        'maintenance_reap_execute',
        expect.stringMatching(/commerce_reap_expired_jobs\(\).*EXECUTE/u),
      ]),
    ]));
    expect(backup.checks).toEqual(expect.arrayContaining([
      expect.arrayContaining([
        'control_backup_no_reap_execute',
        expect.stringMatching(/NOT has_function_privilege[\s\S]*commerce_reap_expired_jobs/u),
      ]),
    ]));
  });

  it('separates API and Worker control capabilities and binds system RLS to Worker', () => {
    const api = SPECS.find((spec) => spec.name === 'control_api');
    const worker = SPECS.find((spec) => spec.name === 'control_worker');
    expect(api).toMatchObject({
      env: 'COMMERCE_CONTROL_API_DATABASE_URL',
      expectedRole: 'commerce_control_api_user',
      systemRls: 'deny',
    });
    expect(worker).toMatchObject({
      env: 'COMMERCE_CONTROL_WORKER_DATABASE_URL',
      expectedRole: 'commerce_control_worker_user',
      systemRls: 'allow',
    });
    expect(check('control_api', 'control_api_no_system_functions')).toMatch(
      /NOT has_function_privilege[\s\S]*commerce_reap_expired_jobs[\s\S]*commerce_settle_model_budget/u,
    );
    expect(check('control_worker', 'control_reap_execute')).not.toMatch(/NOT /u);
    const verifier = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'db', 'verify-commerce-roles.js'),
      'utf8',
    );
    expect(verifier).toMatch(/pg_auth_members[\s\S]*must not participate/u);
    expect(verifier).toMatch(/pg_database[\s\S]*pg_namespace[\s\S]*pg_class[\s\S]*pg_proc/u);
    expect(verifier).toMatch(/control_api_self_set_system_denied/u);
    const migration = fs.readFileSync(
      path.join(process.cwd(), 'migrations', 'commerce-control.sql'),
      'utf8',
    );
    for (const match of migration.matchAll(/current_setting\('commerce\.control_system'[\s\S]{0,120}/gu)) {
      expect(match[0]).toContain("current_user = 'commerce_control_worker_user'");
    }
  });

  it('keeps operator feedback append-only and backup-visible', () => {
    const runtime = SPECS.find((spec) => spec.name === 'control_worker');
    const backup = SPECS.find((spec) => spec.name === 'control_backup');
    expect(runtime.checks).toEqual(expect.arrayContaining([
      expect.arrayContaining(['control_feedback_append_only', expect.stringMatching(/commerce_agent_feedback[\s\S]*SELECT[\s\S]*commerce_agent_feedback[\s\S]*INSERT[\s\S]*UPDATE[\s\S]*DELETE/u)]),
      expect.arrayContaining(['control_feedback_reviewer_sources_select', expect.stringMatching(/commerce_agent_conversations[\s\S]*SELECT/u)]),
    ]));
    expect(backup.checks).toEqual(expect.arrayContaining([
      expect.arrayContaining(['control_backup_feedback_select', expect.stringMatching(/commerce_agent_feedback.*SELECT/u)]),
      expect.arrayContaining(['control_backup_feedback_events_select', expect.stringMatching(/commerce_agent_feedback_events.*SELECT/u)]),
    ]));
    const grants = fs.readFileSync(path.join(process.cwd(), 'deploy', 'postgres', 'commerce-control-grants.sql'), 'utf8');
    const migration = fs.readFileSync(path.join(process.cwd(), 'migrations', 'commerce-control.sql'), 'utf8');
    expect(grants).toMatch(/GRANT SELECT, INSERT ON TABLE[\s\S]*commerce_agent_feedback[\s\S]*TO commerce_control_api_user, commerce_control_worker_user/u);
    expect(grants).not.toMatch(/GRANT[^;]*(?:UPDATE|DELETE)[^;]*commerce_agent_feedback[^;]*TO commerce_control_(?:api|worker)_user/u);
    expect(grants).toMatch(/GRANT SELECT, INSERT ON TABLE[\s\S]*commerce_agent_feedback_events[\s\S]*TO commerce_control_api_user, commerce_control_worker_user/u);
    expect(grants).not.toMatch(/GRANT[^;]*(?:UPDATE|DELETE)[^;]*commerce_agent_feedback_events[^;]*TO commerce_control_(?:api|worker)_user/u);
    expect(grants).toMatch(/GRANT USAGE ON SEQUENCE commerce_agent_feedback_events_id_seq\s+TO commerce_control_api_user, commerce_control_worker_user/u);
    expect(migration).toMatch(/commerce_agent_feedback[\s\S]*ENABLE ROW LEVEL SECURITY/u);
    expect(migration).toMatch(/commerce_agent_feedback[\s\S]*FORCE ROW LEVEL SECURITY/u);
    expect(migration).toMatch(/'commerce_agent_feedback'[\s\S]*CREATE POLICY commerce_control_identity/u);
    expect(migration).toMatch(/DO \$commerce_feedback_reviewer_rls\$[\s\S]*'commerce_agent_conversations'[\s\S]*CREATE POLICY commerce_feedback_reviewer_select/u);
  });

  it('keeps frozen reports append-only, owner-scoped and backup-visible', () => {
    const runtime = SPECS.find((spec) => spec.name === 'control_worker');
    const backup = SPECS.find((spec) => spec.name === 'control_backup');
    expect(runtime.checks).toEqual(expect.arrayContaining([
      expect.arrayContaining(['control_reports_append_only', expect.stringMatching(/commerce_agent_reports[\s\S]*SELECT[\s\S]*INSERT[\s\S]*UPDATE[\s\S]*DELETE/u)]),
      expect.arrayContaining(['control_report_shares_mutable', expect.stringMatching(/commerce_agent_report_shares[\s\S]*revoked_at[\s\S]*UPDATE[\s\S]*NOT has_column_privilege[\s\S]*DELETE/u)]),
      expect.arrayContaining(['control_action_events_append_only', expect.stringMatching(/commerce_agent_action_events[\s\S]*SELECT[\s\S]*INSERT[\s\S]*UPDATE[\s\S]*DELETE/u)]),
      expect.arrayContaining(['control_action_reviews_append_only', expect.stringMatching(/commerce_agent_action_reviews[\s\S]*SELECT[\s\S]*INSERT[\s\S]*UPDATE[\s\S]*DELETE/u)]),
    ]));
    expect(backup.checks).toEqual(expect.arrayContaining([
      expect.arrayContaining(['control_backup_reports_select', expect.stringMatching(/commerce_agent_reports.*SELECT/u)]),
      expect.arrayContaining(['control_backup_report_shares_select', expect.stringMatching(/commerce_agent_report_shares.*SELECT/u)]),
      expect.arrayContaining(['control_backup_action_events_select', expect.stringMatching(/commerce_agent_action_events.*SELECT/u)]),
      expect.arrayContaining(['control_backup_action_reviews_select', expect.stringMatching(/commerce_agent_action_reviews.*SELECT/u)]),
    ]));
    const grants = fs.readFileSync(path.join(process.cwd(), 'deploy', 'postgres', 'commerce-control-grants.sql'), 'utf8');
    const migration = fs.readFileSync(path.join(process.cwd(), 'migrations', 'commerce-control.sql'), 'utf8');
    expect(grants).toMatch(/GRANT SELECT, INSERT ON TABLE[\s\S]*commerce_agent_reports[\s\S]*TO commerce_control_api_user, commerce_control_worker_user/u);
    expect(grants).toMatch(/GRANT SELECT, INSERT ON TABLE commerce_agent_report_shares\s+TO commerce_control_api_user, commerce_control_worker_user/u);
    expect(grants).toMatch(/GRANT UPDATE \(revoked_at\) ON TABLE commerce_agent_report_shares\s+TO commerce_control_api_user, commerce_control_worker_user/u);
    expect(grants).toMatch(/GRANT SELECT, INSERT ON TABLE[\s\S]*commerce_agent_action_events[\s\S]*TO commerce_control_api_user, commerce_control_worker_user/u);
    expect(grants).toMatch(/GRANT SELECT, INSERT ON TABLE[\s\S]*commerce_agent_action_reviews[\s\S]*TO commerce_control_api_user, commerce_control_worker_user/u);
    expect(grants).not.toMatch(/GRANT[^;]*(?:UPDATE|DELETE)[^;]*commerce_agent_reports[^;]*TO commerce_control_(?:api|worker)_user/u);
    expect(grants).not.toMatch(/GRANT[^;]*DELETE[^;]*commerce_agent_report_shares[^;]*TO commerce_control_(?:api|worker)_user/u);
    expect(grants).toMatch(/GRANT SELECT ON TABLE[\s\S]*commerce_agent_reports[\s\S]*TO commerce_backup_user/u);
    expect(grants).toMatch(/GRANT SELECT ON TABLE[\s\S]*commerce_agent_report_shares[\s\S]*TO commerce_backup_user/u);
    expect(migration).toMatch(/commerce_agent_reports[\s\S]*ENABLE ROW LEVEL SECURITY/u);
    expect(migration).toMatch(/commerce_agent_reports[\s\S]*FORCE ROW LEVEL SECURITY/u);
    expect(migration).toMatch(/commerce_agent_report_shares[\s\S]*FORCE ROW LEVEL SECURITY/u);
    expect(migration).toMatch(/expires_at <= created_at \+ INTERVAL '7 days'/u);
    expect(migration).toMatch(/commerce_agent_action_reviews[\s\S]*FORCE ROW LEVEL SECURITY/u);
  });

  it('verifies budget, Feishu and scheduler tables for runtime and backup roles', () => {
    for (const [name, table, privileges] of [
      ['control_model_budget_daily_write', 'public.commerce_agent_model_budget_daily', ['SELECT', 'INSERT', 'UPDATE']],
      ['control_model_budget_reservations_write', 'public.commerce_agent_model_budget_reservations', ['SELECT', 'INSERT', 'UPDATE']],
      ['control_feishu_outbox_write', 'public.commerce_feishu_notification_outbox', ['SELECT', 'INSERT', 'UPDATE']],
      ['control_review_schedules_write', 'public.commerce_action_review_schedules', ['SELECT', 'INSERT', 'UPDATE']],
      ['control_weekly_diagnosis_runs_write', 'public.commerce_weekly_diagnosis_runs', ['SELECT', 'INSERT', 'UPDATE']],
    ]) {
      expectIndividualPrivileges(check('control_worker', name), table, privileges);
    }
    expect(check('control_worker', 'control_tenant_members_read_only')).toMatch(
      /commerce_tenant_members.*SELECT.*NOT has_table_privilege/u,
    );
    expect(check('control_worker', 'control_feishu_events_append_only')).toMatch(
      /commerce_feishu_notification_events.*SELECT.*INSERT.*NOT has_table_privilege.*USAGE/u,
    );
    expect(check('control_backup', 'control_backup_model_budget_select')).toMatch(
      /commerce_agent_model_budget_daily.*commerce_agent_model_budget_reservations/u,
    );
    expect(check('control_backup', 'control_backup_orchestration_select')).toMatch(
      /commerce_tenant_members.*commerce_feishu_notification_outbox.*commerce_action_review_schedules.*commerce_weekly_diagnosis_runs/u,
    );
  });

  it('revokes catalog refresh from PUBLIC and grants it only to ingest', () => {
    const grants = fs.readFileSync(
      path.join(process.cwd(), 'deploy', 'postgres', 'commerce-analytics-grants.sql'),
      'utf8',
    );
    const migration = fs.readFileSync(
      path.join(process.cwd(), 'migrations', 'commerce-analytics.sql'),
      'utf8',
    );

    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.commerce_refresh_tenant_catalog\(TEXT\) FROM PUBLIC/u,
    );
    expect(grants).toMatch(
      /REVOKE ALL ON FUNCTION public\.commerce_refresh_tenant_catalog\(TEXT\)[\s\S]*FROM PUBLIC, commerce_readonly_user, commerce_ingest_user, commerce_backup_user/u,
    );
    expect(grants).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.commerce_refresh_tenant_catalog\(TEXT\) TO commerce_ingest_user/u,
    );
    expect(check('analytics_ingest', 'catalog_refresh_execute')).not.toMatch(/NOT /u);
    expect(check('analytics_readonly', 'analytics_no_catalog_refresh')).toMatch(/NOT /u);
    expect(check('analytics_backup', 'analytics_backup_no_catalog_refresh')).toMatch(/NOT /u);
  });

  it('revokes public schema creation before applying non-migration grants', () => {
    for (const filename of ['commerce-control-grants.sql', 'commerce-analytics-grants.sql']) {
      const grants = fs.readFileSync(
        path.join(process.cwd(), 'deploy', 'postgres', filename),
        'utf8',
      );
      expect(grants).toMatch(/REVOKE CREATE ON SCHEMA public FROM PUBLIC/u);
    }
  });

  it('keeps control grants append-only and revokes the function from PUBLIC', () => {
    const grants = fs.readFileSync(
      path.join(process.cwd(), 'deploy', 'postgres', 'commerce-control-grants.sql'),
      'utf8',
    );
    const migration = fs.readFileSync(
      path.join(process.cwd(), 'migrations', 'commerce-control.sql'),
      'utf8',
    );

    expect(grants).toMatch(/REVOKE ALL ON TABLE commerce_agent_job_events FROM commerce_maintenance_user/u);
    expect(grants).toMatch(/GRANT INSERT ON TABLE commerce_agent_job_events TO commerce_maintenance_user/u);
    expect(grants).toMatch(/REVOKE ALL ON SEQUENCE commerce_agent_job_events_id_seq FROM commerce_maintenance_user/u);
    expect(grants).toMatch(/GRANT USAGE ON SEQUENCE commerce_agent_job_events_id_seq TO commerce_maintenance_user/u);
    expect(grants).toMatch(/GRANT SELECT ON TABLE commerce_agent_feedback TO commerce_maintenance_user/u);
    expect(grants).toMatch(/GRANT SELECT, INSERT ON TABLE commerce_agent_feedback_events TO commerce_maintenance_user/u);
    expect(grants).not.toMatch(/GRANT (?:UPDATE|DELETE)[^;]*commerce_agent_feedback_events TO commerce_maintenance_user/u);
    expect(grants).toMatch(/GRANT USAGE ON SEQUENCE commerce_agent_feedback_events_id_seq TO commerce_maintenance_user/u);
    expect(grants).toMatch(/REVOKE ALL ON FUNCTION public\.commerce_reap_expired_jobs\(\)[\s\S]*FROM PUBLIC, commerce_control_user, commerce_control_api_user, commerce_control_worker_user,[\s\S]*commerce_backup_user/u);
    expect(grants).toMatch(/GRANT EXECUTE ON FUNCTION public\.commerce_reap_expired_jobs\(\)[\s\S]*TO commerce_control_worker_user, commerce_maintenance_user/u);
    expect(grants).toMatch(/GRANT EXECUTE ON FUNCTION public\.commerce_settle_model_budget\(TEXT, BIGINT, BIGINT\)[\s\S]*TO commerce_control_worker_user, commerce_maintenance_user/u);
    expect(grants).toMatch(/REVOKE ALL ON FUNCTION public\.commerce_collect_control_metrics\(INTEGER\)[\s\S]*FROM PUBLIC, commerce_control_user, commerce_control_api_user, commerce_control_worker_user,[\s\S]*commerce_backup_user/u);
    expect(grants).toMatch(/GRANT EXECUTE ON FUNCTION public\.commerce_collect_control_metrics\(INTEGER\)[\s\S]*TO commerce_control_api_user, commerce_control_worker_user/u);
    expect(grants).not.toMatch(/GRANT (?:SELECT|UPDATE|DELETE)[^;]*commerce_agent_job_events TO commerce_maintenance_user/u);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.commerce_reap_expired_jobs\(\) FROM PUBLIC/u);
    expect(migration).toMatch(/INSERT INTO commerce_agent_job_events[\s\S]*'dead_lettered'/u);
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION commerce_settle_model_budget[\s\S]*SECURITY DEFINER[\s\S]*REVOKE ALL ON FUNCTION public\.commerce_settle_model_budget/u);
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION commerce_collect_control_metrics[\s\S]*SECURITY DEFINER[\s\S]*REVOKE ALL ON FUNCTION public\.commerce_collect_control_metrics\(INTEGER\) FROM PUBLIC/u);
    expect(migration).toMatch(/status = 'dead_letter'[\s\S]*commerce_settle_model_budget\(v_job\.id, NULL, NULL\)/u);
    expect(migration).toMatch(/INSERT INTO commerce_agent_feedback_events[\s\S]*'correction_failed'[\s\S]*'correction-terminal:' \|\| v_job\.id \|\| ':failed'/u);
    expect(migration).toMatch(/sha256\(convert_to\(json_build_object\([\s\S]*'errorCode', 'JOB_LEASE_EXHAUSTED'/u);
    const cleanup = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'db', 'cleanup-commerce.js'),
      'utf8',
    );
    expect(cleanup).toMatch(/if \(production && !retentionRaw\)[\s\S]*COMMERCE_RETENTION_DAYS must be explicitly configured in production/u);
    expect(cleanup).toMatch(/Number\.parseInt\(retentionRaw \|\| '90', 10\)/u);
    expect(cleanup).toMatch(/JOB_QUEUE_EXPIRED[\s\S]*INSERT INTO commerce_agent_feedback_events[\s\S]*'correction_failed'/u);
    expect(cleanup).toMatch(/JOB_QUEUE_EXPIRED[\s\S]*commerce_settle_model_budget\(\$1, NULL, NULL\)/u);
    expect(cleanup).toMatch(/status IN \('completed', 'failed', 'dead_letter'\)/u);
    expect(cleanup).toMatch(/sha256\(convert_to\(json_build_object\([\s\S]*'errorCode', 'JOB_QUEUE_EXPIRED'/u);
    expect(cleanup).toMatch(/DELETE FROM commerce_agent_report_shares[\s\S]*expires_at <= clock_timestamp\(\)/u);
  });

  it('keeps administrator role hardening out of transactional schema-owner grants', () => {
    const bootstrap = fs.readFileSync(
      path.join(process.cwd(), 'deploy', 'postgres', 'commerce-role-bootstrap.sql'),
      'utf8',
    );
    expect(bootstrap.trim()).toMatch(/^--[\s\S]*?BEGIN;/u);
    expect(bootstrap.trim()).toMatch(/COMMIT;$/u);
    expect(bootstrap).toMatch(/ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/u);
    for (const filename of ['commerce-control-grants.sql', 'commerce-analytics-grants.sql']) {
      const grants = fs.readFileSync(path.join(process.cwd(), 'deploy', 'postgres', filename), 'utf8');
      expect(grants.trim()).toMatch(/^--[\s\S]*?BEGIN;/u);
      expect(grants.trim()).toMatch(/COMMIT;$/u);
      expect(grants).not.toMatch(/\bALTER ROLE\b/u);
    }
  });

  it('retains the N-1 enqueue compatibility default during the rollback window', () => {
    const migration = fs.readFileSync(
      path.join(process.cwd(), 'migrations', 'commerce-control.sql'),
      'utf8',
    );
    expect(migration).toMatch(/required_revision TEXT\s+NOT NULL DEFAULT 'unversioned'/u);
    expect(migration).toMatch(/ALTER COLUMN required_revision SET DEFAULT 'unversioned'/u);
    expect(migration).toMatch(/ALTER COLUMN required_revision SET NOT NULL/u);
  });
});
