import { useEffect, useState, type ReactNode } from 'react';

import { api, type AuditEntry, type Payout } from './api.ts';
import { explorerUrl, money, timestamp, STATE } from './format.ts';
import { AuditLine } from './AuditPage.tsx';

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return <div className="kv"><div className="k">{k}</div><div className="v">{children}</div></div>;
}

export function PayoutDrawer({ payout: p, network, canDecide, onClose, onDecide }: {
  payout: Payout; network: string; canDecide: boolean; onClose: () => void; onDecide: (kind: 'approve' | 'reject') => void;
}) {
  const [trail, setTrail] = useState<AuditEntry[] | null>(null);
  const state = STATE[p.state] ?? { label: p.state, color: 'var(--t3)' };

  useEffect(() => {
    let live = true;
    setTrail(null);
    api.audit(p.id).then((r) => { if (live) setTrail(r.data); }, () => { if (live) setTrail([]); });
    return () => { live = false; };
  }, [p.id, p.state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role=dialog]')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside aria-label="Payout details" style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 396, maxWidth: '100vw', zIndex: 40, display: 'flex', flexDirection: 'column',
      background: 'var(--panel)', borderLeft: '1px solid var(--line)', boxShadow: '-24px 0 48px rgba(0,0,0,0.35)', animation: 'panin 160ms ease-out',
    }}>
      <div style={{ height: 50, flex: '0 0 50px', display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: '1px solid var(--line-soft)' }}>
        <span className="eyebrow">Payout</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: state.color }}>
          <span className="dot" style={{ background: state.color }} />{state.label}
        </span>
        <button className="btn" onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', width: 28, justifyContent: 'center', padding: 0 }}>✕</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 16px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="mono" style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em' }}>{money(p.net_amount)}</span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--t3)' }}>{p.asset}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>to {p.merchant.name} · {p.project.name}</div>

        {p.state === 'failed' && p.error && <Notice color="var(--err)">{p.error}</Notice>}
        {p.state === 'rejected' && p.rejected_reason && <Notice color="var(--t2)">Rejected: {p.rejected_reason}</Notice>}

        <div style={{ marginTop: 16 }}>
          <Kv k="Payout ID"><span className="mono">{p.id}</span></Kv>
          {p.external_ref && <Kv k="Merchant ref"><span className="mono">{p.external_ref}</span></Kv>}
          <Kv k="Requested"><span className="mono">{money(p.amount)}</span></Kv>
          <Kv k="Relay fee"><span className="mono">{money(p.fee_amount)}</span></Kv>
          <Kv k="Sends"><span className="mono">{money(p.net_amount)}</span></Kv>
          <Kv k="To"><span className="mono">{p.to_address}</span></Kv>
          {p.from_address && <Kv k="From"><span className="mono">{p.from_address}</span></Kv>}
          {p.tx_hash && (
            <Kv k="Transaction">
              <a className="mono" href={explorerUrl(network, p.tx_hash)} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--info)' }}>{p.tx_hash}</a>
            </Kv>
          )}
          {p.approved_by && <Kv k="Approved by">{p.approved_by}{p.approved_at ? <span className="mono" style={{ color: 'var(--t3)' }}> · {timestamp(p.approved_at)}</span> : null}</Kv>}
          {p.attempt > 0 && <Kv k="Attempts"><span className="mono">{p.attempt}</span></Kv>}
          <Kv k="Created"><span className="mono">{timestamp(p.created_at)}</span></Kv>
          {p.completed_at && <Kv k="Completed"><span className="mono">{timestamp(p.completed_at)}</span></Kv>}
        </div>

        <div className="eyebrow" style={{ margin: '22px 0 6px' }}>Activity</div>
        {trail === null && <div style={{ fontSize: 12, color: 'var(--t3)' }}>Loading…</div>}
        {trail !== null && trail.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No operator actions yet.</div>}
        {trail?.map((entry) => <AuditLine key={entry.id} entry={entry} compact />)}
      </div>

      {canDecide && p.state === 'requested' && (
        <div style={{ display: 'flex', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--line-soft)', background: 'var(--chrome)' }}>
          <button className="btn btn-reject" style={{ flex: 1, justifyContent: 'center' }} onClick={() => onDecide('reject')}>Reject</button>
          <button className="btn btn-approve" style={{ flex: 1, justifyContent: 'center' }} onClick={() => onDecide('approve')}>Approve</button>
        </div>
      )}
    </aside>
  );
}

function Notice({ color, children }: { color: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 14, padding: '9px 11px', fontSize: 12, lineHeight: 1.5, color, border: '1px solid var(--line)', borderLeft: '2px solid ' + color, borderRadius: 'var(--radius)', background: 'var(--raised)', wordBreak: 'break-word' }}>
      {children}
    </div>
  );
}
