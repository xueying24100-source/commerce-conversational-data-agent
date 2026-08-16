import { Plus, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConversationList } from './ConversationList';
import { MobileDrawer } from './MobileDrawer';
import type { ConversationSummary } from './types';

export type MobileConversationsPanelProps = {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewConversation: () => void;
  onClose: () => void;
};

export function MobileConversationsPanel({
  conversations,
  activeId,
  onSelect,
  onNewConversation,
  onClose,
}: MobileConversationsPanelProps) {
  return (
    <MobileDrawer
      side="left"
      tone="dark"
      title="会话"
      subtitle="TENANT-SCOPED HISTORY"
      onClose={onClose}
      titleId="mobile-conversations-title"
    >
      <div className="border-b border-white/10 p-4">
        <Button type="button" onClick={onNewConversation} className="w-full">
          <Plus className="h-4 w-4" /> 新建分析会话
        </Button>
      </div>
      <ConversationList
        conversations={conversations}
        activeId={activeId}
        onSelect={onSelect}
        className="py-2"
      />
      <div className="mt-2 flex items-center gap-2 border-t border-white/10 px-4 py-4 text-xs font-medium text-violet-200">
        <ShieldCheck className="h-4 w-4 text-emerald-400" />
        Tenant-scoped reads
      </div>
    </MobileDrawer>
  );
}
