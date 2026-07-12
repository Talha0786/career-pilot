import { cn } from '../lib/cn.js';

export interface DividerProps {
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  label?: string;
}

export function Divider({ orientation = 'horizontal', className, label }: DividerProps) {
  if (orientation === 'vertical') {
    return <span role="separator" aria-orientation="vertical" className={cn('inline-block w-px self-stretch bg-neutral-200', className)} />;
  }
  if (label) {
    return (
      <div className={cn('flex items-center gap-3 text-xs text-neutral-400', className)} role="separator">
        <span className="h-px flex-1 bg-neutral-200" />
        {label}
        <span className="h-px flex-1 bg-neutral-200" />
      </div>
    );
  }
  return <hr className={cn('border-t border-neutral-200', className)} />;
}
