import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export type AlertVariant = 'info' | 'success' | 'warning' | 'danger';

const VARIANT_CLASSES: Record<AlertVariant, string> = {
  info: 'border-primary-200 bg-primary-50 text-primary-800',
  success: 'border-success-500/30 bg-success-50 text-success-600',
  warning: 'border-warning-500/30 bg-warning-50 text-warning-600',
  danger: 'border-danger-500/30 bg-danger-50 text-danger-600',
};

const ICONS: Record<AlertVariant, ReactNode> = {
  info: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 7v4.5M8 4.75v.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  success: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 8.5l2 2 4-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  warning: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 1.5l7 12.5H1L8 1.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 6.5v3M8 11.5v.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  danger: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
};

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
  title?: string;
}

export function Alert({ className, variant = 'info', title, children, ...props }: AlertProps) {
  return (
    <div
      role="alert"
      className={cn('flex gap-2.5 rounded-md border px-3.5 py-3 text-sm', VARIANT_CLASSES[variant], className)}
      {...props}
    >
      <span className="mt-0.5 shrink-0">{ICONS[variant]}</span>
      <div className="flex flex-col gap-0.5">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="opacity-90">{children}</div>}
      </div>
    </div>
  );
}
