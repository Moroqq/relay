import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ApiError } from './api.ts';

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

export function Footer({ error, children }: { error: string | null; children: ReactNode }) {
  return (
    <div style={{ padding: '12px 16px 16px' }}>
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--err)', marginBottom: 10 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{children}</div>
    </div>
  );
}
