import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface AppHeaderProps {
  title: string;
  right?: ReactNode;
  className?: string;
}

export function AppHeader({ title, right, className }: AppHeaderProps) {
  return (
    <header className={cn('flex items-center justify-between border-b border-neutral-200 bg-neutral-0 px-6 py-4', className)}>
      <h1 className="text-lg font-semibold text-neutral-900">{title}</h1>
      {right && <div className="flex items-center gap-3">{right}</div>}
    </header>
  );
}
