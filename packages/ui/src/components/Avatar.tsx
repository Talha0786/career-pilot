import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { cn } from '../lib/cn.js';

export interface AvatarProps {
  src?: string;
  alt?: string;
  fallback: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_CLASSES = { sm: 'h-6 w-6 text-xs', md: 'h-9 w-9 text-sm', lg: 'h-12 w-12 text-base' };

export function Avatar({ src, alt, fallback, size = 'md', className }: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary-100 font-medium text-primary-700',
        SIZE_CLASSES[size],
        className,
      )}
    >
      {src && <AvatarPrimitive.Image src={src} alt={alt ?? ''} className="h-full w-full object-cover" />}
      <AvatarPrimitive.Fallback delayMs={src ? 400 : 0}>{fallback}</AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
