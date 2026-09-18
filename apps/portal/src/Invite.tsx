import { useEffect, useState, type FormEvent } from 'react';
import qrcode from 'qrcode-generator';

import { api, ApiError } from './api.ts';

const MIN_PASSWORD = 12;

/** The secret grouped in fours, for typing into an app by hand. */
const grouped = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

function qrDataUri(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
}

/**
 * Accepting an invitation: choose a password, set up an authenticator app,
 * prove it works with one code. Only then does the account exist to sign in to.
 */
export function Invite({ token, onDone }: { token: string; onDone: () => void }) {
  const [info, setInfo] = useState<{ email: string; name: string; company: string } | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [secret, setSecret] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.inspectInvite(token).then(setInfo, (err: unknown) => {
      setInvalid(err instanceof ApiError ? err.message : 'Could not reach Relay. Try again.');
    });
  }, [token]);

  const passwordOk = password.length >= MIN_PASSWORD && password === confirm;

  const showCode = async () => {
    setBusy(true);
    setError(null);
    try {
      setSecret(await api.startInvite(token));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach Relay. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.completeInvite(token, password, code.trim());
      // The link is spent; drop it from the address bar and history.
      history.replaceState(null, '', location.pathname);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach Relay. Try again.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div style={{ width: '100%', maxWidth: 440, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', animation: 'fadein 160ms ease-out' }}>
        <div style={{ height: 50, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderBottom: '1px solid var(--line-soft)' }}>
          <img src="/app/relay-mark.webp" alt="" width={24} height={16} />
          <div style={{ fontSize: 14, fontWeight: 600 }}>Relay</div>
          <div className="eyebrow" style={{ marginLeft: 'auto' }}>Set up access</div>
        </div>

        {invalid && (
          <div style={{ padding: 16, fontSize: 12.5, lineHeight: 1.6, color: 'var(--t2)' }}>
            {invalid}. Ask your Relay contact for a new link.
            <div style={{ marginTop: 14 }}><a className="btn" href="/app/">Go to sign in</a></div>
          </div>
        )}

        {info && (
          <form onSubmit={submit} style={{ padding: 16, display: 'grid', gap: 14 }}>
            <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--t2)' }}>
              {info.name}, this sets up your access to Relay for <span style={{ color: 'var(--t1)' }}>{info.company}</span>.
              You will sign in as <span className="mono" style={{ color: 'var(--t1)' }}>{info.email}</span>.
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <span className="eyebrow">1 · Choose a password</span>
              <input className="field" type="password" autoComplete="new-password" placeholder={'At least ' + MIN_PASSWORD + ' characters'} value={password} onChange={(e) => setPassword(e.target.value)} />
              <input className="field" type="password" autoComplete="new-password" placeholder="The same again" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              {confirm !== '' && password !== confirm && <span style={{ fontSize: 11.5, color: 'var(--warn)' }}>The two passwords differ.</span>}
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              <span className="eyebrow">2 · Add Relay to an authenticator app</span>
              {!secret && (
                <>
                  <span style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.55 }}>
                    Google Authenticator, Aegis, 1Password or any app that shows six-digit codes. Each sign-in asks for the current code.
                  </span>
                  <button type="button" className="btn" disabled={busy || !passwordOk} onClick={() => void showCode()} style={{ justifySelf: 'start' }}>
                    Show the QR code
                  </button>
                </>
              )}
              {secret && (
                <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                  <img src={qrDataUri(secret.otpauth)} alt="QR code for your authenticator app" width={148} height={148} style={{ borderRadius: 4, background: '#fff', flex: '0 0 auto' }} />
                  <div style={{ fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.6 }}>
                    Scan it with the app. Or type this key in by hand:
                    <div className="mono" style={{ color: 'var(--t1)', marginTop: 6, wordBreak: 'break-all' }}>{grouped(secret.secret)}</div>
                  </div>
                </div>
              )}
            </div>

            {secret && (
              <label style={{ display: 'grid', gap: 6 }}>
                <span className="eyebrow">3 · Enter the code the app shows</span>
                <input className="field mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000"
                  value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ letterSpacing: '0.3em', maxWidth: 160 }} />
              </label>
            )}

            {error && <div role="alert" style={{ fontSize: 12, color: 'var(--err)' }}>{error}</div>}

            {secret && (
              <button type="submit" className="btn btn-primary" disabled={busy || !passwordOk || code.length !== 6} style={{ justifyContent: 'center' }}>
                {busy ? 'Setting up…' : 'Finish and sign in'}
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
