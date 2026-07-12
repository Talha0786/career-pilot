import { forwardRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, leadingIcon, trailingIcon, ...props }, ref) => {
    if (!leadingIcon && !trailingIcon) {
      return (
        <input
          ref={ref}
          className={cn(
            'h-10 w-full rounded-md border bg-neutral-0 px-3 text-sm text-neutral-900 placeholder:text-neutral-400',
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
      );
    }
    return (
      <div className="relative flex items-center">
        {leadingIcon && (
          <span className="pointer-events-none absolute left-3 flex text-neutral-400">{leadingIcon}</span>
        )}
        <input
          ref={ref}
          className={cn(
            'h-10 w-full rounded-md border bg-neutral-0 text-sm text-neutral-900 placeholder:text-neutral-400',
            leadingIcon ? 'pl-9' : 'pl-3',
            trailingIcon ? 'pr-9' : 'pr-3',
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
        {trailingIcon && <span className="pointer-events-none absolute right-3 flex text-neutral-400">{trailingIcon}</span>}
      </div>
    );
  },
);
Input.displayName = 'Input';
