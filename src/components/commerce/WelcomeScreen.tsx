import { ArrowUp } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import type { CommerceStarter } from './client';
import type { Readiness } from './types';

export type WelcomeScreenProps = {
  starters: CommerceStarter[];
  dataStatus: Readiness['dataStatus'];
  onPickStarter: (starter: string) => void;
};

export function WelcomeScreen({ starters, dataStatus, onPickStarter }: WelcomeScreenProps) {
  return (
    <div className="mx-auto flex min-h-[560px] max-w-3xl flex-col justify-center px-6 py-14">
      <h1 className="text-balance text-center text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
        <span className="bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
          从真实经营数据开始，
        </span>
        <br className="hidden sm:block" />
        <span className="text-indigo-950">而不是从预设报告开始。</span>
      </h1>
      <p className="mx-auto mt-3 max-w-xl text-center text-sm leading-6 text-violet-600">
        推荐问题已按当前租户的数据范围与可用指标生成。未声明指标会拒答，不补零、不猜测。
      </p>
      {dataStatus?.coverageStart && dataStatus.coverageEnd ? (
        <p className="mx-auto mt-2 text-center text-xs text-violet-700">
          数据覆盖 {dataStatus.coverageStart} 至 {dataStatus.coverageEnd}
          {' · '}{dataStatus.dataMode === 'snapshot' ? '历史快照' : '持续同步'}
          {' · '}{dataStatus.businessTimezone ?? '租户默认时区'}
        </p>
      ) : null}
      <div className="mt-9 grid gap-4 sm:grid-cols-2">
        {starters.map((starter, index) => (
          <Card
            key={starter.label}
            hoverable
            className="group cursor-pointer p-5 text-left"
            onClick={() => onPickStarter(starter.question)}
          >
            <div className="mb-3 grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-sm font-bold text-white">
              {index + 1}
            </div>
            <p className="text-xs font-semibold uppercase tracking-wider text-violet-700">
              {starter.label}
            </p>
            <p className="mt-2 text-sm leading-6 text-indigo-800">{starter.question}</p>
            <ArrowUp className="mt-3 h-4 w-4 rotate-45 text-violet-300 transition group-hover:text-violet-600" />
          </Card>
        ))}
      </div>
    </div>
  );
}
