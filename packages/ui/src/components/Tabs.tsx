import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../lib/cn.js';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: TabsPrimitive.TabsListProps) {
  return (
    <TabsPrimitive.List
      className={cn('inline-flex items-center gap-1 rounded-md bg-neutral-100 p-1', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: TabsPrimitive.TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'rounded-sm px-3 py-1.5 text-sm font-medium text-neutral-600 transition-colors',
        'hover:text-neutral-900',
        'data-[state=active]:bg-neutral-0 data-[state=active]:text-neutral-900 data-[state=active]:shadow-xs',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: TabsPrimitive.TabsContentProps) {
  return <TabsPrimitive.Content className={cn('mt-4 focus-visible:outline-none', className)} {...props} />;
}
