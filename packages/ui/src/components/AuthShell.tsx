import type { ReactNode } from 'react';

export interface AuthShellProps {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthShell({ title, children, footer }: AuthShellProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-neutral-200 bg-neutral-0 p-8 shadow-sm">
        <h1 className="mb-6 text-xl font-semibold text-neutral-900">{title}</h1>
        {children}
        {footer && <div className="mt-6 text-center text-sm text-neutral-500">{footer}</div>}
      </div>
    </main>
  );
}
