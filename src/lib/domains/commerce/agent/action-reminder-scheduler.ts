import { createHash } from 'node:crypto';

import type { CommerceDatabase } from './database';
import { getCommerceControlDatabase, withCommerceControlSystem } from './database';

interface ReminderRow extends Record<string, unknown> {
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  message_id: string;
  run_id: string;
  action_id: string;
  event_type: string;
  version: unknown;
  details_json: unknown;
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requestHash(row: ReminderRow, nextVersion: number): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    tenantId: row.tenant_id,
    userId: row.user_id,
    messageId: row.message_id,
    actionId: row.action_id,
    fromVersion: nextVersion - 1,
    toVersion: nextVersion,
    eventType: 'reminder_due',
  })).digest('hex')}`;
}

export class PostgresCommerceActionReminderScheduler {
  constructor(private readonly database: CommerceDatabase) {}

  runDue(input: { now?: Date; limit?: number } = {}): Promise<number> {
    const now = input.now ?? new Date();
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      const candidates = await client.query<ReminderRow>(
        `SELECT event.tenant_id, event.user_id, event.conversation_id,
                event.message_id, event.run_id, event.action_id,
                event.event_type, event.version, event.details_json
         FROM commerce_agent_action_events AS event
         WHERE event.event_type = 'snoozed'
           AND (event.details_json #>> '{reminder,snoozeUntil}')::timestamptz <= $1
           AND NOT EXISTS (
             SELECT 1 FROM commerce_agent_action_events AS newer
             WHERE newer.tenant_id = event.tenant_id
               AND newer.user_id = event.user_id
               AND newer.message_id = event.message_id
               AND newer.action_id = event.action_id
               AND newer.version > event.version
           )
         ORDER BY (event.details_json #>> '{reminder,snoozeUntil}')::timestamptz,
                  event.tenant_id, event.message_id, event.action_id
         LIMIT $2`,
        [now.toISOString(), limit],
      );
      let inserted = 0;
      for (const candidate of candidates.rows) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`commerce-action:${candidate.tenant_id}:${candidate.user_id}:${candidate.message_id}:${candidate.action_id}`],
        );
        const latest = await client.query<ReminderRow>(
          `SELECT event.tenant_id, event.user_id, event.conversation_id,
                  event.message_id, event.run_id, event.action_id,
                  event.event_type, event.version, event.details_json
           FROM commerce_agent_action_events AS event
           WHERE event.tenant_id = $1 AND event.user_id = $2
             AND event.message_id = $3 AND event.action_id = $4
           ORDER BY event.version DESC
           LIMIT 1
           FOR UPDATE`,
          [
            candidate.tenant_id,
            candidate.user_id,
            candidate.message_id,
            candidate.action_id,
          ],
        );
        const row = latest.rows[0];
        if (!row || row.event_type !== 'snoozed') continue;
        const details = parseJson(row.details_json);
        const snoozeUntil = String(
          (details.reminder as Record<string, unknown> | undefined)?.snoozeUntil ?? '',
        );
        if (Date.parse(snoozeUntil) > now.getTime() || !Number.isFinite(Date.parse(snoozeUntil))) {
          continue;
        }
        const currentVersion = Number(row.version);
        if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) continue;
        const nextVersion = currentVersion + 1;
        const nextDetails = {
          ...details,
          reminder: { status: 'due', snoozeUntil: null },
        };
        const result = await client.query(
          `INSERT INTO commerce_agent_action_events
             (tenant_id, user_id, conversation_id, message_id, run_id, action_id,
              event_type, version, actor_user_id, actor_display_name,
              idempotency_key, request_sha256, details_json, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'reminder_due', $7,
                   'system:commerce-reminder', 'Commerce Reminder Scheduler',
                   $8, $9, $10::jsonb, $11)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            row.tenant_id,
            row.user_id,
            row.conversation_id,
            row.message_id,
            row.run_id,
            row.action_id,
            nextVersion,
            `reminder-due:${row.action_id}:${nextVersion}`,
            requestHash(row, nextVersion),
            JSON.stringify(nextDetails),
            now.toISOString(),
          ],
        );
        inserted += result.rowCount;
      }
      return inserted;
    }));
  }
}

let singleton: PostgresCommerceActionReminderScheduler | null = null;

export function getCommerceActionReminderScheduler(): PostgresCommerceActionReminderScheduler {
  if (!singleton || process.env.NODE_ENV === 'test') {
    singleton = new PostgresCommerceActionReminderScheduler(getCommerceControlDatabase());
  }
  return singleton;
}
