'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthShell, FormField, Input, Button, Alert } from '@careerpilot/ui';
import { api, ApiError } from '@/lib/api-client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.login({ email, password });
      router.push('/board');
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Log in"
      footer={
        <>
          No account?{' '}
          <a href="/register" className="font-medium text-primary-600 hover:text-primary-700">
            Register
          </a>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <FormField label="Email">
          <Input type="email" placeholder="you@example.com" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </FormField>
        <FormField label="Password">
          <Input
            type="password"
            placeholder="Password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </FormField>
        {error && <Alert variant="danger">{error}</Alert>}
        <Button type="submit" disabled={submitting} loading={submitting}>
          {submitting ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
    </AuthShell>
  );
}
