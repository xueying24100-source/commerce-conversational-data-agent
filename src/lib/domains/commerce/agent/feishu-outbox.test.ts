import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommerceDatabase, CommerceQueryResult, CommerceSqlClient } from './database';
import { CommerceAuthorizationError } from './auth';
import {
  CommerceNotificationInvalidStateError,
  CommerceNotificationKillSwitchError,
  CommerceNotificationRecipientError,
  FeishuNotificationClient,
  PostgresCommerceFeishuOutboxStore,
} from './feishu-outbox';
import type { CommerceIdentity } from './types';

const identity: CommerceIdentity = {
  tenantId: 'tenant_feishu',
  userId: 'operator_feishu',
  displayName: 'Feishu operator',
  scopes: ['commerce:data:read', 'commerce:notifications:write'],
  authMode: 'development',
};
const actionId = `action_${'f'.repeat(24)}`;
const answer = {
  status: 'answered' as const,
  answer: '经营结论。',
  answerClaims: [],
  findings: [],
  recommendations: [{
    id: actionId,
    action: '复核付费社媒流量',
    rationale: '已观察到流量下降集中在该渠道。',
    claims: [{
      evidenceId: 'ev_1234567890', path: '/0/current', metric: 'visits' as const,
      value: 300, unit: 'integer' as const,
    }],
    priority: 'high' as const,
    deadline: '2026-08-20',
    status: 'proposed' as const,
  }],
  followUps: [],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe('Commerce Feishu logical outbox', () => {
  it('fails closed before SQL when notifications are enabled without an operator allowlist', async () => {
    let sqlCalls = 0;
    const store = new PostgresCommerceFeishuOutboxStore(new ScriptedDatabase(() => {
      sqlCalls += 1;
      return result();
    }), { enabled: true, operatorAllowlist: new Set() });

    expect(() => store.enqueueApprovedAction(identity, {
      conversationId: 'conv_1234567890123456',
      messageId: 'msg_1234567890123456',
      actionId,
      expectedActionVersion: 1,
      recipientMemberId: 'member_growth',
      requestId: 'approval-request-no-allowlist',
    })).toThrow(CommerceAuthorizationError);
    expect(sqlCalls).toBe(0);
  });

  it('fails closed inside the Outbox transaction when the global kill switch is enabled', async () => {
    vi.stubEnv('COMMERCE_GLOBAL_KILL_SWITCH', 'true');
    let sqlCalls = 0;
    const database = new ScriptedDatabase(() => {
      sqlCalls += 1;
      return result();
    });
    const store = new PostgresCommerceFeishuOutboxStore(database, {
      enabled: true,
      operatorAllowlist: new Set([identity.userId]),
    });

    await expect(store.enqueueApprovedAction(identity, {
      conversationId: 'conv_1234567890123456',
      messageId: 'msg_1234567890123456',
      actionId,
      expectedActionVersion: 1,
      recipientMemberId: 'member_growth',
      requestId: 'approval-request-kill-switch',
    })).rejects.toBeInstanceOf(CommerceNotificationKillSwitchError);
    expect(sqlCalls).toBe(0);
  });

  it('rolls back before the Outbox write when the kill switch changes during validation', async () => {
    vi.stubEnv('COMMERCE_GLOBAL_KILL_SWITCH', 'false');
    let outboxWrites = 0;
    const database = new ScriptedDatabase((text) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('FROM commerce_agent_messages AS message')) {
        return result([{ answer_json: answer, run_id: 'run_1234567890123456' }]);
      }
      if (text.includes('FROM commerce_agent_action_events')) {
        return result([{ event_type: 'confirmed', version: 1 }]);
      }
      if (text.includes('FROM commerce_tenant_members') && text.includes('member_id = $2')) {
        return result([{
          member_id: 'member_growth', display_name: '增长负责人',
          feishu_open_id: 'ou_growth', can_receive_notifications: true,
        }]);
      }
      if (text.includes('approval_request_id = $3')) return result();
      if (text.includes("outbox.channel = 'feishu'")) {
        vi.stubEnv('COMMERCE_GLOBAL_KILL_SWITCH', 'true');
        return result();
      }
      if (text.includes('INSERT INTO commerce_feishu_notification_outbox')) {
        outboxWrites += 1;
        return result();
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const store = new PostgresCommerceFeishuOutboxStore(database, {
      enabled: true,
      operatorAllowlist: new Set([identity.userId]),
    });

    await expect(store.enqueueApprovedAction(identity, {
      conversationId: 'conv_1234567890123456',
      messageId: 'msg_1234567890123456',
      actionId,
      expectedActionVersion: 1,
      recipientMemberId: 'member_growth',
      requestId: 'approval-request-kill-race',
    })).rejects.toBeInstanceOf(CommerceNotificationKillSwitchError);
    expect(outboxWrites).toBe(0);
  });

  it('folds ten approval replays into one logical command and stable request UUID', async () => {
    let persisted: Record<string, unknown> | null = null;
    let outboxInserts = 0;
    let approvalEvents = 0;
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('FROM commerce_agent_messages AS message')) {
        return result([{ answer_json: answer, run_id: 'run_1234567890123456' }]);
      }
      if (text.includes('FROM commerce_agent_action_events')) {
        return result([{ event_type: 'confirmed', version: 1 }]);
      }
      if (text.includes('FROM commerce_tenant_members') && text.includes('member_id = $2')) {
        expect(values).toEqual([identity.tenantId, 'member_growth']);
        return result([{
          member_id: 'member_growth', display_name: '增长负责人',
          feishu_open_id: 'ou_growth', can_receive_notifications: true,
        }]);
      }
      if (text.includes('approval_request_id = $3')) {
        return result(persisted ? [persisted] : []);
      }
      if (text.includes("outbox.channel = 'feishu'")) return result();
      if (text.includes('INSERT INTO commerce_feishu_notification_outbox')) {
        outboxInserts += 1;
        persisted = {
          id: values[0],
          action_id: values[5],
          action_version: values[6],
          recipient_member_id: values[7],
          recipient_display_name: '增长负责人',
          request_uuid: values[8],
          status: 'pending',
          provider_message_id: null,
          created_at: new Date('2026-08-16T01:00:00.000Z'),
          request_sha256: values[10],
        };
        return result([persisted]);
      }
      if (text.includes('INSERT INTO commerce_feishu_notification_events')) {
        approvalEvents += 1;
        return result();
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const store = new PostgresCommerceFeishuOutboxStore(database, {
      enabled: true,
      publicOrigin: 'https://commerce.example.test',
      operatorAllowlist: new Set([identity.userId]),
    });
    const command = {
      conversationId: 'conv_1234567890123456',
      messageId: 'msg_1234567890123456',
      actionId,
      expectedActionVersion: 1,
      recipientMemberId: 'member_growth',
      requestId: 'approval-request-12345678',
    };

    const receipts = [];
    for (let replay = 0; replay < 10; replay += 1) {
      receipts.push(await store.enqueueApprovedAction(identity, command));
    }
    expect(outboxInserts).toBe(1);
    expect(approvalEvents).toBe(1);
    expect(new Set(receipts.map((entry) => entry.id))).toHaveLength(1);
    expect(new Set(receipts.map((entry) => entry.requestUuid))).toHaveLength(1);
  });

  it('rejects an unconfirmed action and a member outside the authorized tenant mapping', async () => {
    const database = new ScriptedDatabase((text) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('FROM commerce_agent_messages AS message')) {
        return result([{ answer_json: answer, run_id: 'run_1234567890123456' }]);
      }
      if (text.includes('FROM commerce_agent_action_events')) {
        return result([{ event_type: 'snoozed', version: 1 }]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const store = new PostgresCommerceFeishuOutboxStore(database, {
      enabled: true,
      operatorAllowlist: new Set([identity.userId]),
    });
    await expect(store.enqueueApprovedAction(identity, {
      conversationId: 'conv_1234567890123456',
      messageId: 'msg_1234567890123456',
      actionId,
      expectedActionVersion: 1,
      recipientMemberId: 'member_growth',
      requestId: 'approval-request-invalid-state',
    })).rejects.toBeInstanceOf(CommerceNotificationInvalidStateError);

    const noMemberDatabase = new ScriptedDatabase((text) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('FROM commerce_agent_messages AS message')) {
        return result([{ answer_json: answer, run_id: 'run_1234567890123456' }]);
      }
      if (text.includes('FROM commerce_agent_action_events')) {
        return result([{ event_type: 'confirmed', version: 1 }]);
      }
      if (text.includes('FROM commerce_tenant_members')) return result();
      throw new Error(`Unexpected SQL: ${text}`);
    });
    await expect(new PostgresCommerceFeishuOutboxStore(noMemberDatabase, {
      enabled: true,
      operatorAllowlist: new Set([identity.userId]),
    })
      .enqueueApprovedAction(identity, {
        conversationId: 'conv_1234567890123456',
        messageId: 'msg_1234567890123456',
        actionId,
        expectedActionVersion: 1,
        recipientMemberId: 'member_cross_tenant',
        requestId: 'approval-request-cross-tenant',
      })).rejects.toBeInstanceOf(CommerceNotificationRecipientError);
  });

  it('reaps expired sending leases before claiming and rechecks recipient authorization', async () => {
    const statements: string[] = [];
    const database = new ScriptedDatabase((text) => {
      statements.push(text);
      if (text.includes('WITH expired AS')) return result();
      if (text.includes('WITH revoked AS')) return result();
      if (text.includes('WITH candidate AS')) {
        return result([{
          id: 'outbox_1234567890123456',
          action_id: actionId,
          action_version: 1,
          recipient_member_id: 'member_growth',
          recipient_display_name: '增长负责人',
          request_uuid: '123e4567-e89b-12d3-a456-426614174000',
          status: 'sending',
          provider_message_id: null,
          created_at: new Date('2026-08-16T01:00:00.000Z'),
          feishu_open_id: 'ou_growth',
          payload_json: { action: '复核渠道' },
          attempt_count: 2,
        }]);
      }
      if (text.includes('INSERT INTO commerce_feishu_notification_events')) return result();
      throw new Error(`Unexpected SQL: ${text}`);
    });

    const command = await new PostgresCommerceFeishuOutboxStore(database).claim('worker-a', 30_000);

    expect(command).toMatchObject({
      id: 'outbox_1234567890123456',
      recipientOpenId: 'ou_growth',
      attempts: 2,
    });
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/status = 'delivery_unknown'[\s\S]*lease_expires_at < clock_timestamp\(\)[\s\S]*'delivery_unknown'/u);
    expect(statements[1]).toMatch(/status = 'failed_permanent'[\s\S]*recipient_authorization_revoked/u);
    expect(statements[2]).toMatch(/member\.active[\s\S]*member\.can_receive_notifications[\s\S]*member\.feishu_open_id IS NOT NULL/u);
  });

  it('turns a revoked pending recipient into an audited permanent failure without claiming it', async () => {
    const statements: string[] = [];
    const database = new ScriptedDatabase((text) => {
      statements.push(text);
      if (text.includes('WITH expired AS')) return result();
      if (text.includes('WITH revoked AS')) {
        return result([{ outbox_id: 'outbox_revoked_123456' }]);
      }
      if (text.includes('WITH candidate AS')) return result();
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(new PostgresCommerceFeishuOutboxStore(database).claim('worker-a'))
      .resolves.toBeNull();
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain("SELECT id, tenant_id, user_id, 'failed_permanent'");
    expect(statements[1]).toContain("outbox.status IN ('pending', 'retryable')");
  });
});

describe('Feishu transport outcomes', () => {
  it('passes the stable request UUID and records the provider message ID', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('tenant_access_token')) {
        return new Response(JSON.stringify({ tenant_access_token: 'tenant-token' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_123' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const result = await new FeishuNotificationClient({
      appId: 'app-id', appSecret: 'app-secret', fetch: fetcher,
    }).send({
      recipientOpenId: 'ou_growth',
      requestUuid: '123e4567-e89b-12d3-a456-426614174000',
      payload: { action: '复核渠道', rationale: '检查流量下降。' },
    });
    expect(result).toEqual({ status: 'delivered', providerMessageId: 'om_123' });
    expect(requests[1]?.init?.headers).toMatchObject({
      'X-Request-Id': '123e4567-e89b-12d3-a456-426614174000',
    });
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
      uuid: '123e4567-e89b-12d3-a456-426614174000',
    });
  });

  it('marks a post-token transport exception as delivery_unknown instead of retrying blindly', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ tenant_access_token: 'tenant-token' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('socket timeout after upload');
    };
    const result = await new FeishuNotificationClient({
      appId: 'app-id', appSecret: 'app-secret', fetch: fetcher,
    }).send({
      recipientOpenId: 'ou_growth',
      requestUuid: '123e4567-e89b-12d3-a456-426614174000',
      payload: { action: '复核渠道' },
    });
    expect(result).toEqual({
      status: 'delivery_unknown',
      error: 'socket timeout after upload',
    });
    expect(calls).toBe(2);
  });
});
