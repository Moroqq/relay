import { useState, type FormEvent } from 'react';

import { api, ApiError } from './api.ts';

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(email, password, code);
      onSignedIn();
    } catch (err) {
      // The server answers every failure identically on purpose, so there is
      // nothing more specific to show — and a code that was right a moment ago
      // cannot be used again, so it is cleared.
      setError(err instanceof ApiError && err.status === 401 ? 'Email, password or code is incorrect.' : 'Could not reach Relay. Try again.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form
        onSubmit={submit}
        style={{ width: '100%', maxWidth: 340, border: '1px solid var(--line)', borderRadius: 'var(--radius)', background: 'var(--chrome)' }}
      >
        <div style={{ height: 50, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderBottom: '1px solid var(--line-soft)' }}>
          <div style={{ width: 14, height: 14, borderRadius: 3, background: 'linear-gradient(180deg,#8C8FF5,#5B5FD6)' }} />
          <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>Relay</div>
          <div className="eyebrow" style={{ marginLeft: 'auto' }}>Dashboard</div>
        </div>

        <div style={{ padding: '20px 16px 18px', display: 'grid', gap: 14 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span className="eyebrow">Email</span>
            <input className="field" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            <span className="eyebrow">Password</span>
            <input className="field" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            <span className="eyebrow">Authenticator code</span>
            <input
              className="field mono"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
              style={{ letterSpacing: '0.3em', fontSize: 15 }}
            />
          </label>

          {error && (
            <div role="alert" style={{ fontSize: 12, color: 'var(--err)', display: 'flex', alignItems: 'center' }}>
              <span className="dot" />
              {error}
            </div>
          )}

          <button className="btn btn-primary" type="submit" disabled={busy} style={{ height: 34, justifyContent: 'center', fontWeight: 500 }}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>

          <div style={{ fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.5 }}>
            Five wrong attempts lock the account for fifteen minutes. No account yet? <a href="/access/" style={{ color: 'var(--t2)' }}>Apply for API access</a>.
          </div>
        </div>
      </form>
    </div>
  );
}
