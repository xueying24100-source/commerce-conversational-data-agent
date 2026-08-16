import { FileSearch, ShieldCheck, Sparkles } from 'lucide-react';
import { EvidenceTimeline, type EvidenceTimelineProps } from './EvidenceTimeline';

export type EvidenceRailProps = EvidenceTimelineProps;

export function EvidenceRail({ traces, pending, claims, currencyCode }: EvidenceRailProps) {
  return (
    <aside className="hidden w-80 flex-col border-l border-violet-100 bg-[#F5F3FF] xl:flex">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-violet-100 bg-white/50 px-5 backdrop-blur-sm">
        <div>
          <p className="text-sm font-semibold text-indigo-950">证据栏</p>
          <p className="text-[10px] uppercase tracking-wider text-violet-700">口径 · 结果 · 引用 · 审计</p>
        </div>
        <FileSearch className="h-4 w-4 text-violet-500" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4" tabIndex={0} aria-label="证据列表">
        <EvidenceTimeline
          traces={traces}
          pending={pending}
          claims={claims}
          currencyCode={currencyCode}
          idPrefix="evidence"
        />
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-violet-100 p-4">
        <div className="rounded-xl border border-white/50 bg-white/70 p-2.5">
          <Sparkles className="h-3.5 w-3.5 text-violet-500" />
          <p className="mt-2 text-[11px] font-semibold text-indigo-800">MoAgent loop</p>
        </div>
        <div className="rounded-xl border border-white/50 bg-white/70 p-2.5">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
          <p className="mt-2 text-[11px] font-semibold text-indigo-800">Fail closed</p>
        </div>
      </div>
    </aside>
  );
}
