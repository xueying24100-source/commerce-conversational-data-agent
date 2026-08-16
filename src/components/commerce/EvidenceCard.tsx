import { Badge } from '@/components/ui/Badge';
import { Disclosure } from '@/components/ui/Disclosure';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { operationLabel, shortTime } from './client';
import { DataPreview } from './DataPreview';
import {
  compactAuditRequest,
  evidenceClaimLabel,
  evidenceQueryFacts,
  formatEvidenceClaim,
} from './evidence-display';
import type { EvidenceClaim, EvidenceTrace } from './types';

export function EvidenceCard({
  trace,
  index,
  idPrefix = 'evidence',
  claims = [],
  currencyCode = 'CNY',
}: {
  trace: EvidenceTrace;
  index: number;
  idPrefix?: string;
  claims?: EvidenceClaim[];
  currencyCode?: string;
}) {
  const citedClaims = claims.filter((claim) => claim.evidenceId === trace.evidenceId);
  const facts = evidenceQueryFacts(trace);
  return (
    <article
      id={`${idPrefix}-${trace.evidenceId}`}
      tabIndex={-1}
      className="scroll-mt-4 rounded-2xl border border-white/50 border-l-2 border-l-emerald-400 bg-white/70 p-4 shadow-md shadow-violet-100 backdrop-blur-sm transition-all duration-300 target:ring-2 target:ring-violet-400 hover:bg-white/90 hover:shadow-lg hover:shadow-violet-200"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-[10px] font-bold text-white">
            {String(index + 1).padStart(2, '0')}
          </span>
          <h4 className="text-sm font-semibold text-indigo-950">{operationLabel(trace.operation)}</h4>
        </div>
        <Badge variant={citedClaims.length ? 'primary' : 'success'}>
          {citedClaims.length ? `结论引用 ${citedClaims.length}` : '过程通过'}
        </Badge>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-violet-700">
        <span>{trace.rowCount} 行 · {shortTime(trace.fetchedAt)}</span>
        <span className="text-[10px] font-medium">证据 #{String(index + 1).padStart(2, '0')}</span>
      </div>

      {facts.length ? (
        <div className="mt-3 rounded-xl border border-violet-100 bg-white/80 p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-violet-600">查询口径</p>
          <dl className="space-y-1.5 text-[11px] leading-4">
            {facts.map((fact) => (
              <div key={`${fact.label}:${fact.value}`} className="grid grid-cols-[4.5rem_1fr] gap-2">
                <dt className="text-violet-700">{fact.label}</dt>
                <dd className="break-words font-medium text-indigo-800">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <Disclosure title="核对实际结果" className="mt-3" defaultOpen={citedClaims.length > 0}>
        <DataPreview trace={trace} currencyCode={currencyCode} />
      </Disclosure>

      {citedClaims.length ? (
        <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50/70 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">结论引用字段</p>
          <ul className="mt-2 space-y-2">
            {citedClaims.slice(0, 12).map((claim) => (
              <li key={`${claim.path}:${claim.metric}`} className="border-l-2 border-emerald-300 pl-2">
                <div className="flex items-start justify-between gap-2 text-[11px]">
                  <span className="leading-4 text-indigo-800">{evidenceClaimLabel(trace, claim)}</span>
                  <span className="shrink-0 font-mono font-semibold text-emerald-800">
                    {formatEvidenceClaim(claim, currencyCode)}
                  </span>
                </div>
                <p className="mt-0.5 break-all font-mono text-[9px] text-indigo-700">字段 {claim.path}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Disclosure title="审计与复现信息" className="mt-3">
        <CodeBlock className="mb-2 max-h-40 bg-indigo-950/90 text-[11px]">
          {JSON.stringify(compactAuditRequest(trace.request), null, 2)}
        </CodeBlock>
        <p className="break-all text-[10px] leading-4 text-violet-700">
          证据编号 · {trace.evidenceId}
        </p>
        <p className="mt-1 break-all text-[10px] leading-4 text-violet-700">
          来源水位 · {trace.sourceWatermark ?? 'unavailable'}
        </p>
        <p className="mt-1 break-all text-[10px] leading-4 text-violet-700">
          请求哈希 · {trace.requestSha256}
        </p>
        <p className="mt-1 break-all text-[10px] leading-4 text-violet-700">
          响应哈希 · {trace.responseSha256}
        </p>
      </Disclosure>
    </article>
  );
}
