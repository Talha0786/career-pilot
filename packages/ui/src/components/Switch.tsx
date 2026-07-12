import { forwardRef } from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '../lib/cn.js';

export interface SwitchProps extends SwitchPrimitive.SwitchProps {}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'relative h-6 w-11 shrink-0 rounded-full bg-neutral-200 transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
      'data-[state=checked]:bg-primary-600',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'block h-5 w-5 translate-x-0.5 rounded-full bg-neutral-0 shadow-sm transition-transform',
        'data-[state=checked]:translate-x-[22px]',
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';
