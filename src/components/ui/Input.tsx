'use client';

import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

const FIELD_BASE =
  'w-full rounded-xl border border-violet-200 bg-white/80 text-indigo-900 placeholder:text-violet-300 ' +
  'outline-none transition-all duration-200 ease-out ' +
  'focus:border-violet-500/50 focus:bg-white focus:ring-2 focus:ring-violet-500/30 ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(FIELD_BASE, 'h-11 px-4 text-sm', className)} {...props} />
  ),
);
Input.displayName = 'Input';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(FIELD_BASE, 'min-h-[60px] resize-none px-4 py-3 text-sm leading-6', className)}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
