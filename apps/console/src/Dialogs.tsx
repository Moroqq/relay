import { useEffect, useRef, useState, type ReactNode } from 'react';

import { api, ApiError, type Payout } from './api.ts';
import { money } from './format.ts';

export function Dialog({ title, onClose, busy, children }: { title: string; onClose: () => void; busy: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('textarea, button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(5,6,7,0.72)', display: 'grid', placeItems: 'center', padding: 16, animation: 'fadein 120ms ease-out' }}
    >
      <div ref={box} role="dialog" aria-modal="true" aria-label={title}
        style={{ width: '100%', maxWidth: 440, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', boxShadow: '0 24px 64px rgba(0,0,0,0.55)' }}>
        <div style={{ height: 46, display: 'flex', alignItems: 'center', padding: '0 16px', borderBottom: '1px solid var(--line-soft)', fontSize: 13.5, fontWeight: 600 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

export function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <div style={{ flex: '0 0 104px', fontSize: 11.5, color: 'var(--t3)' }}>{k}</div>
      <div style={{ minWidth: 0, fontSize: 12, wordBreak: 'break-all' }}>{children}</div>
    </div>
  );
}

export function useDecision(run: () => Promise<unknown>, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await run();
      onDone();
    } catch (err) {
      // A 409 means someone else decided first; say so plainly.
      setError(err instanceof ApiError ? err.message : 'Could not reach the console.');
      setBusy(false);
    }
  };
  return { busy, error, go };
}

export function ApproveDialog({ payout, network, onClose, onDone }: { payout: Payout; network: string; onClose: () => void; onDone: () => void }) {
  const { busy, error, go } = useDecision(() => api.approve(payout.id), onDone);
  return (
    <Dialog title="Approve payout" onClose={onClose} busy={busy}>
      <div style={{ padding: '16px 16px 4px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="mono" style={{ fontSize: 24, fontWeight: 500, letterSpacing: '-0.01em' }}>{money(payout.net_amount)}</span>
          <span style={{ fontSize: 12, color: 'var(--t3)' }}>{payout.asset} leaves the hot wallet</span>
        </div>
        <div style={{ marginTop: 12 }}>
          <Row k="Merchant">{payout.merchant.name} · {payout.project.name}</Row>
          <Row k="To"><span className="mono">{payout.to_address}</span></Row>
          <Row k="Requested"><span className="mono">{money(payout.amount)}</span> incl. <span className="mono">{money(payout.fee_amount)}</span> fee</Row>
          <Row k="Network"><span className="mono" style={{ color: network === 'mainnet' ? 'var(--ok)' : 'var(--warn)' }}>{network === 'mainnet' ? 'TRON mainnet — real funds' : 'TRON ' + network + ' — test funds'}</span></Row>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--t2)', lineHeight: 1.55, margin: '12px 0 4px' }}>
          Check the destination address. A transfer on TRON cannot be reversed once it is sent.
        </div>
      </div>
      <Footer error={error}>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-approve" onClick={go} disabled={busy}>{busy ? 'Approving…' : 'Approve payout'}</button>
      </Footer>
    </Dialog>
  );
}

export function RejectDialog({ payout, onClose, onDone }: { payout: Payout; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, error, go } = useDecision(() => api.reject(payout.id, reason.trim()), onDone);
  return (
    <Dialog title="Reject payout" onClose={onClose} busy={busy}>
      <div style={{ padding: '16px 16px 4px' }}>
        <div style={{ fontSize: 12, color: 'var(--t2)', lineHeight: 1.55 }}>
          <span className="mono" style={{ color: 'var(--t1)' }}>{money(payout.amount)} {payout.asset}</span> returns to {payout.merchant.name}'s available balance.
        </div>
        <label style={{ display: 'grid', gap: 6, marginTop: 14 }}>
          <span className="eyebrow">Reason — the merchant sees this</span>
          <textarea className="field" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. destination address failed screening" />
        </label>
      </div>
      <Footer error={error}>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-reject" onClick={go} disabled={busy || reason.trim() === ''}>{busy ? 'Rejecting…' : 'Reject payout'}</button>
      </Footer>
    </Dialog>
  );
}

export function Footer({ error, children }: { error: string | null; children: ReactNode }) {
  return (
    <div style={{ padding: '12px 16px 16px' }}>
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--err)', marginBottom: 10 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{children}</div>
    </div>
  );
}
