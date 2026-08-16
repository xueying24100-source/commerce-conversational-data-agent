import type { CommerceDatabase } from './database';
import { getCommerceControlDatabase, withCommerceControlIdentity } from './database';
import type {
  CommerceAgentJobStatus,
  CommerceFeedbackCategory,
  CommerceFeedbackStatus,
  CommerceIdentity,
} from './types';

export interface CommerceFeedbackOwnerStatus {
  id: string;
  conversationId: string;
  messageId: string;
  category: CommerceFeedbackCategory;
  status: CommerceFeedbackStatus;
  version: number;
  reviewNote: string | null;
  correctionJobId: string | null;
  correctionJobStatus: CommerceAgentJobStatus | null;
  correctionRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

type FeedbackOwnerStatusRow = Record<string, unknown> & {
  id: string;
  conversation_id: string;
  message_id: string;
  category: CommerceFeedbackCategory;
  status: CommerceFeedbackStatus;
  version: unknown;
  review_note: string | null;
  correction_job_id: string | null;
  correction_job_status: CommerceAgentJobStatus | null;
  correction_run_id: string | null;
  created_at: unknown;
  updated_at: unknown;
};

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('Database returned an invalid timestamp.');
  return date.toISOString();
}

function ownerStatus(row: FeedbackOwnerStatusRow): CommerceFeedbackOwnerStatus {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    category: row.category,
    status: row.status,
    version: Number(row.version),
    reviewNote: row.review_note,
    correctionJobId: row.correction_job_id,
    correctionJobStatus: row.correction_job_status,
    correctionRunId: row.correction_run_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class PostgresCommerceFeedbackStatusStore {
  constructor(private readonly database: CommerceDatabase) {}

  getLatest(
    identity: CommerceIdentity,
    conversationId: string,
    messageId: string,
  ): Promise<CommerceFeedbackOwnerStatus | null> {
    return withCommerceControlIdentity(identity, async () => {
      const result = await this.database.query<FeedbackOwnerStatusRow>(
        `SELECT feedback.id, feedback.conversation_id, feedback.message_id, feedback.category,
                COALESCE(latest.event_type, 'received') AS status,
                COALESCE(latest.version, 0)::integer AS version,
                latest_note.note AS review_note,
                latest_job.job_id AS correction_job_id,
                correction_job.status AS correction_job_status,
                latest_run.run_id AS correction_run_id,
                feedback.created_at,
                COALESCE(latest.created_at, feedback.created_at) AS updated_at
         FROM commerce_agent_feedback AS feedback
         LEFT JOIN LATERAL (
           SELECT event.event_type, event.version, event.created_at
           FROM commerce_agent_feedback_events AS event
           WHERE event.feedback_id = feedback.id AND event.tenant_id = feedback.tenant_id
           ORDER BY event.version DESC, event.id DESC
           LIMIT 1
         ) AS latest ON true
         LEFT JOIN LATERAL (
           SELECT event.note
           FROM commerce_agent_feedback_events AS event
           WHERE event.feedback_id = feedback.id AND event.tenant_id = feedback.tenant_id
             AND event.note IS NOT NULL
           ORDER BY event.version DESC, event.id DESC
           LIMIT 1
         ) AS latest_note ON true
         LEFT JOIN LATERAL (
           SELECT event.job_id
           FROM commerce_agent_feedback_events AS event
           WHERE event.feedback_id = feedback.id AND event.tenant_id = feedback.tenant_id
             AND event.job_id IS NOT NULL
           ORDER BY event.version DESC, event.id DESC
           LIMIT 1
         ) AS latest_job ON true
         LEFT JOIN commerce_agent_jobs AS correction_job
           ON correction_job.id = latest_job.job_id
          AND correction_job.tenant_id = feedback.tenant_id
          AND correction_job.user_id = feedback.user_id
         LEFT JOIN LATERAL (
           SELECT event.run_id
           FROM commerce_agent_feedback_events AS event
           WHERE event.feedback_id = feedback.id AND event.tenant_id = feedback.tenant_id
             AND event.run_id IS NOT NULL
           ORDER BY event.version DESC, event.id DESC
           LIMIT 1
         ) AS latest_run ON true
         WHERE feedback.tenant_id = $1 AND feedback.user_id = $2
           AND feedback.conversation_id = $3 AND feedback.message_id = $4
         ORDER BY feedback.created_at DESC, feedback.id DESC
         LIMIT 1`,
        [identity.tenantId, identity.userId, conversationId, messageId],
      );
      return result.rows[0] ? ownerStatus(result.rows[0]) : null;
    });
  }
}

let singleton: PostgresCommerceFeedbackStatusStore | null = null;

export function getCommerceFeedbackStatusStore(): PostgresCommerceFeedbackStatusStore {
  singleton ??= new PostgresCommerceFeedbackStatusStore(getCommerceControlDatabase());
  return singleton;
}
