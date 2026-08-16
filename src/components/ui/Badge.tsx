import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

export type BadgeVariant = 'primary' | 'success' | 'warning' | 'error' | 'info' | 'default';

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  primary: 'bg-violet-100 text-violet-700',
  success: 'bg-emerald-100 text-emerald-700',
  warning: 'bg-amber-100 text-amber-700',
  error: 'bg-red-100 text-red-700',
  info: 'bg-blue-100 text-blue-700',
  default: 'bg-slate-100 text-slate-700',
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant };

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    />
  );
}
