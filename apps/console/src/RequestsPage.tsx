import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { api, ApiError, type AccessRequest, type Invite, type RequestStatus } from './api.ts';
import { Dialog, Footer, Row, useDecision } from './Dialogs.tsx';
import { age, timestamp } from './format.ts';

const TABS: [RequestStatus, string][] = [['new', 'New'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']];

const EMPTY: Record<RequestStatus, string> = {
  new: 'No applications waiting.', approved: 'No approved applications yet.', rejected: 'Nothing rejected.', all: 'No applications yet.',
};

export const VOLUME: Record<string, string> = {
  under_10k: 'under $10k / month', '10k_100k': '$10k–100k / month', '100k_1m': '$100k–1M / month', over_1m: 'over $1M / month',
};

const STATUS: Record<string, { label: string; color: string }> = {
  new: { label: 'New', color: 'var(--warn)' },
  approved: { label: 'Approved', color: 'var(--ok)' },
  rejected: { label: 'Rejected', color: 'var(--t3)' },
};

/** Where an approved applicant stands: still to use their link, or signed up. */
const accountLabel = (r: AccessRequest) =>
  r.status !== 'approved' ? null : r.account_status === 'active' ? 'Signed up' : r.account_status === 'invited' ? 'Invitation sent' : r.account_status;

const GRID = 'minmax(0,1.3fr) minmax(0,1.3fr) 150px 70px 150px';

export function RequestsPage({ canDecide, onChange }: { canDecide: boolean; onChange: () => void }) {
  const [tab, setTab] = useState<RequestStatus>('new');
  const [rows, setRows] = useState<AccessRequest[] | null>(null);
  const [selected, setSelected] = useState<AccessRequest | null>(null);
  const [dialog, setDialog] = useState<'approve' | 'reject' | null>(null);
  const [invite, setInvite] = useState<(Invite & { company: string; email: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  const load = useCallback(async () => {
    try {
      const list = (await api.requests(tab)).data;
      setRows(list);
      setError(null);
      setSelected((current) => (current === null ? null : list.find((r) => r.id === current.id) ?? current));
      changed.current();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load applications');
    }
  }, [tab]);

  useEffect(() => {
    setRows(null);
    void load();
    const poll = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(poll);
  }, [load]);

  const showInvite = (r: AccessRequest, i: Invite) => setInvite({ ...i, company: r.company, email: r.email });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, padding: '22px 24px 16px' }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.015em' }}>Applications</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>Requests for API access from the website{canDecide ? '' : ' · view only'}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {error && <span style={{ fontSize: 11.5, color: 'var(--err)' }}>{error}</span>}
          <button className="btn" onClick={() => void load()}>Refresh</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, padding: '0 24px', borderBottom: '1px solid var(--line)' }}>
        {TABS.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} aria-pressed={key === tab}
            style={{ padding: '0 0 9px', border: 0, background: 'none', cursor: 'pointer', fontSize: 12.5,
              color: key === tab ? 'var(--t1)' : 'var(--t3)', boxShadow: key === tab ? 'inset 0 -1px 0 var(--t1)' : 'none' }}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ padding: '0 24px 32px', overflowX: 'auto' }}>
        <div style={{ minWidth: 820 }}>
          <div className="eyebrow" style={{ display: 'grid', gridTemplateColumns: GRID, padding: '14px 8px 7px', borderBottom: '1px solid var(--line)', letterSpacing: '0.11em' }}>
            <div>Company</div><div>Contact</div><div>Volume</div><div style={{ textAlign: 'right' }}>Age</div><div style={{ paddingLeft: 18 }}>Status</div>
          </div>
          {rows === null && <div style={{ padding: '20px 8px', fontSize: 12, color: 'var(--t3)' }}>Loading…</div>}
          {rows !== null && rows.length === 0 && <div style={{ padding: '28px 8px', fontSize: 12.5, color: 'var(--t3)' }}>{EMPTY[tab]}</div>}
          {rows?.map((r) => {
            const st = STATUS[r.status]!;
            return (
              <div key={r.id} className="prow" role="button" tabIndex={0} onClick={() => setSelected(r)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(r); } }}
                style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', padding: '11px 8px', borderBottom: '1px solid var(--line-soft)', cursor: 'pointer' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.company}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.website ?? '—'}</div>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.contact_name}</div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.email}</div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--t2)' }}>{VOLUME[r.monthly_volume] ?? r.monthly_volume}</div>
                <div className="mono" style={{ textAlign: 'right', fontSize: 11.5, color: 'var(--t3)' }}>{age(r.created_at)}</div>
                <div style={{ paddingLeft: 18, fontSize: 12 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7, color: st.color }}><span className="dot" style={{ background: st.color }} />{st.label}</span>
                  {accountLabel(r) && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, paddingLeft: 13 }}>{accountLabel(r)}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {selected && (
        <RequestDrawer request={selected} canDecide={canDecide} onClose={() => setSelected(null)} onDecide={setDialog}
          onInvite={(i) => { showInvite(selected, i); void load(); }} />
      )}
      {dialog === 'approve' && selected && (
        <ApproveDialog request={selected} onClose={() => setDialog(null)}
          onDone={(r, i) => { setDialog(null); setSelected(null); showInvite(r, i); void load(); }} />
      )}
      {dialog === 'reject' && selected && (
        <RejectDialog request={selected} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setSelected(null); void load(); }} />
      )}
      {invite && <InviteDialog invite={invite} onClose={() => setInvite(null)} />}
    </div>
  );
}

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return <div className="kv"><div className="k">{k}</div><div className="v">{children}</div></div>;
}

