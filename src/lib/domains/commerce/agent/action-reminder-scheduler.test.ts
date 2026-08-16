import { describe, expect, it } from 'vitest';

import type { CommerceDatabase, CommerceQueryResult, CommerceSqlClient } from './database';
import { PostgresCommerceActionReminderScheduler } from './action-reminder-scheduler';

function result(rows: Record<string, unknown>[] = []): CommerceQueryResult<Record<string, unknown>> {
  return { rows, rowCount: rows.length };
}

class ScriptedDatabase implements CommerceDatabase {
  constructor(private readonly execute: (
    text: string,
    values: readonly unknown[],
  ) => CommerceQueryResult<Record<string, unknown>>) {}
  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    if (text.includes("set_config('commerce.")) return Promise.resolve(result() as CommerceQueryResult<Row>);
    return Promise.resolve(this.execute(text, values) as CommerceQueryResult<Row>);
  }
  transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> { return work(this); }
  async ping(): Promise<void> {}
}

describe('Commerce action reminder scheduler', () => {
  it('marks an expired snooze due in-app without creating a Feishu command', async () => {
    const queries: string[] = [];
    const dueRow = {
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      conversation_id: 'conv_1234567890123456',
      message_id: 'msg_1234567890123456',
      run_id: 'run_1234567890123456',
      action_id: `action_${'a'.repeat(24)}`,
      event_type: 'snoozed',
      version: 3,
      details_json: {
        commitment: null,
        note: null,
        reminder: { status: 'snoozed', snoozeUntil: '2026-08-17T09:00:00.000Z' },
      },
    };
    const database = new ScriptedDatabase((text, values) => {
      queries.push(text);
      if (text.includes("event.event_type = 'snoozed'")) {
        expect(values).toEqual(['2026-08-17T10:00:00.000Z', 100]);
        return result([dueRow]);
      }
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('ORDER BY event.version DESC')) return result([dueRow]);
      if (text.includes('INSERT INTO commerce_agent_action_events')) {
        expect(values[6]).toBe(4);
        expect(JSON.parse(String(values[9]))).toMatchObject({
          reminder: { status: 'due', snoozeUntil: null },
        });
        return result([{ id: 9 }]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(new PostgresCommerceActionReminderScheduler(database).runDue({
      now: new Date('2026-08-17T10:00:00.000Z'),
    })).resolves.toBe(1);
    expect(queries.some((query) => query.includes('commerce_feishu_notification_outbox'))).toBe(false);
  });

  it('is a no-op before the snooze watermark is due', async () => {
    const database = new ScriptedDatabase((text) => {
      if (text.includes("event.event_type = 'snoozed'")) return result();
      throw new Error(`Unexpected SQL: ${text}`);
    });
    await expect(new PostgresCommerceActionReminderScheduler(database).runDue()).resolves.toBe(0);
  });

  it('rechecks the latest state under the action advisory lock before inserting', async () => {
    let inserted = false;
    const candidate = {
      tenant_id: 'tenant-a', user_id: 'user-a', conversation_id: 'conv-a',
      message_id: 'msg-a', run_id: 'run-a', action_id: 'action-a',
      event_type: 'snoozed', version: 3,
      details_json: { reminder: { status: 'snoozed', snoozeUntil: '2026-08-17T09:00:00.000Z' } },
    };
    const database = new ScriptedDatabase((text) => {
      if (text.includes("event.event_type = 'snoozed'")) return result([candidate]);
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('ORDER BY event.version DESC')) {
        return result([{ ...candidate, event_type: 'started', version: 4 }]);
      }
      if (text.includes('INSERT INTO commerce_agent_action_events')) inserted = true;
      return result();
    });
    await expect(new PostgresCommerceActionReminderScheduler(database).runDue({
      now: new Date('2026-08-17T10:00:00.000Z'),
    })).resolves.toBe(0);
    expect(inserted).toBe(false);
  });
});
