'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api-client';

export default function RegisterPage() {
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
      await api.register({ email, password });
      await api.login({ email, password });
      router.push('/board');
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ maxWidth: 360, margin: '80px auto', padding: 24 }}>
      <h1>Create an account</h1>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input
          type="email" placeholder="Email" required value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ padding: 8 }}
        />
        <input
          type="password" placeholder="Password (min 8 characters)" required minLength={8} value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ padding: 8 }}
        />
        {error && <p style={{ color: 'crimson', margin: 0 }}>{error}</p>}
        <button type="submit" disabled={submitting} style={{ padding: 10 }}>
          {submitting ? 'Creating…' : 'Register'}
        </button>
      </form>
      <p style={{ marginTop: 16 }}>
        Already have an account? <a href="/login">Log in</a>
      </p>
    </main>
  );
}
