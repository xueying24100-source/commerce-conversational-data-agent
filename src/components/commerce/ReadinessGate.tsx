import { ChevronRight, CircleAlert } from 'lucide-react';
import { Card } from '@/components/ui/Card';

export type ReadinessChecklistItem = { number: string; label: string; done: boolean };

export type ReadinessGateProps = {
  issues: string[];
  checklist: ReadinessChecklistItem[];
};

export function ReadinessGate({ issues, checklist }: ReadinessGateProps) {
  return (
    <div className="mx-auto flex min-h-[560px] max-w-3xl items-center px-6 py-14">
      <Card className="w-full border-amber-200/60 bg-amber-50/70 p-6 sm:p-8">
        <div className="flex items-start gap-4">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-400 text-amber-950">
            <CircleAlert className="h-5 w-5" />
          </div>
          <div>
            <p className="text-lg font-bold text-indigo-950">生产依赖未就绪</p>
            <p className="mt-2 text-sm leading-6 text-amber-900">
              Agent 不会使用样例数据或规则答案绕过依赖。完成以下配置并执行数据库迁移后才会开放提问。
            </p>
          </div>
        </div>
        <ul className="mt-6 space-y-2">
          {issues.map((issue) => (
            <li key={issue} className="flex items-start gap-2 border-t border-amber-200/70 py-2 text-sm text-amber-950">
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />
              {issue}
            </li>
          ))}
        </ul>
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {checklist.map(({ number, label, done }) => (
            <div key={number} className="rounded-xl border border-white/60 bg-white/70 p-3">
              <p className="text-xs font-bold text-amber-700">{number}</p>
              <p className="mt-1 text-xs font-semibold text-indigo-900">{label}</p>
              <p className={`mt-2 text-[10px] font-semibold ${done ? 'text-emerald-600' : 'text-amber-700'}`}>
                {done ? 'CONFIGURED' : 'REQUIRED'}
              </p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
