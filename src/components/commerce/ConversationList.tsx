import { Clock3 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { shortTime } from './client';
import type { ConversationSummary } from './types';

export type ConversationListProps = {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  className?: string;
};

export function ConversationList({ conversations, activeId, onSelect, className }: ConversationListProps) {
  if (!conversations.length) {
    return (
      <p className={cn('px-4 py-6 text-xs leading-5 text-violet-300', className)}>
        创建第一条真实数据分析会话后，它会出现在这里。
      </p>
    );
  }
  return (
    <div className={cn('space-y-1 px-2', className)}>
      {conversations.map((conversation) => {
        const selected = activeId === conversation.id;
        return (
          <button
            key={conversation.id}
            type="button"
            onClick={() => onSelect(conversation.id)}
            className={cn(
              'flex h-14 w-full flex-col justify-center rounded-xl px-4 text-left transition-all duration-200 ease-out',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/50',
              selected
                ? 'bg-gradient-to-r from-indigo-500/80 to-violet-500/80 text-white shadow-glow'
                : 'text-violet-200 hover:bg-white/10 hover:text-violet-50',
            )}
          >
            <p className="truncate text-sm font-medium">{conversation.title}</p>
            <p
              className={cn(
                'mt-0.5 flex items-center gap-1 text-xs',
                selected ? 'text-white/80' : 'text-violet-300',
              )}
            >
              <Clock3 className="h-3 w-3" /> {shortTime(conversation.updatedAt)}
            </p>
          </button>
        );
      })}
    </div>
  );
}
