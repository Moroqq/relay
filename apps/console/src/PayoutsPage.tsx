import { useCallback, useEffect, useState } from 'react';

import { api, type Payout, type PayoutTab, type Summary } from './api.ts';
import { age, money, shortAddress, STATE, timestamp } from './format.ts';
import { ApproveDialog, RejectDialog } from './Dialogs.tsx';
import { PayoutDrawer } from './PayoutDrawer.tsx';

const TABS: [PayoutTab, string][] = [
  ['requested', 'Awaiting approval'], ['approved', 'Approved'], ['in_flight', 'Sending'],
  ['completed', 'Completed'], ['failed', 'Failed'], ['rejected', 'Rejected'], ['all', 'All'],
];

const EMPTY: Record<PayoutTab, string> = {
  requested: 'Nothing is waiting for a decision.', approved: 'No approved payouts are waiting to be sent.',
  in_flight: 'Nothing is on its way right now.', completed: 'No payouts have completed yet.',
  failed: 'No failed payouts.', rejected: 'No rejected payouts.', all: 'No payouts yet.',
};

const GRID = '150px minmax(0,1fr) 128px 150px 64px 150px 150px';

type Decision = { kind: 'approve' | 'reject'; payout: Payout } | null;

export function PayoutsPage({ canDecide, network, onSummary }: { canDecide: boolean; network: string; onSummary: (s: Summary) => void }) {
  const [tab, setTab] = useState<PayoutTab>('requested');
  const [rows, setRows] = useState<Payout[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [selected, setSelected] = useState<Payout | null>(null);
  const [decision, setDecision] = useState<Decision>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try {
      const [list, s] = await Promise.all([api.payouts(tab), api.summary()]);
      setRows(list.data);
      setSummary(s);
      onSummary(s);
      setLoadError(null);
      setUpdatedAt(Date.now());
      // Keep an open drawer in step with what just changed underneath it.
      setSelected((current) => (current === null ? null : list.data.find((p) => p.id === current.id) ?? current));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load payouts');
    }
  }, [tab, onSummary]);

  useEffect(() => {
    setRows(null);
    void load();
    const poll = window.setInterval(() => void load(), 10_000);
    const clock = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => { window.clearInterval(poll); window.clearInterval(clock); };
  }, [load]);

  const decided = () => { setDecision(null); setSelected(null); void load(); };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', padding: '22px 24px 16px' }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.015em' }}>Payouts</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>
            Merchant withdrawals{canDecide ? '' : ' · view only'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 11.5, color: loadError ? 'var(--err)' : 'var(--t3)' }}>
            {loadError ?? (updatedAt === null ? 'Loading…' : 'Updated ' + age(new Date(updatedAt).toISOString()) + ' ago')}
          </span>
          <button className="btn" onClick={() => void load()}>Refresh</button>
        </div>
      </div>

      <SignerNotice summary={summary} />
      <Ribbon summary={summary} />

      <div style={{ display: 'flex', gap: 20, padding: '18px 24px 0', borderBottom: '1px solid var(--line)', overflowX: 'auto' }}>
        {TABS.map(([key, label]) => {
          const active = key === tab;
          const count = summary?.counts[key];
          return (
            <button key={key} onClick={() => setTab(key)} aria-pressed={active}
              style={{ padding: '0 0 9px', border: 0, background: 'none', cursor: 'pointer', fontSize: 12.5, whiteSpace: 'nowrap',
                color: active ? 'var(--t1)' : 'var(--t3)', boxShadow: active ? 'inset 0 -1px 0 var(--t1)' : 'none' }}>
              {label}{count ? <span className="mono" style={{ marginLeft: 6, fontSize: 10.5, color: key === 'requested' ? 'var(--warn)' : key === 'failed' ? 'var(--err)' : 'var(--t3)' }}>{count}</span> : null}
            </button>
          );
        })}
      </div>

      <div style={{ padding: '0 24px 32px', overflowX: 'auto' }}>
        <div style={{ minWidth: 1000 }}>
          <div className="eyebrow" style={{ display: 'grid', gridTemplateColumns: GRID, padding: '14px 8px 7px', borderBottom: '1px solid var(--line)', letterSpacing: '0.11em' }}>
            <div>Payout</div><div>Merchant</div><div style={{ textAlign: 'right' }}>Sends</div><div style={{ paddingLeft: 18 }}>To</div>
            <div style={{ textAlign: 'right' }}>Age</div><div style={{ paddingLeft: 18 }}>State</div><div />
          </div>

          {rows === null && <div style={{ padding: '20px 8px', fontSize: 12, color: 'var(--t3)' }}>Loading…</div>}
          {rows !== null && rows.length === 0 && <div style={{ padding: '28px 8px', fontSize: 12.5, color: 'var(--t3)' }}>{EMPTY[tab]}</div>}

          {rows?.map((p) => (
            <PayoutRow key={p.id} payout={p} grid={GRID} canDecide={canDecide}
              onOpen={() => setSelected(p)} onDecide={(kind) => setDecision({ kind, payout: p })} />
          ))}
        </div>
      </div>

      {selected && (
        <PayoutDrawer payout={selected} network={network} canDecide={canDecide} onClose={() => setSelected(null)}
          onDecide={(kind) => setDecision({ kind, payout: selected })} />
      )}
      {decision?.kind === 'approve' && <ApproveDialog payout={decision.payout} network={network} onClose={() => setDecision(null)} onDone={decided} />}
      {decision?.kind === 'reject' && <RejectDialog payout={decision.payout} onClose={() => setDecision(null)} onDone={decided} />}
    </div>
  );
}

