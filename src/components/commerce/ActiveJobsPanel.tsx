import { Clock3, LoaderCircle, RotateCw, Unplug } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { shortTime } from './client';
import type { AgentJob } from './types';

type ActiveJobsPanelProps = {
  jobs: AgentJob[];
  waitingJobId: string | null;
  connection: 'connected' | 'reconnecting';
  onResume: (job: AgentJob) => void;
  onStopWaiting: () => void;
};

function jobStatus(job: AgentJob, waiting: boolean, connection: ActiveJobsPanelProps['connection']) {
  if (waiting && connection === 'reconnecting') return '连接恢复中';
  if (job.status === 'queued') return '等待 Worker';
  return '后台分析中';
}

export function ActiveJobsPanel({
  jobs,
  waitingJobId,
  connection,
  onResume,
  onStopWaiting,
}: ActiveJobsPanelProps) {
  if (!jobs.length) return null;
  return (
    <section
      aria-label="后台运行的分析任务"
      className="border-b border-sky-200 bg-sky-50/90 px-4 py-3 sm:px-6"
    >
      <div className="mx-auto max-w-6xl space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-sky-900">
          <Clock3 className="h-4 w-4" />
          已持久化的后台任务
          <span className="font-normal text-sky-700">刷新或离开页面不会取消</span>
        </div>
        {jobs.map((job) => {
          const waiting = waitingJobId === job.id;
          return (
            <div
              key={job.id}
              className="flex flex-col gap-2 rounded-xl border border-sky-200 bg-white/80 px-3 py-2.5 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[11px] font-medium text-sky-700">
                  {waiting
                    ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    : <Unplug className="h-3.5 w-3.5" />}
                  {jobStatus(job, waiting, connection)} · {shortTime(job.createdAt)}
                </div>
                <p className="mt-1 truncate text-xs text-indigo-950" title={job.message}>
                  {job.message}
                </p>
              </div>
              {waiting ? (
                <Button type="button" variant="secondary" size="sm" onClick={onStopWaiting}>
                  暂停前台等待
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={waitingJobId !== null}
                  onClick={() => onResume(job)}
                >
                  <RotateCw className="h-3.5 w-3.5" /> 继续查看结果
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
