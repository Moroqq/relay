import { useCallback, useEffect, useState } from 'react';

import { api, type Operator, type Summary } from './api.ts';
import { PayoutsPage } from './PayoutsPage.tsx';
import { AuditPage } from './AuditPage.tsx';
import { RequestsPage } from './RequestsPage.tsx';

type Page = 'payouts' | 'requests' | 'audit';

const pageFromHash = (): Page => {
  const hash = window.location.hash;
  return hash === '#/audit' ? 'audit' : hash === '#/requests' ? 'requests' : 'payouts';
};

export function Shell({ operator, network, onSignOut }: { operator: Operator; network: string; onSignOut: () => void }) {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Stable, so pages that call it after every load do not reload because of it.
  const refreshSummary = useCallback(() => { void api.summary().then(setSummary, () => undefined); }, []);

  const live = network === 'mainnet';
  const canDecide = operator.role === 'admin' || operator.role === 'operator';

  const navItem = (key: Page, label: string, abbr: string, count?: number) => {
    const active = page === key;
    return (
      <a
        href={'#/' + key}
        title={label}
        className="nav-item"
        aria-current={active ? 'page' : undefined}
        style={{
          display: 'flex', alignItems: 'center', padding: '5px 14px', fontSize: 12.5,
          color: active ? 'var(--t1)' : 'var(--t2)', background: active ? 'var(--raised)' : 'transparent',
          boxShadow: active ? 'inset 2px 0 0 var(--accent)' : 'none',
        }}
      >
        <span className="lbl">{label}</span>
        <span className="abbr">{abbr}</span>
        {count !== undefined && count > 0 && (
          <span className="mono lbl" style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--warn)' }}>{count}</span>
        )}
      </a>
    );
  };

  return (
    <div style={{ display: 'flex', height: '100vh', minHeight: 560, overflow: 'hidden' }}>
      <nav className="sb" style={{ width: 208, flex: '0 0 208px', background: 'var(--chrome)', borderRight: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 50, flex: '0 0 50px', display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', borderBottom: '1px solid var(--line-soft)' }}>
          <div style={{ width: 14, height: 14, borderRadius: 3, background: 'linear-gradient(180deg,#8C8FF5,#5B5FD6)', flex: '0 0 14px' }} />
          <div className="lbl" style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>Relay</div>
          {/* Testnet or real money, on every page, in the corner the eye passes on the way to Approve. */}
          <div
            className="mono lbl"
            title={live ? 'TRON mainnet — real funds' : 'TRON ' + network + ' — test funds'}
            style={{
              marginLeft: 'auto', fontSize: 9, letterSpacing: '0.1em', padding: '1px 4px', borderRadius: 3,
              color: live ? 'var(--ok)' : 'var(--warn)',
              border: '1px solid ' + (live ? 'rgba(95,163,119,0.32)' : 'rgba(196,145,59,0.35)'),
            }}
          >
            {live ? 'LIVE' : network.toUpperCase()}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 0 8px' }}>
          <div className="eyebrow lbl" style={{ padding: '0 14px 6px', color: 'var(--t4)', fontWeight: 500 }}>Treasury</div>
          {navItem('payouts', 'Payouts', 'PO', summary?.counts.requested)}
          {navItem('requests', 'Applications', 'AP', summary?.requests_new)}
          {navItem('audit', 'Audit log', 'AU')}
        </div>

        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--line-soft)' }}>
          <div className="eyebrow lbl" style={{ color: 'var(--t4)', marginBottom: 5 }}>{operator.role}</div>
          <div className="lbl" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{operator.name}</div>
          <div className="lbl mono" style={{ fontSize: 10.5, color: 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{operator.email}</div>
          <button className="btn" onClick={onSignOut} style={{ marginTop: 10, width: '100%', justifyContent: 'center' }} title="Sign out">
            <span className="lbl">Sign out</span><span className="abbr">⎋</span>
          </button>
        </div>
      </nav>

      <main style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        {page === 'payouts' && <PayoutsPage canDecide={canDecide} network={network} onSummary={setSummary} />}
        {page === 'requests' && <RequestsPage canDecide={canDecide} onChange={refreshSummary} />}
        {page === 'audit' && <AuditPage />}
      </main>
    </div>
  );
}
