import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

export type CardProps = HTMLAttributes<HTMLDivElement> & { hoverable?: boolean };

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, hoverable = false, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-2xl border border-white/50 bg-white/70 p-5 shadow-lg shadow-violet-100/20 backdrop-blur-md',
        'transition-all duration-300 ease-out',
        hoverable && 'hover:-translate-y-0.5 hover:shadow-xl hover:shadow-violet-200/30',
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';