/**
 * Why approved payouts might not be going out, said where the operator is
 * looking when they wonder. Nothing is shown when all is well.
 */
function SignerNotice({ summary }: { summary: Summary | null }) {
  const s = summary?.sweeper;
  if (!s) return null;

  let tone: string;
  let title: string;
  let body: string;
  if (s.state === 'unknown') {
    tone = 'var(--err)';
    title = 'The sweeper has never reported';
    body = 'Approved payouts are not sent and deposits are not swept until it is running.';
  } else if (s.stale) {
    tone = 'var(--err)';
    title = 'The sweeper stopped reporting ' + age(s.reported_at!) + ' ago';
    body = 'Approved payouts are not being sent. Check that it is running on the server.';
  } else if (s.state === 'locked') {
    tone = 'var(--warn)';
    title = 'Signing is locked · since ' + timestamp(s.since!).slice(11, 16);
    body = 'The keys are sealed after a restart. Approved payouts wait until someone unlocks them on the server with npm run keys:unlock.';
  } else if (s.payouts === 'dry_run') {
    tone = 'var(--info)';
    title = 'Payouts are in test mode';
    body = 'Approved payouts are signed but not sent. Sending is switched on in the server settings (PAYOUT_BROADCAST).';
  } else {
    return null;
  }

  return (
    <div role="status" style={{ display: 'flex', gap: 10, alignItems: 'baseline', margin: '0 24px 16px', padding: '10px 12px', background: 'var(--raised)', border: '1px solid var(--line)', borderLeft: '2px solid ' + tone, borderRadius: 'var(--radius)' }}>
      <span className="dot" style={{ background: tone, flex: '0 0 auto', transform: 'translateY(-1px)' }} />
      <div style={{ fontSize: 12, lineHeight: 1.5 }}>
        <span style={{ color: 'var(--t1)', fontWeight: 500 }}>{title}.</span>{' '}
        <span style={{ color: 'var(--t2)' }}>{body}</span>
      </div>
    </div>
  );
}

