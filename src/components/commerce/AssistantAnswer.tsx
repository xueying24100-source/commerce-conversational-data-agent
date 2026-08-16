import {
  Activity,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  DatabaseZap,
  GitBranch,
  ShieldCheck,
  Target,
  UserRound,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Disclosure } from '@/components/ui/Disclosure';
import { ActionProgressControls } from './ActionProgressControls';
import { claimEvidenceIds, contextualizeCommerceFollowUp } from './client';
import { EvidenceIds } from './EvidenceIds';
import { FeedbackControls } from './FeedbackControls';
import { MetricStrip } from './MetricStrip';
import { ReportDownload } from './ReportDownload';
import type { ActionState, ConversationMessage } from './types';

type Finding = NonNullable<ConversationMessage['answer']>['findings'][number];
type Recommendation = NonNullable<ConversationMessage['answer']>['recommendations'][number];
type Diagnostic = NonNullable<NonNullable<ConversationMessage['answer']>['diagnostic']>;

const OWNER_ROLE_LABELS: Record<NonNullable<Recommendation['ownerRole']>, string> = {
  operations: '运营负责人',
  growth: '增长负责人',
  merchandising: '商品负责人',
  finance: '财务负责人',
  customer_service: '售后负责人',
  supply_chain: '供应链负责人',
  data: '数据负责人',
};

const PRIORITY_LABELS = { high: '高优先级', medium: '中优先级', low: '低优先级' } as const;
const DIRECTION_LABELS = { increase: '提升', decrease: '降低', maintain: '保持' } as const;
const INSIGHT_LEVEL_LABELS = {
  observed: '已观察',
  contribution: '已对账贡献',
  driver: '高可信驱动',
  hypothesis: '待验证原因',
  unknown: '当前未知',
} as const;
const STOP_REASON_LABELS: Record<Diagnostic['stopReason'], string> = {
  data_health_failed: '数据门禁未通过',
  scope_unavailable: '范围不可用',
  no_material_anomaly: '未发现达到阈值的异常',
  evidence_sufficient: '证据已足够',
  budget_exhausted: '调查预算已用完',
  no_new_evidence: '连续两轮没有新证据',
  timeout: '达到运行时限',
  no_legal_candidate: '没有合法的下一步',
  unknown: '当前无法判断',
};
const BASELINE_LABELS: Record<Diagnostic['baseline']['strategy'], string> = {
  explicit: '用户指定基准',
  previous_four_complete_weeks_median: '此前四个完整周中位数',
  available_complete_weeks_median: '可用完整周中位数',
  previous_adjacent_period: '相邻完整周期',
};
const HYPOTHESIS_LABELS = {
  growth_driver: '增长驱动',
  traffic_drop: '流量下降',
  conversion_drop: '转化下降',
  aov_or_mix: '客单价或商品结构',
  refund_spike: '退款上升',
  stockout: '缺货影响',
} as const;
const VIEW_LABELS = { breakdown: '结构拆解', trend: '时间趋势', inventory: '库存风险' } as const;

function sourceCutoff(diagnostic: Diagnostic): string {
  if (!diagnostic.dataHealth.sourceWatermark) return '水位不可用';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: diagnostic.timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(diagnostic.dataHealth.sourceWatermark));
  } catch {
    return diagnostic.dataHealth.sourceWatermark;
  }
}

