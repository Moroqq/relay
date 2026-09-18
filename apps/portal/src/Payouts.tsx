import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { api, type Payout, type Project } from './api.ts';
import { Dialog, Footer, Row, useDecision } from './Dialog.tsx';
import { age, explorerUrl, money, shortAddress, STATE } from './format.ts';
import { Empty, PageHead, Section } from './ui.tsx';

const GRID = 'minmax(0,1fr) 130px 150px 150px 70px';

/** A TRON address, checked for shape before the server checks it properly. */
const looksLikeAddress = (a: string) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a.trim());

export function Payouts({ project, network, onChange }: { project: Project; network: string; onChange: () => void }) {
  const [rows, setRows] = useState<Payout[] | null>(null);
  const [asset, setAsset] = useState<'USDT' | 'TRX'>('USDT');
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows((await api.payouts(project.id)).data);
    } catch {
      setRows([]);
    }
  }, [project.id]);

  useEffect(() => {
    setRows(null);
    void load();
    const poll = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(poll);
  }, [load]);

  const available = asset === 'USDT' ? project.balance.usdt.available : project.balance.trx.available;
  const ready = Number(amount) > 0 && looksLikeAddress(to);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) setConfirming(true);
  };

  return (
    <div>
      <PageHead title="Payouts" sub="Withdraw your balance to a TRON address. Every payout is reviewed by Relay before it is sent." />

      <Section title="New payout">
        <form onSubmit={submit} style={{ display: 'grid', gap: 12, maxWidth: 560, paddingTop: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 6, flex: '1 1 180px' }}>
              <span className="eyebrow">Amount</span>
              <input className="field mono" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} />
            </label>
            <label style={{ display: 'grid', gap: 6, flex: '0 0 110px' }}>
              <span className="eyebrow">Asset</span>
              <select className="field" value={asset} onChange={(e) => setAsset(e.target.value as 'USDT' | 'TRX')}>
                <option value="USDT">USDT</option>
                <option value="TRX">TRX</option>
              </select>
            </label>
            <button type="button" className="btn" onClick={() => setAmount(available)} style={{ height: 32 }}>All: {money(available)}</button>
          </div>
          <label style={{ display: 'grid', gap: 6 }}>
            <span className="eyebrow">To TRON address</span>
            <input className="field mono" placeholder="T…" spellCheck={false} value={to} onChange={(e) => setTo(e.target.value.trim())} />
            {to !== '' && !looksLikeAddress(to) && <span style={{ fontSize: 11.5, color: 'var(--warn)' }}>That does not look like a TRON address.</span>}
          </label>
          <div><button type="submit" className="btn btn-primary" disabled={!ready}>Review payout</button></div>
        </form>
      </Section>

      <Section title="History">
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 700 }}>
            <div className="eyebrow" style={{ display: 'grid', gridTemplateColumns: GRID, padding: '10px 8px 7px', letterSpacing: '0.11em' }}>
              <div>To</div><div style={{ textAlign: 'right' }}>Amount</div><div style={{ textAlign: 'right' }}>You receive</div><div style={{ paddingLeft: 18 }}>State</div><div style={{ textAlign: 'right' }}>Age</div>
            </div>
            {rows === null && <Empty>Loading…</Empty>}
            {rows !== null && rows.length === 0 && <Empty>No payouts yet.</Empty>}
            {rows?.map((p) => {
              const st = STATE[p.state] ?? { label: p.state, color: 'var(--t3)' };
              return (
                <div key={p.id} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', padding: '10px 8px', borderTop: '1px solid var(--line-soft)', fontSize: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="mono" style={{ fontSize: 11.5, color: 'var(--t2)' }} title={p.to_address}>{shortAddress(p.to_address, 10, 6)}</div>
                    {p.tx_hash && <a className="mono" href={explorerUrl(network, p.tx_hash)} target="_blank" rel="noreferrer noopener" style={{ fontSize: 10.5, color: 'var(--info)' }}>transaction ↗</a>}
                    {p.rejected_reason && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{p.rejected_reason}</div>}
                  </div>
                  <div style={{ textAlign: 'right' }}><span className="mono">{money(p.amount)}</span> <span className="mono" style={{ fontSize: 10, color: 'var(--t3)' }}>{p.asset}</span></div>
                  <div className="mono" style={{ textAlign: 'right' }}>{money(p.net_amount)}</div>
                  <div style={{ paddingLeft: 18, display: 'flex', alignItems: 'center', gap: 7, color: st.color }}><span className="dot" style={{ background: st.color }} />{st.label}</div>
                  <div className="mono" style={{ textAlign: 'right', fontSize: 11.5, color: 'var(--t3)' }}>{age(p.created_at)}</div>
                </div>
              );
            })}
          </div>
        </div>
      </Section>

      {confirming && (
        <ConfirmPayout
          projectId={project.id} amount={amount} asset={asset} to={to} network={network}
          onClose={() => setConfirming(false)}
          onDone={() => { setConfirming(false); setAmount(''); setTo(''); onChange(); void load(); }}
        />
      )}
    </div>
  );
}

function ConfirmPayout({ projectId, amount, asset, to, network, onClose, onDone }: {
  projectId: string; amount: string; asset: 'USDT' | 'TRX'; to: string; network: string; onClose: () => void; onDone: () => void;
}) {
  const { busy, error, go } = useDecision(() => api.requestPayout(projectId, amount, asset, to), onDone);
  const live = network === 'mainnet';
  return (
    <Dialog title="Request payout" onClose={onClose} busy={busy}>
      <div style={{ padding: '16px 16px 4px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="mono" style={{ fontSize: 24, fontWeight: 500 }}>{money(amount)}</span>
          <span style={{ fontSize: 12, color: 'var(--t3)' }}>{asset}</span>
        </div>
        <div style={{ marginTop: 12 }}>
          <Row k="To"><span className="mono">{to}</span></Row>
          <Row k="Network"><span className="mono" style={{ color: live ? 'var(--ok)' : 'var(--warn)' }}>{live ? 'TRON mainnet — real funds' : 'TRON ' + network + ' — test funds'}</span></Row>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--t2)', lineHeight: 1.55, margin: '12px 0 4px' }}>
          Check the address. Once sent, a transfer on TRON cannot be reversed. Relay reviews the request before sending.
        </div>
      </div>
      <Footer error={error}>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={go} disabled={busy}>{busy ? 'Requesting…' : 'Request payout'}</button>
      </Footer>
    </Dialog>
  );
}

