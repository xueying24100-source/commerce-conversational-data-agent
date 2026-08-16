import { Bot, LoaderCircle, RotateCcw, TriangleAlert, UserRound } from 'lucide-react';
import type { RefObject } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { AssistantAnswer } from './AssistantAnswer';
import type { ActionState, AgentJob, ConversationMessage } from './types';

export type MessageListProps = {
  conversationId: string;
  messages: ConversationMessage[];
  sending: boolean;
  jobStatus: AgentJob['status'] | null;
  onFollowUp: (question: string) => void;
  onActionChange?: (messageId: string, state: ActionState) => void;
  onEvidenceNavigate?: (evidenceId: string) => void;
  onRetryFailed: (message: string) => void;
  endRef: RefObject<HTMLDivElement | null>;
};

export function MessageList({
  conversationId,
  messages,
  sending,
  jobStatus,
  onFollowUp,
  onActionChange,
  onEvidenceNavigate,
  onRetryFailed,
  endRef,
}: MessageListProps) {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      {messages.map((entry, index) => entry.role === 'user' ? (
        <div key={entry.id} className="flex animate-fade-in-up justify-end gap-3">
          <div className="max-w-[78%]">
            <div className="ml-auto w-fit rounded-2xl rounded-br-md bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-3 text-sm leading-6 text-white shadow-lg shadow-violet-500/25">
              {entry.content}
            </div>
            {entry.runStatus === 'failed' ? (
              <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-left text-xs text-rose-900">
                <div className="flex items-start gap-2">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{entry.runError?.message ?? '本次分析未完成，失败记录已保留。'}</p>
                    <p className="mt-1 text-[11px] text-rose-600">错误码：{entry.runError?.code ?? 'COMMERCE_AGENT_FAILED'}</p>
                  </div>
                  <button
                    type="button"
                    title="创建新的后台任务重新分析"
                    onClick={() => onRetryFailed(entry.content)}
                    disabled={sending || entry.runError?.retryable === false}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-rose-200 bg-white px-2 py-1 font-semibold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    重新运行
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <Avatar variant="user" icon={<UserRound className="h-4 w-4" />} />
        </div>
      ) : (
        <div id={`commerce-message-${entry.id}`} key={entry.id} className="flex animate-fade-in-up gap-3 scroll-mt-20">
          <Avatar variant="assistant" icon={<Bot className="h-4 w-4" />} />
          <div className="min-w-0 max-w-[92%] flex-1">
            <div className="rounded-2xl rounded-bl-md border border-white/50 bg-white/80 px-4 py-3 shadow-md shadow-violet-100 backdrop-blur-sm">
              <AssistantAnswer
                conversationId={conversationId}
                message={entry}
                sourceQuestion={messages.slice(0, index).findLast((message) => message.role === 'user')?.content}
                onFollowUp={onFollowUp}
                onActionChange={onActionChange}
                onEvidenceNavigate={onEvidenceNavigate}
              />
            </div>
          </div>
        </div>
      ))}
      {sending ? (
        <div className="flex animate-fade-in-up gap-3">
          <Avatar variant="assistant" icon={<LoaderCircle className="h-4 w-4 animate-spin" />} />
          <div className="rounded-2xl rounded-bl-md border border-white/50 bg-white/80 px-4 py-3 shadow-md shadow-violet-100 backdrop-blur-sm">
            <p className="text-sm font-semibold text-indigo-900">
              {jobStatus === 'queued' ? '任务正在等待 Worker' : '正在查询经营数据'}
            </p>
            <p className="mt-1 text-xs text-violet-700">
              {jobStatus === 'queued'
                ? '任务已持久化，可以安全等待队列调度。'
                : 'Agent 会自行选择指标、趋势或拆解工具，然后校验证据。'}
            </p>
          </div>
        </div>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}