function DiagnosticFlightRecorder({ diagnostic }: { diagnostic: Diagnostic }) {
  const healthTone = diagnostic.dataHealth.status === 'blocked'
    ? 'border-rose-200 bg-rose-50 text-rose-800'
    : diagnostic.dataHealth.status === 'degraded'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-emerald-200 bg-emerald-50 text-emerald-800';
  return (
    <section className="overflow-hidden border-y border-indigo-100 bg-white/55" aria-label="诊断运行记录">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div>
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-indigo-700">
            <Activity className="h-3.5 w-3.5" /> 诊断运行记录
          </p>
          <p className="mt-1 text-xs text-indigo-700">
            {diagnostic.dataHealth.dataMode === 'snapshot'
              ? `历史数据快照 · 虚拟业务日期 ${diagnostic.referenceDate}`
              : `持续同步数据 · 业务日期 ${diagnostic.referenceDate}`}
          </p>
        </div>
        <span className={`border px-2.5 py-1 font-mono text-[10px] font-semibold ${healthTone}`}>
          {diagnostic.dataHealth.status === 'ready'
            ? 'DATA READY'
            : diagnostic.dataHealth.status === 'degraded'
              ? 'CORE DATA READY'
              : 'DATA BLOCKED'}
        </span>
      </div>

      <div className="grid border-t border-indigo-100 sm:grid-cols-3">
        <div className="border-b border-indigo-100 px-4 py-3 sm:border-b-0 sm:border-r">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
            <DatabaseZap className="h-3.5 w-3.5" /> 数据截至
          </p>
          <p className="mt-1.5 text-xs font-medium text-indigo-900">{sourceCutoff(diagnostic)}</p>
          <p className="mt-1 text-[10px] text-indigo-700">{diagnostic.timezone}</p>
        </div>
        <div className="border-b border-indigo-100 px-4 py-3 sm:border-b-0 sm:border-r">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
            <GitBranch className="h-3.5 w-3.5" /> 比较基准
          </p>
          <p className="mt-1.5 text-xs font-medium text-indigo-900">
            {BASELINE_LABELS[diagnostic.baseline.strategy]}
          </p>
          <p className="mt-1 text-[10px] text-indigo-700">置信度 {diagnostic.baseline.confidence}</p>
        </div>
        <div className="px-4 py-3">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
            <CircleStop className="h-3.5 w-3.5" /> 主动停止
          </p>
          <p className="mt-1.5 text-xs font-medium text-indigo-900">
            {STOP_REASON_LABELS[diagnostic.stopReason]}
          </p>
          <p className="mt-1 text-[10px] text-indigo-700">不会为凑数继续调用工具</p>
        </div>
      </div>

      {diagnostic.decisions.length ? (
        <Disclosure title={`查看 ${diagnostic.decisions.length} 条路径决策`} className="border-t border-indigo-100 px-4 py-3">
          <ol className="space-y-2" aria-label="调查路径">
            {diagnostic.decisions.map((decision) => (
              <li key={decision.sequence} className="grid grid-cols-[1.5rem_1fr] gap-2 text-xs">
                <span className="grid h-5 w-5 place-items-center border border-violet-200 bg-white font-mono text-[9px] font-semibold text-violet-600">
                  {String(decision.sequence).padStart(2, '0')}
                </span>
                <span className="leading-5 text-indigo-700">
                  {decision.hypothesis ? HYPOTHESIS_LABELS[decision.hypothesis] : '全局检查'}
                  {' · '}
                  {decision.chosenNextView ? `选择${VIEW_LABELS[decision.chosenNextView]}` : STOP_REASON_LABELS[(decision.stopReason ?? 'unknown') as Diagnostic['stopReason']] ?? '停止'}
                </span>
              </li>
            ))}
          </ol>
        </Disclosure>
      ) : null}
    </section>
  );
}

function FindingSection({
  title,
  findings,
  risk = false,
  onEvidenceNavigate,
}: {
  title: string;
  findings: Finding[];
  risk?: boolean;
  onEvidenceNavigate?: (evidenceId: string) => void;
}) {
  if (!findings.length) return null;
  return (
    <div>
      <p className={`mb-3 text-xs font-semibold uppercase tracking-wider ${
        risk ? 'text-amber-700' : 'text-violet-700'
      }`}
      >
        {title}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {findings.map((finding) => (
          <Card
            key={`${finding.title}:${finding.detail}`}
            className={risk ? 'border-amber-200 bg-amber-50/70 p-4' : 'p-4'}
          >
            <h4 className="text-sm font-semibold text-indigo-950">{finding.title}</h4>
            {finding.insightLevel || typeof finding.confidence === 'number' ? (
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-semibold">
                {finding.insightLevel ? (
                  <span className="border border-violet-200 bg-violet-50 px-2 py-0.5 text-violet-700">
                    {INSIGHT_LEVEL_LABELS[finding.insightLevel]}
                  </span>
                ) : null}
                {typeof finding.confidence === 'number' ? (
                  <span className="border border-indigo-100 bg-white px-2 py-0.5 font-mono text-indigo-600">
                    CONF {Math.round(finding.confidence * 100)}%
                  </span>
                ) : null}
              </div>
            ) : null}
            <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-indigo-700">{finding.detail}</p>
            {finding.alternatives?.length ? (
              <p className="mt-2 border-l border-amber-300 pl-2 text-[11px] leading-5 text-amber-800">
                替代解释：{finding.alternatives.join('；')}
              </p>
            ) : null}
            <EvidenceIds ids={claimEvidenceIds(finding.claims)} onNavigate={onEvidenceNavigate} />
          </Card>
        ))}
      </div>
    </div>
  );
}

