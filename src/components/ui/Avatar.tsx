import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

export type AvatarVariant = 'assistant' | 'user';

const VARIANT_CLASSES: Record<AvatarVariant, string> = {
  assistant: 'bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-md shadow-violet-500/25',
  user: 'bg-slate-200 text-slate-600',
};

export type AvatarProps = HTMLAttributes<HTMLDivElement> & {
  variant?: AvatarVariant;
  icon: ReactNode;
};

export function Avatar({ className, variant = 'assistant', icon, ...props }: AvatarProps) {
  return (
    <div
      className={cn(
        'grid h-8 w-8 shrink-0 place-items-center rounded-full',
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    >
      {icon}
    </div>
  );
}
