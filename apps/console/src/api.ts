/**
 * Talking to the console server.
 *
 * Same origin, so the session cookie travels on its own. Every request carries
 * the x-relay-console header the server requires on anything that changes
 * state; sending it on reads too keeps one code path.
 */

export type Role = 'admin' | 'operator' | 'viewer';

export interface Operator {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export type PayoutTab = 'requested' | 'approved' | 'in_flight' | 'completed' | 'failed' | 'rejected' | 'all';

export interface Payout {
  id: string;
  state: 'requested' | 'approved' | 'signed' | 'broadcast' | 'completed' | 'rejected' | 'failed';
  merchant: { id: string; name: string };
  project: { id: string; name: string };
  asset: 'USDT' | 'TRX';
  amount: string;
  fee_amount: string;
  net_amount: string;
  to_address: string;
  from_address: string | null;
  external_ref: string | null;
  tx_hash: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_reason: string | null;
  error: string | null;
  attempt: number;
  created_at: string;
  completed_at: string | null;
}

export interface Summary {
  counts: Record<PayoutTab, number>;
  awaiting_approval: string;
  approved_unsent: string;
  hot_wallet: { usdt: string; trx: string };
  treasury: { usdt: string };
  merchants_owed: string;
  hot_wallet_short: boolean;
  /** Whether the service that signs and sends is running and unlocked. */
  sweeper: {
    state: 'locked' | 'unlocked' | 'unknown';
    since: string | null;
    reported_at: string | null;
    stale: boolean;
    payouts: 'live' | 'dry_run' | null;
    sweeps: 'live' | 'dry_run' | null;
  };
}

export interface AuditEntry {
  id: string;
  at: string;
  operator: string | null;
  action: string;
  subject: { type: string; id: string } | null;
  detail: Record<string, unknown>;
  ip: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Called when the server says the session is gone, so the app can show sign-in. */
let onSignedOut: () => void = () => {};
export function whenSignedOut(handler: () => void): void {
  onSignedOut = handler;
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-relay-console': '1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // An empty or non-JSON body; the status alone decides below.
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    if (response.status === 401 && path !== '/admin/api/login') onSignedOut();
    throw new ApiError(response.status, error?.code ?? 'error', error?.message ?? 'Request failed (' + response.status + ')');
  }
  return payload as T;
}

export const api = {
  me: () => request<{ operator: Operator; network: string }>('GET', '/admin/api/me'),
  login: (email: string, password: string, code: string) =>
    request<{ operator: Operator }>('POST', '/admin/api/login', { email, password, code }),
  logout: () => request<{ ok: true }>('POST', '/admin/api/logout', {}),
  summary: () => request<Summary>('GET', '/admin/api/summary'),
  payouts: (tab: PayoutTab) => request<{ data: Payout[] }>('GET', '/admin/api/payouts?tab=' + tab),
  approve: (id: string) => request<{ ok: true; state: string }>('POST', '/admin/api/payouts/' + encodeURIComponent(id) + '/approve', {}),
  reject: (id: string, reason: string) =>
    request<{ ok: true; state: string }>('POST', '/admin/api/payouts/' + encodeURIComponent(id) + '/reject', { reason }),
  audit: (subject?: string) =>
    request<{ data: AuditEntry[] }>('GET', '/admin/api/audit' + (subject ? '?subject=' + encodeURIComponent(subject) : '')),
};
