'use client';

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'default' | 'sm' | 'icon';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-violet-500/25 ' +
    'hover:from-indigo-600 hover:to-violet-600 hover:shadow-glow-lg',
  secondary:
    'border border-violet-200 bg-white/70 text-indigo-700 backdrop-blur-sm ' +
    'hover:bg-white hover:border-violet-300',
  ghost: 'text-violet-600 hover:bg-violet-50 hover:text-violet-700',
  danger: 'bg-red-500 text-white hover:bg-red-600',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  default: 'h-11 px-5 text-sm',
  sm: 'h-9 px-3 text-sm',
  icon: 'h-10 w-10',
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-xl font-medium',
        'transition-all duration-200 ease-out disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
