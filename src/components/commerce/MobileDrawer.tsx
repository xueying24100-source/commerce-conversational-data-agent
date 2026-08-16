import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

export type MobileDrawerProps = {
  side: 'left' | 'right';
  tone: 'dark' | 'light';
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  titleId: string;
};

export function MobileDrawer({
  side,
  tone,
  title,
  subtitle,
  onClose,
  children,
  className,
  titleId,
}: MobileDrawerProps) {
  return (
    <div className="fixed inset-0 z-50 xl:hidden">
      <button
        type="button"
        aria-label="关闭侧边面板"
        onClick={onClose}
        className="absolute inset-0 bg-indigo-950/50 backdrop-blur-sm"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'absolute inset-y-0 flex w-[min(90vw,380px)] flex-col shadow-2xl',
          side === 'left' ? 'left-0' : 'right-0',
          tone === 'dark'
            ? 'bg-gradient-to-b from-indigo-950 to-violet-900'
            : 'bg-[#F5F3FF]',
          className,
        )}
      >
        <div
          className={cn(
            'flex h-16 shrink-0 items-center justify-between border-b px-4',
            tone === 'dark' ? 'border-white/10' : 'border-violet-100 bg-white/50 backdrop-blur-sm',
          )}
        >
          <div className="min-w-0">
            <p
              id={titleId}
              className={cn(
                'truncate text-sm font-bold uppercase tracking-wider',
                tone === 'dark' ? 'text-white' : 'text-indigo-950',
              )}
            >
              {title}
            </p>
            {subtitle ? (
              <p className={cn('mt-0.5 text-[10px]', tone === 'dark' ? 'text-violet-300' : 'text-violet-700')}>
                {subtitle}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className={cn(
              'grid h-9 w-9 shrink-0 place-items-center rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/50',
              tone === 'dark'
                ? 'border-white/15 bg-white/5 text-violet-100'
                : 'border-violet-200 bg-white text-violet-600',
            )}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" tabIndex={0} aria-label={`${title}内容`}>{children}</div>
      </aside>
    </div>
  );
}
