import { LineChartCard } from './charts/LineChartCard';
import { DataTable } from './DataTable';
import {
  evidenceMetricLabel,
  evidenceRecord,
} from './evidence-display';
import type { EvidenceTrace } from './types';

type Row = Record<string, unknown>;

function asRowArray(preview: unknown): Row[] | null {
  const record = evidenceRecord(preview);
  const candidate = record && Array.isArray(record.rows) ? record.rows : preview;
  if (!Array.isArray(candidate) || candidate.length === 0) return null;
  const rows = candidate.map(evidenceRecord);
  return rows.every(Boolean) ? rows as Row[] : null;
}
const CURRENCY_METRICS = new Set([
  'gmv', 'net_revenue', 'average_order_value', 'refund_amount', 'gross_profit', 'ad_spend',
]);
const INTEGER_METRICS = new Set(['paid_orders', 'units', 'visits', 'new_customers']);
const RATE_METRICS = new Set(['conversion_rate', 'refund_rate', 'gross_margin']);

function formatNumber(
  value: unknown,
  metric: unknown,
  currencyCode: string,
  field = '',
): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value == null ? '—' : String(value);
  const metricId = typeof metric === 'string' ? metric : '';
  if (/percent|relative|share/iu.test(field) || RATE_METRICS.has(metricId)) {
    return new Intl.NumberFormat('zh-CN', {
      style: 'percent',
      maximumFractionDigits: 2,
    }).format(value);
  }
  if (CURRENCY_METRICS.has(metricId)) {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: currencyCode,
      maximumFractionDigits: 2,
    }).format(value);
  }
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: INTEGER_METRICS.has(metricId) ? 0 : 4,
  }).format(value);
}

function metricDefinitions(preview: Row) {
  const metrics = Array.isArray(preview.metrics) ? preview.metrics.map(evidenceRecord).filter(Boolean) : [];
  if (!metrics.length) return null;
  return (
    <DataTable
      rows={metrics.map((metric) => ({
        metric: evidenceMetricLabel(metric!.id),
        definition: typeof metric!.description === 'string' ? metric!.description : '—',
        aggregation: typeof metric!.aggregation === 'string' ? metric!.aggregation : '—',
      }))}
      columnLabels={{ metric: '指标', definition: '业务口径', aggregation: '聚合方式' }}
      totalRows={metrics.length}
    />
  );
}

function healthPreview(preview: Row) {
  const partitions = Array.isArray(preview.partitions)
    ? preview.partitions.map(evidenceRecord).filter(Boolean)
    : [];
  const readyPartitions = partitions.filter((partition) => partition!.state === 'ready').length;
  const missingRequired = Array.isArray(preview.missingRequiredMetrics)
    ? preview.missingRequiredMetrics.map(evidenceMetricLabel)
    : [];
  const degradedOptional = Array.isArray(preview.degradedOptionalMetrics)
    ? preview.degradedOptionalMetrics.map(evidenceMetricLabel)
    : [];
  const ready = preview.analysisAllowed === true;
  return (
    <div className="space-y-2 text-xs leading-5 text-indigo-800">
      <div className="flex items-center justify-between rounded-lg border border-violet-100 bg-white px-3 py-2">
        <span>核心分析门禁</span>
        <span className={ready ? 'font-semibold text-emerald-700' : 'font-semibold text-rose-700'}>
          {ready ? '通过' : '未通过'}
        </span>
      </div>
      <p>完整分区：{readyPartitions}/{partitions.length || '—'}；来源可靠性：{String(preview.sourceReliability ?? '未知')}</p>
      <p>缺失必需指标：{missingRequired.length ? missingRequired.join('、') : '无'}</p>
      <p>未接入可选能力：{degradedOptional.length ? degradedOptional.join('、') : '无'}</p>
    </div>
  );
}

function weeklyScanPreview(preview: Row, currencyCode: string) {
  const signals = Array.isArray(preview.signals) ? preview.signals.map(evidenceRecord).filter(Boolean) : [];
  if (!signals.length) return null;
  return (
    <DataTable
      rows={signals.map((signal) => ({
        metric: evidenceMetricLabel(signal!.metric),
        current: formatNumber(signal!.current, signal!.metric, currencyCode),
        baseline: formatNumber(signal!.baselineMedian, signal!.metric, currencyCode),
        change: formatNumber(signal!.relativeChange, signal!.metric, currencyCode, 'relativeChange'),
        signal: signal!.anomalous === true ? '显著异常' : '常态范围',
      }))}
      columnLabels={{ metric: '指标', current: '本期', baseline: '四周中位数', change: '变化', signal: '判定' }}
      totalRows={signals.length}
    />
  );
}

