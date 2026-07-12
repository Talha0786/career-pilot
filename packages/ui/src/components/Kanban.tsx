import type { DragEventHandler, HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface KanbanColumnProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  count: number;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  children?: ReactNode;
}

export function KanbanColumn({ title, count, onDragOver, onDrop, children, className, ...props }: KanbanColumnProps) {
  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn('flex w-64 shrink-0 flex-col rounded-lg bg-neutral-100 p-2.5', className)}
      {...props}
    >
      <h3 className="mb-2.5 flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        <span>{title}</span>
        <span className="rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600">{count}</span>
      </h3>
      <div className="flex min-h-10 flex-col gap-2">{children}</div>
    </div>
  );
}

export interface KanbanCardProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  subtitle?: string;
  statusLabel?: string;
  statusTone?: 'pending' | 'ready' | 'failed';
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLDivElement>;
}

const TONE_CLASSES: Record<NonNullable<KanbanCardProps['statusTone']>, { border: string; text: string }> = {
  pending: { border: 'border-l-warning-500', text: 'text-warning-600' },
  ready: { border: 'border-l-success-500', text: 'text-success-600' },
  failed: { border: 'border-l-danger-500', text: 'text-danger-600' },
};

export function KanbanCard({
  title,
  subtitle,
  statusLabel,
  statusTone = 'pending',
  draggable,
  onDragStart,
  className,
  ...props
}: KanbanCardProps) {
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      className={cn(
        'cursor-grab rounded-md border-l-4 bg-neutral-0 p-3 shadow-xs transition-shadow active:cursor-grabbing hover:shadow-sm',
        TONE_CLASSES[statusTone].border,
        className,
      )}
      {...props}
    >
      <div className="text-sm font-semibold text-neutral-900">{title}</div>
      {subtitle && <div className="mt-0.5 text-xs text-neutral-500">{subtitle}</div>}
      {statusLabel && (
        <div className={cn('mt-2 text-[11px] font-medium', TONE_CLASSES[statusTone].text)}>{statusLabel}</div>
      )}
    </div>
  );
}
