import { forwardRef } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full rounded-md border bg-neutral-0 px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400',
        'transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500/40',
        'disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:opacity-60',
        invalid
          ? 'border-danger-500 focus:border-danger-500 focus:ring-danger-500/30'
          : 'border-neutral-300 focus:border-primary-500',
        className,
      )}
      aria-invalid={invalid || undefined}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
