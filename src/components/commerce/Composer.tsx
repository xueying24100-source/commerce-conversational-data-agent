import { ArrowUp, CircleAlert, LoaderCircle } from 'lucide-react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { COMMERCE_MESSAGE_MAX_CHARS } from '@/lib/domains/commerce/agent/limits';
import { MODEL_LABELS } from './client';
import type { ModelId } from './types';

export type ComposerProps = {
  draft: string;
  onDraftChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent) => void;
  sending: boolean;
  ready: boolean;
  error: string | null;
  isNewConversation: boolean;
  model: ModelId;
  availableModels: ModelId[];
  onModelChange: (model: ModelId) => void;
};

export function Composer({
  draft,
  onDraftChange,
  onKeyDown,
  onSubmit,
  sending,
  ready,
  error,
  isNewConversation,
  model,
  availableModels,
  onModelChange,
}: ComposerProps) {
  return (
    <div className="border-t border-violet-100 bg-white/50 p-4 backdrop-blur-md">
      {error ? (
        <div className="mx-auto mb-3 flex max-w-4xl items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}
      <form onSubmit={onSubmit} className="mx-auto max-w-4xl">
        {isNewConversation ? (
          <div className="mb-2 flex items-center justify-between gap-3">
            <select
              aria-label="新会话模型"
              value={model}
              onChange={(event) => onModelChange(event.target.value as ModelId)}
              disabled={sending || !ready}
              className="rounded-lg border border-violet-200 bg-white/80 px-2.5 py-1.5 text-xs font-medium text-indigo-700 outline-none focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20 disabled:opacity-50"
            >
              {(availableModels.length ? availableModels : Object.keys(MODEL_LABELS) as ModelId[]).map((id) => (
                <option key={id} value={id}>{MODEL_LABELS[id]}</option>
              ))}
            </select>
            <span className="text-[10px] text-violet-700">新会话模型</span>
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={sending || !ready}
            rows={2}
            maxLength={COMMERCE_MESSAGE_MAX_CHARS}
            placeholder={ready ? '询问经营数据；Enter 发送，Shift + Enter 换行' : '完成生产配置后开放提问'}
            className="flex-1"
          />
          <Button
            type="submit"
            size="icon"
            disabled={sending || !ready || draft.trim().length < 2}
            aria-label="发送问题"
          >
            {sending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </Button>
        </div>
        <p className="mt-2 text-xs text-violet-700">Enter 发送 · Shift + Enter 换行 · 无规则 fallback，无任意 SQL</p>
      </form>
    </div>
  );
}
