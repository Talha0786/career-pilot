import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { cn } from '../lib/cn.js';
import type { AlertVariant } from './Alert.js';

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  variant?: AlertVariant;
}

interface ToastContextValue {
  push: (toast: Omit<ToastMessage, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_CLASSES: Record<AlertVariant, string> = {
  info: 'border-primary-200',
  success: 'border-success-500/40',
  warning: 'border-warning-500/40',
  danger: 'border-danger-500/40',
};

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const push = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    counter += 1;
    const id = `toast-${counter}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="right">
        {children}
        {toasts.map((toast) => (
          <ToastPrimitive.Root
            key={toast.id}
            duration={5000}
            onOpenChange={(open) => {
              if (!open) remove(toast.id);
            }}
            className={cn(
              'rounded-lg border bg-neutral-0 px-4 py-3 shadow-lg data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]',
              VARIANT_CLASSES[toast.variant ?? 'info'],
            )}
          >
            <ToastPrimitive.Title className="text-sm font-semibold text-neutral-900">{toast.title}</ToastPrimitive.Title>
            {toast.description && (
              <ToastPrimitive.Description className="mt-1 text-sm text-neutral-500">
                {toast.description}
              </ToastPrimitive.Description>
            )}
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-50 flex w-full max-w-sm flex-col gap-2 p-6 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