export function AssistantAnswer({
  conversationId,
  message,
  sourceQuestion,
  onFollowUp,
  onActionChange,
  onEvidenceNavigate,
}: {
  conversationId: string;
  message: ConversationMessage;
  sourceQuestion?: string;
  onFollowUp: (question: string) => void;
  onActionChange?: (messageId: string, state: ActionState) => void;
  onEvidenceNavigate?: (evidenceId: string) => void;
}) {
  const answer = message.answer;
  if (!answer) return <p className="whitespace-pre-wrap text-sm leading-7 text-indigo-800">{message.content}</p>;
  const conclusionLabel = answer.status === 'needs_clarification'
    ? '需要补充信息'
    : answer.status === 'refused'
      ? '无法执行'
      : '分析结论';
  const riskFindings = answer.findings.filter((finding) => (
    finding.title.startsWith('风险信号') || finding.title.startsWith('关注项')
  ));
  const driverFindings = answer.findings.filter((finding) => !riskFindings.includes(finding));
  const allClaims = [
    ...answer.answerClaims,
    ...answer.findings.flatMap((finding) => finding.claims),
    ...answer.recommendations.flatMap((recommendation) => recommendation.claims),
  ];
  return (
    <div className="space-y-5">
      {answer.diagnostic ? <DiagnosticFlightRecorder diagnostic={answer.diagnostic} /> : null}
      <div className="rounded-r-lg border-l-2 border-violet-500 bg-violet-50 p-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-violet-700">
          {conclusionLabel}
        </p>
        <p className="whitespace-pre-wrap text-[15px] leading-7 text-violet-900">{answer.answer}</p>
        <EvidenceIds ids={claimEvidenceIds(answer.answerClaims)} onNavigate={onEvidenceNavigate} />
      </div>

      <MetricStrip claims={answer.answerClaims} />

      <FindingSection title="核心发现" findings={driverFindings} onEvidenceNavigate={onEvidenceNavigate} />

      <FindingSection
        title="风险与需关注项"
        findings={riskFindings}
        risk
        onEvidenceNavigate={onEvidenceNavigate}
      />

      {answer.recommendations.length ? (
        <div className="border-t border-violet-100 pt-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-violet-700">
            优先行动
          </p>
          <div className="space-y-3">
            {answer.recommendations.map((recommendation, index) => (
              <div
                key={recommendation.id ?? `${recommendation.action}:${index}`}
                className="rounded-xl border border-violet-100 bg-white/70 p-4"
              >
                <div className="flex items-start gap-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-[10px] font-bold text-white">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-indigo-900">{recommendation.action}</p>
                      {recommendation.priority ? (
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          recommendation.priority === 'high'
                            ? 'bg-rose-100 text-rose-700'
                            : 'bg-violet-100 text-violet-700'
                        }`}
                        >
                          {PRIORITY_LABELS[recommendation.priority]}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-indigo-700">{recommendation.rationale}</p>

                    {recommendation.ownerRole || recommendation.deadline !== undefined || recommendation.successMetric ? (
                      <dl className="mt-3 grid gap-2 text-xs text-indigo-700 sm:grid-cols-3">
                        {recommendation.ownerRole ? (
                          <div className="rounded-lg bg-violet-50 p-2.5">
                            <dt className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-violet-700">
                              <UserRound className="h-3 w-3" /> 负责角色
                            </dt>
                            <dd className="mt-1 font-medium">{OWNER_ROLE_LABELS[recommendation.ownerRole]}</dd>
                          </div>
                        ) : null}
                        {recommendation.deadline !== undefined ? (
                          <div className="rounded-lg bg-violet-50 p-2.5">
                            <dt className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-violet-700">
                              <CalendarClock className="h-3 w-3" /> 截止日
                            </dt>
                            <dd className="mt-1 font-medium">{recommendation.deadline ?? '由负责人确认'}</dd>
                          </div>
                        ) : null}
                        {recommendation.successMetric ? (
                          <div className="rounded-lg bg-violet-50 p-2.5">
                            <dt className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-violet-700">
                              <Target className="h-3 w-3" /> 成功指标
                            </dt>
                            <dd className="mt-1 font-medium">
                              {DIRECTION_LABELS[recommendation.successMetric.direction]} {recommendation.successMetric.metric}
                              {recommendation.successMetric.target === null ? '（目标待确认）' : `至 ${recommendation.successMetric.target}`}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    ) : null}

                    {recommendation.guardrails?.length ? (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-emerald-700">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        <span className="font-semibold">护栏：</span>
                        {recommendation.guardrails.map((guardrail) => (
                          <span key={`${guardrail.metric}:${guardrail.baselineClaim.evidenceId}:${guardrail.baselineClaim.path}`}>
                            {guardrail.metric}{guardrail.threshold === null ? '阈值待确认' : `${guardrail.operator === 'not_above' ? '不高于' : '不低于'} ${guardrail.threshold}`}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <EvidenceIds
                      ids={claimEvidenceIds(recommendation.claims)}
                      onNavigate={onEvidenceNavigate}
                    />
                    {recommendation.id ? (
                      <ActionProgressControls
                        conversationId={conversationId}
                        messageId={message.id}
                        actionId={recommendation.id}
                        initialState={message.actionStates?.find((state) => state.actionId === recommendation.id)}
                        suggestedDueDate={recommendation.deadline}
                        onChange={(state) => onActionChange?.(message.id, state)}
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {answer.followUps.length ? (
        <div className="border-t border-violet-100 pt-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-violet-700">
            继续分析（沿用当前日期范围）
          </p>
          <div className="flex flex-wrap gap-2">
            {answer.followUps.map((followUp) => (
              <button
                key={followUp}
                type="button"
                onClick={() => onFollowUp(contextualizeCommerceFollowUp(followUp, sourceQuestion))}
                className="group inline-flex items-center gap-1.5 rounded-xl border border-violet-200 bg-white/60 px-4 py-2 text-left text-sm text-indigo-700 backdrop-blur-sm transition hover:border-violet-300 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
              >
                {followUp}
                <ChevronRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {message.runStatus === 'completed' ? (
        <div className="flex items-start justify-between gap-3 border-t border-violet-100 pt-3">
          <FeedbackControls conversationId={conversationId} message={message} claims={allClaims} />
          {message.reportAvailable ? (
            <ReportDownload conversationId={conversationId} messageId={message.id} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
