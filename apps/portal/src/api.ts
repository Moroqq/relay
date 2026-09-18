/**
 * Talking to the portal server. Same origin, so the session cookie travels on
 * its own; every request carries the header the server requires on changes.
 */

export interface Me {
  user: { id: string; email: string; name: string };
  merchant: { id: string; name: string };
  network: string;
}

export interface Balance { available: string; reserved: string; owed: string }

export interface Project {
  id: string;
  name: string;
  status: string;
  fee_percent: string;
  webhook_url: string | null;
  has_webhook_secret: boolean;
  balance: { usdt: Balance; trx: Balance };
}

export interface Deposit {
  id: string;
  user: string;
  asset: 'USDT' | 'TRX';
  amount: string;
  credited: string | null;
  state: string;
  confirmations: number;
  required_confirmations: number;
  tx_hash: string;
  detected_at: string;
}

export interface Payout {
  id: string;
  state: 'requested' | 'approved' | 'signed' | 'broadcast' | 'completed' | 'rejected' | 'failed';
  asset: 'USDT' | 'TRX';
  amount: string;
  fee_amount: string;
  net_amount: string;
  to_address: string;
  tx_hash: string | null;
  rejected_reason: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
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

let onSignedOut: () => void = () => {};
export function whenSignedOut(handler: () => void): void {
  onSignedOut = handler;
}

const PUBLIC = ['/portal/api/login', '/portal/api/invite/inspect', '/portal/api/invite/start', '/portal/api/invite/complete'];

async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'x-relay-portal': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Empty or not JSON; the status decides below.
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    if (response.status === 401 && !PUBLIC.includes(path)) onSignedOut();
    throw new ApiError(response.status, error?.code ?? 'error', error?.message ?? 'Request failed (' + response.status + ')');
  }
  return payload as T;
}

const project = (id: string) => '/portal/api/projects/' + encodeURIComponent(id);

export const api = {
  me: () => request<Me>('GET', '/portal/api/me'),
  login: (email: string, password: string, code: string) => request<Me>('POST', '/portal/api/login', { email, password, code }),
  logout: () => request<{ ok: true }>('POST', '/portal/api/logout', {}),

  inspectInvite: (token: string) => request<{ email: string; name: string; company: string; expires_at: string }>('POST', '/portal/api/invite/inspect', { token }),
  startInvite: (token: string) => request<{ secret: string; otpauth: string }>('POST', '/portal/api/invite/start', { token }),
  completeInvite: (token: string, password: string, code: string) => request<Me>('POST', '/portal/api/invite/complete', { token, password, code }),

  projects: () => request<{ data: Project[] }>('GET', '/portal/api/projects'),
  deposits: (id: string) => request<{ data: Deposit[] }>('GET', project(id) + '/deposits'),
  payouts: (id: string) => request<{ data: Payout[] }>('GET', project(id) + '/payouts'),
  requestPayout: (id: string, amount: string, asset: 'USDT' | 'TRX', toAddress: string) =>
    request<Payout>('POST', project(id) + '/payouts', { amount, asset, to_address: toAddress }),
  keys: (id: string) => request<{ data: ApiKey[] }>('GET', project(id) + '/keys'),
  createKey: (id: string, label: string) => request<{ id: string; prefix: string; secret: string; label: string }>('POST', project(id) + '/keys', { label }),
  revokeKey: (id: string, keyId: string) => request<{ ok: true }>('POST', project(id) + '/keys/' + encodeURIComponent(keyId) + '/revoke', {}),
  setWebhook: (id: string, url: string) => request<{ ok: true; webhook_url: string | null }>('PUT', project(id) + '/webhook', { url }),
  rotateWebhookSecret: (id: string) => request<{ secret: string }>('POST', project(id) + '/webhook/secret', {}),
};
