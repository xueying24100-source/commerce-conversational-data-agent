import { Boxes, ClipboardList, Plus, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils/cn';
import { ConversationList } from './ConversationList';
import type { ConversationSummary } from './types';

export type StatusTone = 'success' | 'warning' | 'info' | 'error';

const TONE_DOT: Record<StatusTone, string> = {
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  info: 'bg-blue-400',
  error: 'bg-red-400',
};

export type SidebarProps = {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onOpenActions: () => void;
  actionCount: number;
  identityName: string;
  identityContext: string;
  status: { label: string; tone: StatusTone };
};

export function Sidebar({
  conversations,
  activeId,
  onSelectConversation,
  onNewConversation,
  onOpenActions,
  actionCount,
  identityName,
  identityContext,
  status,
}: SidebarProps) {
  return (
    <aside className="relative hidden w-72 flex-col overflow-hidden bg-gradient-to-b from-indigo-950 to-violet-900 xl:flex">
      <div className="pointer-events-none absolute -right-10 -top-16 h-56 w-56 rounded-full bg-violet-500/20 blur-3xl" />
      <div className="pointer-events-none absolute -left-16 bottom-24 h-48 w-48 rounded-full bg-indigo-500/15 blur-3xl" />

      <div className="relative z-10 flex h-16 items-center gap-3 px-5">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-glow">
          <Boxes className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-lg font-bold text-white">Commerce Agent</p>
          <p className="text-[10px] uppercase tracking-wider text-violet-300">Data Agent</p>
        </div>
      </div>

      <div className="relative z-10 mx-4 mb-4">
        <Button type="button" onClick={onNewConversation} className="w-full">
          <Plus className="h-4 w-4" />
          新建分析会话
        </Button>
      </div>

      <div className="relative z-10 mx-4 mb-2">
        <button
          type="button"
          onClick={onOpenActions}
          className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm font-medium text-violet-100 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/50"
        >
          <span className="inline-flex items-center gap-2"><ClipboardList className="h-4 w-4" /> 运营行动台</span>
          <span className="min-w-6 rounded-full bg-violet-500/40 px-1.5 py-0.5 text-center text-[10px] font-bold text-white">
            {actionCount > 99 ? '99+' : actionCount}
          </span>
        </button>
      </div>

      <p className="relative z-10 px-4 py-2 text-xs font-medium uppercase tracking-wider text-violet-300">
        会话
      </p>

      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto pb-4">
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          onSelect={onSelectConversation}
        />
      </div>

      <div className="relative z-10 flex items-center gap-3 border-t border-white/10 bg-black/10 p-4">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-violet-800/60 text-violet-100">
          <UserRound className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">{identityName}</p>
          <p className="mt-0.5 truncate text-[10px] text-violet-300">{identityContext}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-violet-300">
            <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[status.tone])} />
            {status.label}
          </p>
        </div>
      </div>
    </aside>
  );
}
