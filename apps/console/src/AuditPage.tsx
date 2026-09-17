import { useCallback, useEffect, useState } from 'react';

import { api, type AuditEntry } from './api.ts';
import { fromUnits, shortAddress, timestamp } from './format.ts';

const ACTIONS: Record<string, { label: string; color: string }> = {
  'payout.approved': { label: 'Approved payout', color: 'var(--ok)' },
  'payout.rejected': { label: 'Rejected payout', color: 'var(--err)' },
  'login.succeeded': { label: 'Signed in', color: 'var(--t2)' },
  'login.failed': { label: 'Sign-in failed', color: 'var(--warn)' },
  'login.refused': { label: 'Sign-in refused', color: 'var(--warn)' },
};

const REASONS: Record<string, string> = {
  unknown_email: 'unknown email', password: 'wrong password', code: 'wrong code',
  code_replayed: 'code already used', locked: 'account locked', disabled: 'account disabled',
  totp_unreadable: 'code key unreadable with this server key',
};

const GRID = '160px 150px 160px minmax(0,1fr) 120px';

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** One line of what happened, in words rather than JSON. */
function describe(entry: AuditEntry): string {
  const d = entry.detail ?? {};
  const reason = text(d['reason']);
  switch (entry.action) {
    case 'payout.approved': {
      const net = text(d['net']);
      const to = text(d['to']);
      return (net ? fromUnits(net) : '') + (to ? ' to ' + shortAddress(to) : '');
    }
    case 'payout.rejected': {
      const amount = text(d['amount']);
      return (amount ? fromUnits(amount) : '') + (reason ? ' · “' + reason + '”' : '');
    }
    case 'login.failed':
    case 'login.refused':
      return reason ? REASONS[reason] ?? reason : '';
    default:
      return Object.keys(d).length === 0 ? '' : JSON.stringify(d);
  }
}

export function AuditLine({ entry, compact = false }: { entry: AuditEntry; compact?: boolean }) {
  const action = ACTIONS[entry.action] ?? { label: entry.action, color: 'var(--t2)' };
  const detail = describe(entry);

  if (compact) {
    return (
      <div style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
        <span className="dot" style={{ background: action.color, marginTop: 5 }} />
        <div style={{ minWidth: 0, fontSize: 12 }}>
          <div>{action.label} <span style={{ color: 'var(--t3)' }}>by {entry.operator ?? 'unknown'}</span></div>
          {detail && <div style={{ color: 'var(--t2)', marginTop: 2, wordBreak: 'break-word' }}>{detail}</div>}
          <div className="mono" style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: 3 }}>{timestamp(entry.at)}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'baseline', padding: '10px 8px', borderBottom: '1px solid var(--line-soft)', fontSize: 12 }}>
      <div className="mono" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{timestamp(entry.at)}</div>
      <div style={{ color: entry.operator ? 'var(--t1)' : 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.operator ?? 'unknown'}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: action.color }}>
        <span className="dot" style={{ background: action.color }} />{action.label}
      </div>
      <div style={{ color: 'var(--t2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={detail}>
        {entry.subject && (
          <span className="mono" style={{ color: 'var(--t3)', marginRight: 8 }} title={entry.subject.id}>{shortAddress(entry.subject.id, 8, 4)}</span>
        )}
        {detail}
      </div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--t3)', textAlign: 'right' }}>{entry.ip ?? ''}</div>
    </div>
  );
}

type Filter = 'all' | 'payout' | 'login';

const FILTERS: [Filter, string][] = [['all', 'All'], ['payout', 'Decisions'], ['login', 'Sign-ins']];

export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries((await api.audit()).data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the audit log');
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(poll);
  }, [load]);

  const shown = entries?.filter((e) => filter === 'all' || e.action.startsWith(filter + '.')) ?? null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, padding: '22px 24px 16px', borderBottom: '1px solid var(--line)' }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.015em' }}>Audit log</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>
            Every sign-in and every decision, newest first. Entries cannot be edited or removed.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {error && <span style={{ fontSize: 11.5, color: 'var(--err)' }}>{error}</span>}
          <button className="btn" onClick={() => void load()}>Refresh</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, padding: '14px 24px 4px' }}>
        {FILTERS.map(([key, label]) => (
          <button key={key} className="btn" aria-pressed={filter === key} onClick={() => setFilter(key)}
            style={filter === key ? { color: 'var(--t1)', background: 'var(--raised)', borderColor: 'var(--line-strong)' } : { color: 'var(--t3)' }}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ padding: '0 24px 32px', overflowX: 'auto' }}>
        <div style={{ minWidth: 860 }}>
          <div className="eyebrow" style={{ display: 'grid', gridTemplateColumns: GRID, padding: '14px 8px 7px', borderBottom: '1px solid var(--line)', letterSpacing: '0.11em' }}>
            <div>Time</div><div>Operator</div><div>Action</div><div>Detail</div><div style={{ textAlign: 'right' }}>IP</div>
          </div>
          {shown === null && <div style={{ padding: '20px 8px', fontSize: 12, color: 'var(--t3)' }}>Loading…</div>}
          {shown !== null && shown.length === 0 && <div style={{ padding: '28px 8px', fontSize: 12.5, color: 'var(--t3)' }}>Nothing recorded yet.</div>}
          {shown?.map((entry) => <AuditLine key={entry.id} entry={entry} />)}
          {entries !== null && entries.length >= 50 && (
            <div style={{ padding: '14px 8px', fontSize: 11.5, color: 'var(--t4)' }}>Showing the latest 50 entries.</div>
          )}
        </div>
      </div>
    </div>
  );
}