function RequestDrawer({ request: r, canDecide, onClose, onDecide, onInvite }: {
  request: AccessRequest; canDecide: boolean; onClose: () => void; onDecide: (d: 'approve' | 'reject') => void; onInvite: (i: Invite) => void;
}) {
  const st = STATUS[r.status]!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role=dialog]')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const reinvite = async () => {
    setBusy(true);
    setError(null);
    try {
      onInvite(await api.reinvite(r.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the console.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside aria-label="Application details" style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, maxWidth: '100vw', zIndex: 40, display: 'flex', flexDirection: 'column',
      background: 'var(--panel)', borderLeft: '1px solid var(--line)', boxShadow: '-24px 0 48px rgba(0,0,0,0.35)', animation: 'panin 160ms ease-out',
    }}>
      <div style={{ height: 50, flex: '0 0 50px', display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: '1px solid var(--line-soft)' }}>
        <span className="eyebrow">Application</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: st.color }}><span className="dot" style={{ background: st.color }} />{st.label}</span>
        <button className="btn" onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', width: 28, justifyContent: 'center', padding: 0 }}>✕</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 16px 24px' }}>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>{r.company}</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>{VOLUME[r.monthly_volume] ?? r.monthly_volume}</div>
        <div style={{ marginTop: 14, padding: '10px 12px', fontSize: 12.5, lineHeight: 1.55, color: 'var(--t2)', background: 'var(--raised)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {r.use_case}
        </div>
        <div style={{ marginTop: 16 }}>
          <Kv k="Contact">{r.contact_name}</Kv>
          <Kv k="Email"><span className="mono">{r.email}</span></Kv>
          {r.telegram && <Kv k="Telegram"><span className="mono">@{r.telegram}</span></Kv>}
          {r.website && <Kv k="Website"><span className="mono">{r.website}</span></Kv>}
          <Kv k="Received"><span className="mono">{timestamp(r.created_at)}</span></Kv>
          {r.ip && <Kv k="From IP"><span className="mono">{r.ip}</span></Kv>}
          {r.decided_at && <Kv k="Decided">{r.decided_by ?? '—'}<span className="mono" style={{ color: 'var(--t3)' }}> · {timestamp(r.decided_at)}</span></Kv>}
          {r.decision_note && <Kv k="Note">{r.decision_note}</Kv>}
          {accountLabel(r) && <Kv k="Account">{accountLabel(r)}</Kv>}
        </div>
        {error && <div role="alert" style={{ fontSize: 12, color: 'var(--err)', marginTop: 12 }}>{error}</div>}
      </div>
      {canDecide && r.status === 'new' && (
        <div style={{ display: 'flex', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--line-soft)', background: 'var(--chrome)' }}>
          <button className="btn btn-reject" style={{ flex: 1, justifyContent: 'center' }} onClick={() => onDecide('reject')}>Reject</button>
          <button className="btn btn-approve" style={{ flex: 1, justifyContent: 'center' }} onClick={() => onDecide('approve')}>Approve</button>
        </div>
      )}
      {canDecide && r.status === 'approved' && r.account_status === 'invited' && (
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--line-soft)', background: 'var(--chrome)' }}>
          <button className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={busy} onClick={() => void reinvite()}>
            {busy ? 'Creating…' : 'New invitation link'}
          </button>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 8, lineHeight: 1.5 }}>For when the first link expired or was lost. The old link stops working.</div>
        </div>
      )}
    </aside>
  );
}

