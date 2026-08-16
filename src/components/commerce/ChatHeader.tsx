import { ClipboardCheck, ClipboardList, Menu, PanelRight } from 'lucide-react';

export type ChatHeaderProps = {
  title: string;
  subtitle: string;
  evidenceCount: number;
  onOpenConversations: () => void;
  onOpenEvidence: () => void;
  onOpenActions: () => void;
  actionCount: number;
  onOpenFeedbackReview?: () => void;
};

export function ChatHeader({
  title,
  subtitle,
  evidenceCount,
  onOpenConversations,
  onOpenEvidence,
  onOpenActions,
  actionCount,
  onOpenFeedbackReview,
}: ChatHeaderProps) {
  return (
    <div className="flex h-14 shrink-0 items-center justify-between border-b border-violet-100 bg-white/50 px-4 backdrop-blur-sm sm:px-6">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-indigo-950">{title}</p>
        <p className="mt-0.5 truncate text-xs text-violet-700">{subtitle}</p>
      </div>
      <div className="flex items-center gap-1.5">
        {onOpenFeedbackReview ? (
          <button
            type="button"
            onClick={onOpenFeedbackReview}
            aria-label="打开回答反馈审核"
            title="回答反馈审核"
            className="grid h-9 w-9 place-items-center rounded-md border border-violet-200 bg-white/70 text-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
          >
            <ClipboardCheck className="h-4 w-4" />
          </button>
        ) : null}
        <div className="flex items-center gap-1.5 xl:hidden">
        <button
          type="button"
          onClick={onOpenActions}
          aria-label={`打开运营行动台，共 ${actionCount} 条未完成行动`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-white/70 px-2.5 py-2 text-[11px] font-semibold text-indigo-700 backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
        >
          <ClipboardList className="h-4 w-4" /> {actionCount}
        </button>
        <button
          type="button"
          onClick={onOpenConversations}
          aria-label="打开会话列表"
          className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-white/70 px-2.5 py-2 text-[11px] font-semibold text-indigo-700 backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
        >
          <Menu className="h-4 w-4" /> 会话
        </button>
        <button
          type="button"
          onClick={onOpenEvidence}
          aria-label={`打开证据面板，共 ${evidenceCount} 条证据`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-2 text-[11px] font-semibold text-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
        >
          <PanelRight className="h-4 w-4" /> {evidenceCount}
        </button>
        </div>
      </div>
    </div>
  );
}
