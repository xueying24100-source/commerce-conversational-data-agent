import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

export type CodeBlockProps = HTMLAttributes<HTMLPreElement> & { children: string };

export function CodeBlock({ className, children, ...props }: CodeBlockProps) {
  return (
    <pre
      className={cn(
        'max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-violet-800/50',
        'bg-indigo-950/90 p-4 font-mono text-xs leading-5 text-violet-100',
        className,
      )}
      {...props}
    >
      {children}
    </pre>
  );
}
