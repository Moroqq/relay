import { useCallback, useEffect, useState } from 'react';

import { api, type ApiKey, type Project } from './api.ts';
import { Dialog, Footer, useDecision } from './Dialog.tsx';
import { age } from './format.ts';
import { copy, Empty, OnceSecret, PageHead, Section } from './ui.tsx';

const GRID = 'minmax(0,1fr) 170px 110px 110px 110px';

export function Keys({ project, live }: { project: Project; live: boolean }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ secret: string; label: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys((await api.keys(project.id)).data);
    } catch {
      setKeys([]);
    }
  }, [project.id]);

  useEffect(() => {
    setKeys(null);
    void load();
  }, [load]);

  return (
    <div>
      <PageHead title="API keys" sub={'Your server uses a key to create payments and read balances. ' + (live ? 'These are live keys.' : 'These are test keys for the test network.')}>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>New key</button>
      </PageHead>

      <Section title="Keys">
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 640 }}>
            <div className="eyebrow" style={{ display: 'grid', gridTemplateColumns: GRID, padding: '10px 8px 7px', letterSpacing: '0.11em' }}>
              <div>Name</div><div>Key</div><div>Created</div><div>Last used</div><div />
            </div>
            {keys === null && <Empty>Loading…</Empty>}
            {keys !== null && keys.length === 0 && <Empty>No keys yet. Create one to connect your server.</Empty>}
            {keys?.map((k) => (
              <div key={k.id} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', padding: '10px 8px', borderTop: '1px solid var(--line-soft)', fontSize: 12, opacity: k.revoked_at ? 0.45 : 1 }}>
                <div>{k.label || <span style={{ color: 'var(--t3)' }}>Unnamed</span>}</div>
                <div className="mono" style={{ fontSize: 11.5, color: 'var(--t2)' }}>{k.prefix}…</div>
                <div className="mono" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{age(k.created_at)} ago</div>
                <div className="mono" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{k.last_used_at ? age(k.last_used_at) + ' ago' : 'never'}</div>
                <div style={{ textAlign: 'right' }}>
                  {k.revoked_at
                    ? <span style={{ fontSize: 11.5, color: 'var(--t3)' }}>Revoked</span>
                    : <button className="btn btn-reject" onClick={() => setRevoking(k)}>Revoke</button>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Using a key">
        <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.65, paddingTop: 12, maxWidth: 640 }}>
          Send it in the <span className="mono">Authorization</span> header of every request to the Relay API:
          <pre className="mono" style={{ margin: '10px 0 0', padding: '10px 12px', fontSize: 12, background: 'var(--raised)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', overflowX: 'auto' }}>Authorization: Bearer {live ? 'ak_live_' : 'ak_test_'}…</pre>
          Keep keys on your server only, never in a browser or an app. If one leaks, create a new one and revoke the old.
        </div>
      </Section>

      {creating && (
        <CreateKey projectId={project.id} onClose={() => setCreating(false)}
          onDone={(k) => { setCreating(false); setCreated(k); void load(); }} />
      )}
      {created && <ShowKey secret={created.secret} label={created.label} onClose={() => setCreated(null)} />}
      {revoking && (
        <RevokeKey projectId={project.id} apiKey={revoking} onClose={() => setRevoking(null)} onDone={() => { setRevoking(null); void load(); }} />
      )}
    </div>
  );
}

function CreateKey({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: (k: { secret: string; label: string }) => void }) {
  const [label, setLabel] = useState('');
  const { busy, error, go } = useDecision(async () => onDone(await api.createKey(projectId, label.trim())), () => undefined);
  return (
    <Dialog title="New API key" onClose={onClose} busy={busy}>
      <div style={{ padding: '16px 16px 4px' }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span className="eyebrow">Name, so you know which server uses it</span>
          <input className="field" maxLength={60} placeholder="e.g. production server" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
      </div>
      <Footer error={error}>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={go} disabled={busy}>{busy ? 'Creating…' : 'Create key'}</button>
      </Footer>
    </Dialog>
  );
}

function ShowKey({ secret, label, onClose }: { secret: string; label: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog title={label ? 'Key: ' + label : 'Your new key'} onClose={onClose} busy={false}>
      <div style={{ padding: '16px 16px 4px' }}>
        <OnceSecret value={secret} note="Copy it now and put it in your server's settings. It is shown only this once; Relay keeps only a fingerprint of it." />
      </div>
      <Footer error={null}>
        <button className="btn" onClick={() => void copy(secret).then(setCopied)}>{copied ? 'Copied' : 'Copy key'}</button>
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </Footer>
    </Dialog>
  );
}

function RevokeKey({ projectId, apiKey, onClose, onDone }: { projectId: string; apiKey: ApiKey; onClose: () => void; onDone: () => void }) {
  const { busy, error, go } = useDecision(() => api.revokeKey(projectId, apiKey.id), onDone);
  return (
    <Dialog title="Revoke key" onClose={onClose} busy={busy}>
      <div style={{ padding: '16px 16px 4px', fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.6 }}>
        Requests with <span className="mono" style={{ color: 'var(--t1)' }}>{apiKey.prefix}…</span>{apiKey.label ? ' (' + apiKey.label + ')' : ''} will be refused
        from this moment. This cannot be undone.
      </div>
      <Footer error={error}>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-reject" onClick={go} disabled={busy}>{busy ? 'Revoking…' : 'Revoke key'}</button>
      </Footer>
    </Dialog>
  );
}
