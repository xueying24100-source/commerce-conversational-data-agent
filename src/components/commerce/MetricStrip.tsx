import { formatClaimValue, metricLabel } from '@/lib/utils/format';
import { selectMetricStripEntries } from './client';
import type { EvidenceClaim } from './types';

const ADVERSE_METRICS = new Set(['refund_rate', 'refund_amount', 'stockout_hours']);

export function MetricStrip({ claims }: { claims: EvidenceClaim[] }) {
  if (!claims.length) return null;
  const selected = selectMetricStripEntries(claims);
  return (
    <div className="flex flex-wrap gap-3">
      {selected.map(({ metric, value, change }) => {
        const favorable = change && change.value !== 0
          ? ADVERSE_METRICS.has(metric) ? change.value < 0 : change.value > 0
          : null;
        return (
          <div
            key={metric}
            className="min-w-36 rounded-xl border border-white/50 bg-white/70 px-4 py-2.5 shadow-md shadow-violet-100/60 backdrop-blur-sm"
          >
            <p className="text-xs text-violet-700">{metricLabel(metric)}</p>
            <p className="text-lg font-bold tabular-nums text-indigo-950">
              {formatClaimValue(value.value, value.unit)}
            </p>
            {change ? (
              <p className={`mt-1 text-xs font-semibold tabular-nums ${
                favorable === true
                  ? 'text-emerald-600'
                  : favorable === false
                    ? 'text-red-600'
                    : 'text-slate-500'
              }`}
              >
                {change.value > 0 ? '↑ +' : change.value < 0 ? '↓ ' : ''}
                {formatClaimValue(change.value, change.unit)} 较基准
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