function breakdownPreview(trace: EvidenceTrace, rows: Row[], currencyCode: string) {
  const request = evidenceRecord(trace.request);
  const metric = request?.metric;
  return (
    <DataTable
      rows={rows.map((row) => ({
        item: String(row.key ?? row.sku ?? row.bucket ?? '—'),
        current: formatNumber(row.current, metric, currencyCode),
        baseline: formatNumber(row.baseline, metric, currencyCode),
        absolute: formatNumber(row.absoluteChange, metric, currencyCode),
        percent: formatNumber(row.percentChange, metric, currencyCode, 'percentChange'),
      }))}
      columnLabels={{ item: '拆解项', current: '本期', baseline: '基准期', absolute: '增量', percent: '变化' }}
      totalRows={rows.length}
    />
  );
}

function comparisonPreview(preview: Row, currencyCode: string) {
  const current = evidenceRecord(preview.current) ?? {};
  const baseline = evidenceRecord(preview.baseline) ?? {};
  const changes = evidenceRecord(preview.changes) ?? {};
  const metrics = Array.from(new Set([...Object.keys(current), ...Object.keys(baseline)]));
  if (!metrics.length) return null;
  return (
    <DataTable
      rows={metrics.map((metric) => {
        const change = evidenceRecord(changes[metric]);
        return {
          metric: evidenceMetricLabel(metric),
          current: formatNumber(current[metric], metric, currencyCode),
          baseline: formatNumber(baseline[metric], metric, currencyCode),
          absolute: formatNumber(change?.absolute, metric, currencyCode),
          percent: formatNumber(change?.percent, metric, currencyCode, 'percent'),
        };
      })}
      columnLabels={{ metric: '指标', current: '本期', baseline: '基准期', absolute: '增量', percent: '变化' }}
    />
  );
}

function diagnosticDecisionPreview(preview: Row, currencyCode: string) {
  const chosen = evidenceRecord(preview.chosenNextView);
  const evaluation = evidenceRecord(preview.evaluation);
  return (
    <div className="space-y-2 text-xs leading-5 text-indigo-800">
      <p>决策：{typeof preview.decisionCode === 'string' ? preview.decisionCode : '—'}</p>
      <p>调查假设：{String(preview.hypothesis ?? '全局检查')}</p>
      {chosen ? (
        <p>下一步：按 {String(chosen.dimension ?? '时间')} 拆解 {evidenceMetricLabel(chosen.metric)}</p>
      ) : <p>下一步：停止调查（{String(preview.stopReason ?? '证据已足够')}）</p>}
      {evaluation ? (
        <p>
          归因贡献：{formatNumber(evaluation.contributionShare, evaluation.contributionMetric, currencyCode, 'share')}
          {' · '}门禁：{evaluation.gatePassed === true ? '通过' : '未通过'}
        </p>
      ) : null}
    </div>
  );
}

export type DataPreviewProps = {
  trace: EvidenceTrace;
  currencyCode?: string;
};

export function DataPreview({ trace, currencyCode = 'CNY' }: DataPreviewProps) {
  const preview = evidenceRecord(trace.preview);
  if (trace.operation === 'commerce.describe_data' && preview) return metricDefinitions(preview);
  if (trace.operation === 'commerce.inspect_data_health' && preview) return healthPreview(preview);
  if (trace.operation === 'commerce.scan_weekly_kpis' && preview) return weeklyScanPreview(preview, currencyCode);
  if (trace.operation === 'commerce.compare_metrics' && preview) return comparisonPreview(preview, currencyCode);
  if (trace.operation === 'commerce.diagnostic_decision' && preview) {
    return diagnosticDecisionPreview(preview, currencyCode);
  }

  const rows = asRowArray(trace.preview);
  if (!rows) {
    return <p className="text-xs leading-5 text-violet-700">该步骤没有可展示的业务结果行。</p>;
  }
  if (trace.operation === 'commerce.breakdown_metric') {
    return breakdownPreview(trace, rows, currencyCode);
  }
  if (trace.operation === 'commerce.trend_metric') {
    const request = evidenceRecord(trace.request);
    const metric = request?.metric;
    const exactRows = rows.map((row) => ({
      period: String(row.bucket ?? row.date ?? row.period ?? '—'),
      value: formatNumber(row.value, metric, currencyCode),
    }));
    return (
      <div className="space-y-3">
        <LineChartCard
          data={rows}
          xKey={Object.keys(rows[0]).find((key) => /date|period|bucket/iu.test(key)) ?? 'bucket'}
          series={['value']}
        />
        <DataTable
          rows={exactRows}
          columnLabels={{ period: '时间', value: evidenceMetricLabel(metric) }}
          totalRows={rows.length}
        />
      </div>
    );
  }
  return <DataTable rows={rows.slice(0, 12)} totalRows={rows.length} />;
}
