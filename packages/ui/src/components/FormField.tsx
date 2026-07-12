import { cloneElement, useId } from 'react';
import type { ReactElement } from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '../lib/cn.js';

export interface FormFieldProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; invalid?: boolean }>;
}

export function FormField({ label, hint, error, required, className, children }: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined;

  const field = cloneElement(children, {
    id,
    ...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {}),
    'aria-invalid': Boolean(error),
    invalid: Boolean(error),
  });

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <LabelPrimitive.Root htmlFor={id} className="text-sm font-medium text-neutral-800">
        {label}
        {required && <span className="ml-0.5 text-danger-500">*</span>}
      </LabelPrimitive.Root>
      {field}
      {error ? (
        <p id={errorId} className="text-sm text-danger-600">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-neutral-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