function ApproveDialog({ request: r, onClose, onDone }: { request: AccessRequest; onClose: () => void; onDone: (r: AccessRequest, i: Invite) => void }) {
  const [name, setName] = useState(r.company);
  const [fee, setFee] = useState('1');
  const feeNumber = Number(fee.replace(',', '.'));
  const feeOk = fee.trim() !== '' && Number.isFinite(feeNumber) && feeNumber >= 0 && feeNumber <= 20;
  const { busy, error, go } = useDecision(async () => {
    const result = await api.approveRequest(r.id, name.trim(), feeNumber);
    onDone(result.request, result);
  }, () => undefined);

  return (
    <Dialog title="Approve application" onClose={onClose} busy={busy}>
      <div style={{ padding: '16px 16px 4px' }}>
        <div style={{ fontSize: 12, color: 'var(--t2)', lineHeight: 1.55 }}>
          Creates the merchant <span style={{ color: 'var(--t1)' }}>{r.company}</span>, their first project, and an account for {r.contact_name}. You get a one-time link to send them.
        </div>
        <label style={{ display: 'grid', gap: 6, marginTop: 14 }}>
          <span className="eyebrow">Project name</span>
          <input className="field" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ display: 'grid', gap: 6, marginTop: 12 }}>
          <span className="eyebrow">Relay fee on each top-up, %</span>
          <input className="field mono" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} style={{ maxWidth: 120 }} />
        </label>
        <div style={{ marginTop: 8 }}><Row k="Contact"><span className="mono">{r.email}</span></Row></div>
      </div>
      <Footer error={error ?? (feeOk ? null : 'The fee must be between 0 and 20 percent')}>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-approve" onClick={go} disabled={busy || !feeOk || name.trim() === ''}>{busy ? 'Approving…' : 'Approve and create link'}</button>
      </Footer>
    </Dialog>
  );
}

function RejectDialog({ request: r, onClose, onDone }: { request: AccessRequest; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const { busy, error, go } = useDecision(() => api.rejectRequest(r.id, note.trim()), onDone);
  return (
    <Dialog title="Reject application" onClose={onClose} busy={busy}>
      <div style={{ padding: '16px 16px 4px' }}>
        <div style={{ fontSize: 12, color: 'var(--t2)', lineHeight: 1.55 }}>
          {r.company} is not told automatically. Write to {r.email} yourself if you want to.
        </div>
        <label style={{ display: 'grid', gap: 6, marginTop: 14 }}>
          <span className="eyebrow">Reason, for the record</span>
          <textarea className="field" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. business type we do not serve" />
        </label>
      </div>
      <Footer error={error}>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-reject" onClick={go} disabled={busy || note.trim() === ''}>{busy ? 'Rejecting…' : 'Reject'}</button>
      </Footer>
    </Dialog>
  );
}

/** The one time the invitation link is visible. */
function InviteDialog({ invite, onClose }: { invite: Invite & { company: string; email: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite.invite_url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Dialog title="Invitation link" onClose={onClose} busy={false}>
      <div style={{ padding: '16px 16px 4px' }}>
        <div style={{ fontSize: 12, color: 'var(--t2)', lineHeight: 1.55 }}>
          Send this link to {invite.company} at <span className="mono" style={{ color: 'var(--t1)' }}>{invite.email}</span>. It works once and expires in {invite.expires_in_days} days.
          It is not shown again: if it gets lost, create a new one from the application.
        </div>
        <div className="mono" style={{ marginTop: 12, padding: '10px 12px', fontSize: 11.5, lineHeight: 1.5, wordBreak: 'break-all', background: 'var(--raised)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', userSelect: 'all' }}>
          {invite.invite_url}
        </div>
      </div>
      <Footer error={null}>
        <button className="btn" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</button>
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </Footer>
    </Dialog>
  );
}