function Ribbon({ summary }: { summary: Summary | null }) {
  const cells: { label: string; value: string | null; unit: string; note: string; tone?: string }[] = [
    { label: 'Awaiting approval', value: summary && money(summary.awaiting_approval), unit: 'USDT',
      note: summary ? summary.counts.requested + ' requests' : '', tone: summary && summary.counts.requested > 0 ? 'var(--warn)' : undefined },
    { label: 'Approved, not sent', value: summary && money(summary.approved_unsent), unit: 'USDT', note: summary ? summary.counts.approved + ' queued' : '' },
    { label: 'Hot wallet', value: summary && money(summary.hot_wallet.usdt), unit: 'USDT',
      note: summary ? (summary.hot_wallet_short ? 'Short of approved payouts · ' : '') + money(summary.hot_wallet.trx) + ' TRX for fees' : '',
      tone: summary?.hot_wallet_short ? 'var(--err)' : undefined },
    { label: 'Treasury', value: summary && money(summary.treasury.usdt), unit: 'USDT', note: 'Swept deposits' },
    { label: 'Owed to merchants', value: summary && money(summary.merchants_owed), unit: 'USDT', note: 'Ledger balance' },
  ];
  return (
    // Every cell draws its own left and top rule; the outer box clips the ones
    // that land on its edge, so wrapped rows get dividers without stray lines.
    <div style={{ overflow: 'hidden', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', background: 'var(--chrome)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', margin: '-1px 0 0 -1px' }}>
      {cells.map((c) => (
        <div key={c.label} style={{ flex: '1 1 190px', padding: '14px 20px', borderLeft: '1px solid var(--line-soft)', borderTop: '1px solid var(--line-soft)' }}>
          <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {c.tone && <span className="dot" style={{ background: c.tone }} />}{c.label}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 7 }}>
            <span className="mono" style={{ fontSize: 21, fontWeight: 500, letterSpacing: '-0.02em', color: c.value === null ? 'var(--t4)' : 'var(--t1)' }}>{c.value ?? '—'}</span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--t3)' }}>{c.unit}</span>
          </div>
          <div style={{ fontSize: 11, marginTop: 4, color: c.tone === 'var(--err)' ? 'var(--err)' : 'var(--t3)', minHeight: 14 }}>{c.note}</div>
        </div>
      ))}
      </div>
    </div>
  );
}

function PayoutRow({ payout: p, grid, canDecide, onOpen, onDecide }: {
  payout: Payout; grid: string; canDecide: boolean; onOpen: () => void; onDecide: (kind: 'approve' | 'reject') => void;
}) {
  const state = STATE[p.state] ?? { label: p.state, color: 'var(--t3)' };
  const decidable = canDecide && p.state === 'requested';
  return (
    <div className="prow" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      style={{ display: 'grid', gridTemplateColumns: grid, alignItems: 'center', padding: '11px 8px', borderBottom: '1px solid var(--line-soft)', cursor: 'pointer' }}>
      <div className="mono" style={{ fontSize: 11.5, color: 'var(--t2)' }}>{shortAddress(p.id, 8, 4)}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.merchant.name}</div>
        <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {p.project.name}{p.external_ref ? ' · ' + p.external_ref : ''}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <span className="mono" style={{ fontSize: 12.5 }}>{money(p.net_amount)}</span>
        <span className="mono" style={{ fontSize: 10, color: 'var(--t3)', marginLeft: 5 }}>{p.asset}</span>
      </div>
      <div className="mono" style={{ paddingLeft: 18, fontSize: 11.5, color: 'var(--t2)' }} title={p.to_address}>{shortAddress(p.to_address)}</div>
      <div className="mono" style={{ textAlign: 'right', fontSize: 11.5, color: 'var(--t3)' }}>{age(p.created_at)}</div>
      <div style={{ paddingLeft: 18, display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: state.color }}>
        <span className="dot" style={{ background: state.color }} />{state.label}
        {p.attempt > 1 && p.state !== 'completed' && <span className="mono" style={{ fontSize: 10, color: 'var(--t3)' }}>try {p.attempt}</span>}
      </div>
      <div className="row-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        {decidable && (
          <>
            <button className="btn btn-reject" onClick={(e) => { e.stopPropagation(); onDecide('reject'); }}>Reject</button>
            <button className="btn btn-approve" onClick={(e) => { e.stopPropagation(); onDecide('approve'); }}>Approve</button>
          </>
        )}
      </div>
    </div>
  );
}
