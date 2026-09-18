import { useEffect, useState } from 'react';

import { api, type Deposit, type Project } from './api.ts';
import { age, explorerUrl, money, shortAddress } from './format.ts';
import { Empty, PageHead, Section } from './ui.tsx';

const DEPOSIT_STATE: Record<string, { label: string; color: string }> = {
  detected: { label: 'Confirming', color: 'var(--info)' },
  confirming: { label: 'Confirming', color: 'var(--info)' },
  credited: { label: 'Credited', color: 'var(--ok)' },
  failed: { label: 'Failed', color: 'var(--err)' },
};

const GRID = '150px minmax(0,1fr) 130px 130px 120px 70px';

export function Overview({ project, network }: { project: Project; network: string }) {
  const [deposits, setDeposits] = useState<Deposit[] | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => api.deposits(project.id).then((r) => { if (live) setDeposits(r.data); }, () => { if (live) setDeposits([]); });
    setDeposits(null);
    void load();
    const poll = window.setInterval(load, 15_000);
    return () => { live = false; window.clearInterval(poll); };
  }, [project.id]);

  const cells = [
    { label: 'Available', value: money(project.balance.usdt.available), unit: 'USDT', note: 'Can be withdrawn now' },
    { label: 'In payouts', value: money(project.balance.usdt.reserved), unit: 'USDT', note: 'Requested, not yet sent' },
    { label: 'Available', value: money(project.balance.trx.available), unit: 'TRX', note: 'Top-ups in TRX' },
    { label: 'Relay fee', value: project.fee_percent, unit: '%', note: 'Taken from each top-up' },
  ];

  return (
    <div>
      <PageHead title={project.name} sub="Balance and recent top-ups" />
      <div style={{ display: 'flex', flexWrap: 'wrap', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', background: 'var(--chrome)' }}>
        {cells.map((c, i) => (
          <div key={c.label + c.unit} style={{ flex: '1 1 190px', padding: '14px 20px', borderLeft: i === 0 ? 'none' : '1px solid var(--line-soft)' }}>
            <div className="eyebrow">{c.label}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 7 }}>
              <span className="mono" style={{ fontSize: 21, fontWeight: 500, letterSpacing: '-0.02em' }}>{c.value}</span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--t3)' }}>{c.unit}</span>
            </div>
            <div style={{ fontSize: 11, marginTop: 4, color: 'var(--t3)' }}>{c.note}</div>
          </div>
        ))}
      </div>

      <Section title="Recent top-ups">
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 760 }}>
            <div className="eyebrow" style={{ display: 'grid', gridTemplateColumns: GRID, padding: '10px 8px 7px', letterSpacing: '0.11em' }}>
              <div>User</div><div>Transaction</div><div style={{ textAlign: 'right' }}>Received</div><div style={{ textAlign: 'right' }}>Credited</div><div style={{ paddingLeft: 18 }}>State</div><div style={{ textAlign: 'right' }}>Age</div>
            </div>
            {deposits === null && <Empty>Loading…</Empty>}
            {deposits !== null && deposits.length === 0 && <Empty>No top-ups yet. They appear here as soon as the network sees them.</Empty>}
            {deposits?.map((d) => {
              const st = DEPOSIT_STATE[d.state] ?? { label: d.state, color: 'var(--t3)' };
              return (
                <div key={d.id} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', padding: '10px 8px', borderTop: '1px solid var(--line-soft)', fontSize: 12 }}>
                  <div className="mono" style={{ fontSize: 11.5, color: 'var(--t2)' }}>{shortAddress(d.user, 8, 4)}</div>
                  <a className="mono" href={explorerUrl(network, d.tx_hash)} target="_blank" rel="noreferrer noopener" style={{ fontSize: 11.5, color: 'var(--info)' }}>{shortAddress(d.tx_hash, 10, 6)}</a>
                  <div style={{ textAlign: 'right' }}><span className="mono">{money(d.amount)}</span> <span className="mono" style={{ fontSize: 10, color: 'var(--t3)' }}>{d.asset}</span></div>
                  <div className="mono" style={{ textAlign: 'right', color: d.credited ? 'var(--t1)' : 'var(--t4)' }}>{d.credited ? money(d.credited) : '—'}</div>
                  <div style={{ paddingLeft: 18, display: 'flex', alignItems: 'center', gap: 7, color: st.color }}>
                    <span className="dot" style={{ background: st.color }} />{st.label}
                    {(d.state === 'detected' || d.state === 'confirming') && <span className="mono" style={{ fontSize: 10, color: 'var(--t3)' }}>{d.confirmations}/{d.required_confirmations}</span>}
                  </div>
                  <div className="mono" style={{ textAlign: 'right', fontSize: 11.5, color: 'var(--t3)' }}>{age(d.detected_at)}</div>
                </div>
              );
            })}
          </div>
        </div>
      </Section>
    </div>
  );
}
