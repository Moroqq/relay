import { StrictMode, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';
import { Header } from './Hero.tsx';
import { Footer } from './Sections.tsx';

const VOLUMES: [string, string][] = [
  ['under_10k', 'Under $10,000 a month'],
  ['10k_100k', '$10,000 – $100,000 a month'],
  ['100k_1m', '$100,000 – $1,000,000 a month'],
  ['over_1m', 'Over $1,000,000 a month'],
];

const STEPS = [
  ['We read your application', 'A person at Relay looks at every one: what you run and how you plan to accept payments.'],
  ['You get an invitation', 'If it is a fit, we send a personal link to the email you give here.'],
  ['You set up your dashboard', 'Choose a password, add Relay to an authenticator app, create an API key and start testing.'],
];

type Field = 'company' | 'website' | 'contact_name' | 'email' | 'telegram' | 'monthly_volume' | 'use_case';

function AccessPage() {
  const [values, setValues] = useState<Record<Field | 'fax', string>>({
    company: '', website: '', contact_name: '', email: '', telegram: '', monthly_volume: '', use_case: '', fax: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: string | null; message: string } | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const set = (field: Field | 'fax') => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [field]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/portal/api/access-requests', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-relay-portal': '1' },
        body: JSON.stringify(values),
      });
      if (response.ok) {
        setSentTo(values.email.trim());
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      const code = body?.error?.code ?? '';
      setError({
        field: code.startsWith('invalid_') ? code.slice('invalid_'.length) : null,
        message: body?.error?.message ?? 'Something went wrong. Try again in a minute.',
      });
    } catch {
      setError({ field: null, message: 'Could not reach Relay. Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  };

  const invalid = (field: Field) => error?.field === field;

  return (
    <div className="page">
      <div className="top"><Header /></div>
      <main className="access">
        <div className="wrap access-grid">
          <div className="access-intro">
            <div className="eyebrow">GET API ACCESS</div>
            <h1 className="access-title">Tell us about your platform.</h1>
            <p className="lead">Relay works with internet businesses that accept USDT or TRX on TRON. Access is by application, so we know who we move money for.</p>
            <ol className="access-steps">
              {STEPS.map(([title, text], i) => (
                <li key={title}>
                  <span className="n mono">{String(i + 1).padStart(2, '0')}</span>
                  <div><div className="t">{title}</div><div className="d">{text}</div></div>
                </li>
              ))}
            </ol>
            <p className="access-have">Already have an account? <a href="/app/">Log in →</a></p>
          </div>

          <div className="panel access-panel">
            {sentTo !== null ? (
              <div className="access-done" role="status">
                <div className="dot bg-ok" />
                <div className="t">Application received.</div>
                <div className="d">We will reply to <span className="mono">{sentTo}</span>. There is nothing else you need to do for now.</div>
                <a className="btn" href="/">Back to the site</a>
              </div>
            ) : (
              <form onSubmit={submit} noValidate>
                <div className="access-row">
                  <label className={invalid('company') ? 'bad' : ''}>
                    <span>Company or project</span>
                    <input required maxLength={120} autoComplete="organization" value={values.company} onChange={set('company')} />
                  </label>
                  <label className={invalid('website') ? 'bad' : ''}>
                    <span>Website <em>optional</em></span>
                    <input maxLength={200} inputMode="url" placeholder="example.com" value={values.website} onChange={set('website')} />
                  </label>
                </div>
                <div className="access-row">
                  <label className={invalid('contact_name') ? 'bad' : ''}>
                    <span>Your name</span>
                    <input required maxLength={120} autoComplete="name" value={values.contact_name} onChange={set('contact_name')} />
                  </label>
                  <label className={invalid('email') ? 'bad' : ''}>
                    <span>Work email</span>
                    <input required type="email" maxLength={254} autoComplete="email" value={values.email} onChange={set('email')} />
                  </label>
                </div>
                <div className="access-row">
                  <label className={invalid('telegram') ? 'bad' : ''}>
                    <span>Telegram <em>optional</em></span>
                    <input maxLength={65} placeholder="@username" value={values.telegram} onChange={set('telegram')} />
                  </label>
                  <label className={invalid('monthly_volume') ? 'bad' : ''}>
                    <span>Expected volume</span>
                    <select required value={values.monthly_volume} onChange={set('monthly_volume')}>
                      <option value="" disabled>Choose…</option>
                      {VOLUMES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                    </select>
                  </label>
                </div>
                <label className={invalid('use_case') ? 'bad' : ''}>
                  <span>What will you use Relay for?</span>
                  <textarea required maxLength={2000} rows={4} placeholder="For example: balance top-ups for players on our gaming platform, paid in USDT." value={values.use_case} onChange={set('use_case')} />
                </label>
                {/* For bots only: people never see or fill this. */}
                <label className="access-trap" aria-hidden="true">
                  Fax <input tabIndex={-1} autoComplete="off" value={values.fax} onChange={set('fax')} />
                </label>
                {error && <div className="access-error" role="alert">{error.message}</div>}
                <div className="access-submit">
                  <button type="submit" className="btn" disabled={busy}>{busy ? 'Sending…' : 'Send application'}</button>
                  <span>We use these details only to review your application.</span>
                </div>
              </form>
            )}
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AccessPage />
  </StrictMode>,
);
