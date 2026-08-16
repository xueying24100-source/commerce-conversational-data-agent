import { describe, expect, it } from 'vitest';

import type { CommerceDatabase, CommerceQueryResult, CommerceSqlClient } from './database';
import { PostgresCommerceFeedbackStatusStore } from './feedback-status-store';
import type { CommerceIdentity } from './types';

const identity: CommerceIdentity = {
  tenantId: 'tenant_feedback',
  userId: 'operator_feedback',
  displayName: 'Feedback owner',
  scopes: ['commerce:data:read'],
  authMode: 'development',
};

class ScriptedDatabase implements CommerceDatabase {
  constructor(
    private readonly execute: (
      text: string,
      values: readonly unknown[],
    ) => CommerceQueryResult<Record<string, unknown>>,
  ) {}

  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    return Promise.resolve(this.execute(text, values) as CommerceQueryResult<Row>);
  }

  transaction<T>(_work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
    throw new Error('Unexpected transaction.');
  }

  async ping(): Promise<void> {}
}

function result(rows: Record<string, unknown>[] = []): CommerceQueryResult<Record<string, unknown>> {
  return { rows, rowCount: rows.length };
}

describe('Commerce feedback owner status store', () => {
  it('loads only the latest feedback for the authenticated owner and retains correction references', async () => {
    const database = new ScriptedDatabase((text, values) => {
      expect(text).toContain('feedback.tenant_id = $1 AND feedback.user_id = $2');
      expect(text).toContain('feedback.conversation_id = $3 AND feedback.message_id = $4');
      expect(text).toContain('event.job_id IS NOT NULL');
      expect(text).toContain('event.run_id IS NOT NULL');
      expect(values).toEqual([
        identity.tenantId,
        identity.userId,
        'conv_1234567890123456',
        'msg_assistant_12345678',
      ]);
      return result([{
        id: 'feedback_1',
        conversation_id: 'conv_1234567890123456',
        message_id: 'msg_assistant_12345678',
        category: 'wrong_metric',
        status: 'resolved',
        version: 4,
        review_note: '已按净收入口径重新核对。',
        correction_job_id: 'job_correction_1',
        correction_job_status: 'completed',
        correction_run_id: 'run_correction_1',
        created_at: new Date('2026-08-13T00:00:00.000Z'),
        updated_at: new Date('2026-08-13T00:05:00.000Z'),
      }]);
    });
    const store = new PostgresCommerceFeedbackStatusStore(database);

    await expect(store.getLatest(
      identity,
      'conv_1234567890123456',
      'msg_assistant_12345678',
    )).resolves.toMatchObject({
      status: 'resolved',
      version: 4,
      correctionJobId: 'job_correction_1',
      correctionJobStatus: 'completed',
      correctionRunId: 'run_correction_1',
    });
  });

  it('returns null when the owner has not submitted feedback for the message', async () => {
    const store = new PostgresCommerceFeedbackStatusStore(
      new ScriptedDatabase(() => result()),
    );

    await expect(store.getLatest(
      identity,
      'conv_1234567890123456',
      'msg_assistant_12345678',
    )).resolves.toBeNull();
  });
});
