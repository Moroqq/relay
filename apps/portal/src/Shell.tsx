import { useCallback, useEffect, useState } from 'react';

import { api, type Me, type Project } from './api.ts';
import { Keys } from './Keys.tsx';
import { Overview } from './Overview.tsx';
import { Payouts } from './Payouts.tsx';
import { Webhooks } from './Webhooks.tsx';

type Page = 'overview' | 'payouts' | 'keys' | 'webhooks';
const PAGES: [Page, string, string][] = [['overview', 'Overview', 'OV'], ['payouts', 'Payouts', 'PO'], ['keys', 'API keys', 'AK'], ['webhooks', 'Webhooks', 'WH']];

const pageFromHash = (): Page => {
  const found = PAGES.find(([key]) => location.hash === '#/' + key);
  return found ? found[0] : 'overview';
};

export function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.projects();
      setProjects(data);
      setProjectId((current) => current ?? data[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your projects');
    }
  }, []);

  useEffect(() => {
    void load();
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [load]);

  const live = me.network === 'mainnet';
  const project = projects?.find((p) => p.id === projectId) ?? null;

  return (
    <div style={{ display: 'flex', height: '100vh', minHeight: 560, overflow: 'hidden' }}>
      <nav className="sb" style={{ width: 208, flex: '0 0 208px', background: 'var(--chrome)', borderRight: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 50, flex: '0 0 50px', display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', borderBottom: '1px solid var(--line-soft)' }}>
          <img src="/app/relay-mark.webp" alt="" width={24} height={16} style={{ flex: '0 0 auto' }} />
          <div className="lbl" style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>Relay</div>
          <div className="mono lbl" title={live ? 'TRON mainnet: real funds' : 'TRON ' + me.network + ': test funds'}
            style={{ marginLeft: 'auto', fontSize: 9, letterSpacing: '0.1em', padding: '1px 4px', borderRadius: 3,
              color: live ? 'var(--ok)' : 'var(--warn)', border: '1px solid ' + (live ? 'rgba(95,163,119,0.32)' : 'rgba(196,145,59,0.35)') }}>
            {live ? 'LIVE' : me.network.toUpperCase()}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 0 8px' }}>
          <div className="eyebrow lbl" style={{ padding: '0 14px 6px', color: 'var(--t4)', fontWeight: 500 }}>{me.merchant.name}</div>
          {projects && projects.length > 1 && (
            <div className="lbl" style={{ padding: '0 14px 10px' }}>
              <select className="field" value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          {PAGES.map(([key, label, abbr]) => {
            const active = key === page;
            return (
              <a key={key} href={'#/' + key} title={label} className="nav-item" aria-current={active ? 'page' : undefined}
                style={{ display: 'flex', alignItems: 'center', padding: '5px 14px', fontSize: 12.5,
                  color: active ? 'var(--t1)' : 'var(--t2)', background: active ? 'var(--raised)' : 'transparent',
                  boxShadow: active ? 'inset 2px 0 0 var(--accent)' : 'none' }}>
                <span className="lbl">{label}</span><span className="abbr">{abbr}</span>
              </a>
            );
          })}
        </div>

        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--line-soft)' }}>
          <div className="lbl" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{me.user.name}</div>
          <div className="lbl mono" style={{ fontSize: 10.5, color: 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{me.user.email}</div>
          <button className="btn" onClick={onSignOut} style={{ marginTop: 10, width: '100%', justifyContent: 'center' }} title="Sign out">
            <span className="lbl">Sign out</span><span className="abbr">⎋</span>
          </button>
        </div>
      </nav>

      <main style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        {error && <div role="alert" style={{ padding: '22px 24px', fontSize: 12.5, color: 'var(--err)' }}>{error}</div>}
        {projects !== null && project === null && (
          <div style={{ padding: '22px 24px', fontSize: 12.5, color: 'var(--t3)' }}>No projects yet. Your Relay contact will set one up.</div>
        )}
        {project && page === 'overview' && <Overview project={project} network={me.network} />}
        {project && page === 'payouts' && <Payouts project={project} network={me.network} onChange={load} />}
        {project && page === 'keys' && <Keys project={project} live={live} />}
        {project && page === 'webhooks' && <Webhooks project={project} network={me.network} onChange={load} />}
      </main>
    </div>
  );
}

