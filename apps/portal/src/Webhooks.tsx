import { useEffect, useState, type FormEvent } from 'react';

import { api, ApiError, type Project } from './api.ts';
import { Dialog, Footer, useDecision } from './Dialog.tsx';
import { copy, OnceSecret, PageHead, Section } from './ui.tsx';

export function Webhooks({ project, network, onChange }: { project: Project; network: string; onChange: () => void }) {
  const [url, setUrl] = useState(project.webhook_url ?? '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [rotating, setRotating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  useEffect(() => { setUrl(project.webhook_url ?? ''); }, [project.id, project.webhook_url]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await api.setWebhook(project.id, url.trim());
      setMessage({ tone: 'ok', text: url.trim() === '' ? 'Notifications are off.' : 'Saved. Notifications go to this address.' });
      onChange();
    } catch (err) {
      setMessage({ tone: 'err', text: err instanceof ApiError ? err.message : 'Could not reach Relay. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHead title="Webhooks" sub="Relay calls your server when a top-up is credited or a payout changes state." />

      <Section title="Address">
        <form onSubmit={save} style={{ display: 'grid', gap: 10, maxWidth: 560, paddingTop: 14 }}>
          <input className="field mono" placeholder="https://example.com/relay/webhook" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} />
          <div style={{ fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.55 }}>
            {network === 'mainnet' ? 'Must start with https://.' : 'On the test network http:// is accepted too.'} Leave empty to turn notifications off.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="submit" className="btn btn-primary" disabled={saving || url.trim() === (project.webhook_url ?? '')}>{saving ? 'Saving…' : 'Save'}</button>
            {message && <span role="status" style={{ fontSize: 12, color: message.tone === 'ok' ? 'var(--ok)' : 'var(--err)' }}>{message.text}</span>}
          </div>
        </form>
      </Section>

      <Section title="Signing secret">
        <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.65, paddingTop: 12, maxWidth: 640 }}>
          Every notification carries a <span className="mono">relay-signature</span> header:
          <span className="mono"> t=&lt;time&gt;,v1=&lt;HMAC-SHA256 of "time.body"&gt;</span>, made with this secret.
          Check it on your server and refuse anything older than five minutes, so a captured notification cannot be replayed.
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => setRotating(true)}>{project.has_webhook_secret ? 'Create a new secret' : 'Create secret'}</button>
          </div>
        </div>
      </Section>

      {rotating && (
        <RotateSecret projectId={project.id} replacing={project.has_webhook_secret} onClose={() => setRotating(false)}
          onDone={(s) => { setRotating(false); setSecret(s); onChange(); }} />
      )}
      {secret && <ShowSecret secret={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function RotateSecret({ projectId, replacing, onClose, onDone }: { projectId: string; replacing: boolean; onClose: () => void; onDone: (s: string) => void }) {
  const { busy, error, go } = useDecision(async () => onDone((await api.rotateWebhookSecret(projectId)).secret), () => undefined);
  return (
    <Dialog title="New signing secret" onClose={onClose} busy={busy}>
      <div style={{ padding: '16px 16px 4px', fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.6 }}>
        {replacing
          ? 'The current secret stops working at once. Notifications signed with the new one will fail your check until your server has it.'
          : 'Notifications will be signed with it from now on.'}
      </div>
      <Footer error={error}>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={go} disabled={busy}>{busy ? 'Creating…' : 'Create secret'}</button>
      </Footer>
    </Dialog>
  );
}

function ShowSecret({ secret, onClose }: { secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog title="Signing secret" onClose={onClose} busy={false}>
      <div style={{ padding: '16px 16px 4px' }}>
        <OnceSecret value={secret} note="Copy it into your server's settings now. It is not shown again; if it is lost, create a new one." />
      </div>
      <Footer error={null}>
        <button className="btn" onClick={() => void copy(secret).then(setCopied)}>{copied ? 'Copied' : 'Copy secret'}</button>
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </Footer>
    </Dialog>
  );
}
