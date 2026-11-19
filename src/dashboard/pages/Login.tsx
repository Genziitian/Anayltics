import { useState } from 'react';
import { Mark } from '../components/Logo';
import { ThemeToggle } from '../components/ThemeToggle';
import { api } from '../lib/api';
import { BRAND } from '../lib/brand';

/** The owner's sign-in, at a URL nothing links to. Limits and lockouts are enforced by the server. */
export function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', { method: 'POST', json: { email, password } });
      onLogin();
    } catch (err) {
      const status = (err as { status?: number }).status;
      setLocked(status === 429);
      setError((err as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col px-4">
      <div className="flex h-16 items-center justify-end">
        <ThemeToggle />
      </div>
      <div className="flex flex-1 items-start justify-center pt-[12vh]">
        <form onSubmit={submit} className="w-full max-w-[340px]">
          <span className="text-ink">
            <Mark size={36} />
          </span>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-sm text-stone-500">{BRAND} is open to its owner only.</p>

          <label className="label mt-7" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            maxLength={320}
            autoFocus
            disabled={busy}
          />

          <label className="label mt-4" htmlFor="pw">
            Password
          </label>
          <div className="relative">
            <input
              id="pw"
              type={show ? 'text' : 'password'}
              className="input pr-16"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              maxLength={1000}
              disabled={busy}
            />
            <button
              type="button"
              className="absolute inset-y-0 right-1 my-1 rounded-md px-2 text-xs font-medium text-stone-500 hover:bg-stone-100 hover:text-ink"
              onClick={() => setShow((s) => !s)}
              aria-pressed={show}
            >
              {show ? 'Hide' : 'Show'}
            </button>
          </div>

          {error && (
            <p role="alert" className={`mt-3 rounded-lg px-3 py-2 text-sm ${locked ? 'bg-amber-50 text-amber-800' : 'bg-red-50 text-red-600'}`}>
              {error}
            </p>
          )}

          <button className="btn-dark mt-5 w-full py-2" disabled={busy || !email || !password}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
