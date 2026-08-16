import { LoaderCircle, Search } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils/cn';
import { EvidenceCard } from './EvidenceCard';
import type { AgentJob, EvidenceClaim, EvidenceTrace } from './types';

export type EvidenceTimelineProps = {
  traces: EvidenceTrace[];
  pending?: { jobStatus: AgentJob['status'] | null } | null;
  className?: string;
  idPrefix?: string;
  claims?: EvidenceClaim[];
  currencyCode?: string;
};

export function EvidenceTimeline({
  traces,
  pending,
  className,
  idPrefix,
  claims = [],
  currencyCode,
}: EvidenceTimelineProps) {
  const catalogPreview = traces.find((trace) => trace.operation === 'commerce.describe_data')?.preview;
  const inferredCurrency = catalogPreview
    && typeof catalogPreview === 'object'
    && !Array.isArray(catalogPreview)
    && typeof (catalogPreview as { currencyCode?: unknown }).currencyCode === 'string'
    ? (catalogPreview as { currencyCode: string }).currencyCode
    : 'CNY';
  if (!traces.length && !pending) {
    return (
      <div className={cn('mt-10 text-center', className)}>
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-dashed border-violet-200 text-violet-300">
          <Search className="h-5 w-5" />
        </div>
        <p className="mt-4 text-xs font-semibold text-indigo-900">还没有查询证据</p>
        <p className="mx-auto mt-2 max-w-[220px] text-[11px] leading-5 text-violet-700">
          Agent 调用数据工具后，这里会显示查询口径、精确结果、结论引用字段和审计哈希。
        </p>
      </div>
    );
  }
  return (
    <div className={cn('space-y-4', className)}>
      {traces.map((trace, index) => (
        <EvidenceCard
          key={trace.evidenceId}
          trace={trace}
          index={index}
          idPrefix={idPrefix}
          claims={claims}
          currencyCode={currencyCode ?? inferredCurrency}
        />
      ))}
      {pending ? (
        <article className="rounded-2xl border border-white/50 border-l-2 border-l-blue-400 bg-white/70 p-4 shadow-md shadow-violet-100 backdrop-blur-sm">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <LoaderCircle className="h-4 w-4 animate-spin text-blue-500" />
              <h4 className="text-sm font-semibold text-indigo-950">
                {pending.jobStatus === 'queued' ? '任务排队中' : '正在查询经营数据'}
              </h4>
            </div>
            <Badge variant="info">运行中</Badge>
          </div>
          <p className="mt-2 text-xs leading-5 text-violet-700">
            Agent 会自行选择指标、趋势或拆解工具，然后校验证据。
          </p>
        </article>
      ) : null}
    </div>
  );
}
