/**
 * Everything the page says, in one place. Copy is from the design handoff
 * (Relay Landing.dc.html).
 *
 * Several items are still demo content and must be replaced or removed before
 * the site is public — they are marked DEMO below. A payments company showing
 * invented partners or invented prices is making claims it cannot back.
 */

/**
 * DEMO pricing from the design file: 0.5% + 1.10 USDT for Relay, 2.9% + 0.30
 * for cards. Real project fees are set per merchant (fee_rate_bps) and there
 * is no flat part yet — confirm the numbers before publishing.
 */
export const PRICING = {
  relayRate: 0.005,
  relayFlat: 1.1,
  cardRate: 0.029,
  cardFlat: 0.3,
};

export const PRESETS = [100, 1_000, 10_000, 100_000];
export const DEFAULT_AMOUNT = 10_000;

export const NAV = [
  { href: '#product', label: 'Product' },
  { href: '#infrastructure', label: 'Infrastructure' },
  { href: '#developers', label: 'Developers' },
  { href: '#company', label: 'Company' },
  { href: '#status', label: 'Status' },
];

/** DEMO: placeholder names from the design file. */
export const PARTNERS = ['Forum A', 'Marketplace B', 'Gaming Corp', 'Digital Store', 'Community Hub'] as const;

export type Tone = 'ok' | 'warn' | 'err';

/** DEMO: a static feed. The real one would come from public, anonymised events. */
export const ACTIVITY: { label: string; value: string; tone: Tone }[] = [
  { label: 'Payment completed', value: '250.00 USDT', tone: 'ok' },
  { label: 'TX detected', value: '250.00 USDT', tone: 'ok' },
  { label: 'Payment created', value: 'Forum A', tone: 'err' },
  { label: 'Webhook delivered', value: 'HTTP 200', tone: 'err' },
];

export const FLOW = [
  { step: 'YOUR PLATFORM', label: 'Checkout', meta: 'order created' },
  { step: 'RELAY API', label: 'POST /v1/payments', meta: '201 · 84 ms' },
  { step: 'PAYMENT', label: 'Address assigned', meta: 'expires 15 min' },
  { step: 'TRON', label: 'Transfer detected', meta: 'block 76,842,291' },
  { step: 'CONFIRMATION', label: '20 / 20', meta: '2 min 14 sec' },
  { step: 'WEBHOOK', label: 'payment.completed', meta: 'HTTP 200 · 182 ms' },
  { step: 'YOUR PLATFORM', label: 'Balance credited', meta: '—' },
];

export const TRACE: { step: string; value: string; ok: boolean; time: string }[] = [
  { step: 'API REQUEST', value: 'POST /v1/payments · 201', ok: true, time: '+84 ms' },
  { step: 'PAYMENT CREATED', value: 'PAY_9C4D18', ok: true, time: '20:39:04' },
  { step: 'TX DETECTED', value: 'a71b93…19c4', ok: true, time: '+22.6 sec' },
  { step: 'CONFIRMATIONS', value: '20 / 20', ok: true, time: '+1 min 47 sec' },
  { step: 'PAYMENT COMPLETED', value: '480.00 USDT', ok: true, time: '20:41:14' },
  { step: 'WEBHOOK', value: 'HTTP 502 · 1.82 s', ok: false, time: 'attempt 5 / 5' },
];

export const ASSETS = [
  { name: 'USDT', sub: 'TRC20 · TRON', note: 'Primary settlement asset. 20 confirmations by default, per-project override available.' },
  { name: 'TRX', sub: 'Native · TRON', note: 'Accepted natively and used for fee reserves on operational wallets.' },
  { name: 'TRON MAINNET', sub: 'Network', note: 'Own RPC nodes with failover, independent indexer and matcher.' },
];

/** DEMO: statuses are illustrative, not live. */
export const INFRA: { label: string; status: string; metric: string; tone: Tone }[] = [
  { label: 'TRON', status: 'Operational', metric: 'block 76,842,291', tone: 'ok' },
  { label: 'RPC NODE', status: 'Degraded', metric: '812 ms p95', tone: 'warn' },
  { label: 'INDEXER', status: 'Operational', metric: '0 blocks behind', tone: 'ok' },
  { label: 'MATCHER', status: 'Delayed', metric: '15 unmatched', tone: 'warn' },
  { label: 'PROCESSOR', status: 'Operational', metric: '18 active', tone: 'ok' },
  { label: 'WEBHOOK', status: 'Operational', metric: '99.82% delivered', tone: 'ok' },
];

export const SNIPPET = `{
  "amount": "250.00",
  "asset": "USDT",
  "network": "TRON",
  "external_id": "DEP-82731",
  "callback_url": "https://forum-a.net/callbacks/relay"
}

→ 201 Created
{
  "payment": "PAY_83F12A",
  "address": "TY8kL2m9vQx4Rd7pZs1nHb3JcW6eF0aR2P",
  "expires_at": "2026-09-01T20:56:12Z"
}`;

/** The coins in the hero field. Positions in % of the field, size in px; depth 3 is nearest. */
export interface CoinSpec {
  id: number;
  sprite: number;
  asset: 'USDT' | 'TRX';
  x: number;
  y: number;
  size: number;
  depth: 1 | 2 | 3;
  blur: number;
  glow: number;
  rot: number;
  sx: number;
}

export const COINS: CoinSpec[] = [
  { sprite: 0, asset: 'USDT', x: 14, y: 64, size: 132, depth: 3, blur: 0, glow: 0.3, rot: -6, sx: 1 },
  { sprite: 2, asset: 'TRX', x: 64, y: 28, size: 90, depth: 2, blur: 0.2, glow: 0.24, rot: 9, sx: 0.96 },
  { sprite: 1, asset: 'USDT', x: 10, y: 30, size: 84, depth: 2, blur: 0.2, glow: 0.22, rot: -11, sx: 1 },
  { sprite: 3, asset: 'TRX', x: 76, y: 46, size: 78, depth: 2, blur: 0.4, glow: 0.2, rot: 5, sx: 0.92 },
  { sprite: 13, asset: 'USDT', x: 58, y: 63, size: 52, depth: 1, blur: 0.6, glow: 0.16, rot: -14, sx: 1 },
  { sprite: 7, asset: 'TRX', x: 6, y: 46, size: 50, depth: 1, blur: 0.6, glow: 0.16, rot: 15, sx: 0.9 },
  { sprite: 12, asset: 'TRX', x: 88, y: 36, size: 42, depth: 1, blur: 0.8, glow: 0.13, rot: -8, sx: 0.94 },
  { sprite: 11, asset: 'USDT', x: 20, y: 14, size: 40, depth: 1, blur: 0.8, glow: 0.13, rot: 12, sx: 1 },
].map((c, id) => ({ ...c, id }) as CoinSpec);

export const COIN_LABELS = {
  USDT: { name: 'USDT', lines: ['TRC20', 'TRON Network', 'Payment asset'] },
  TRX: { name: 'TRX', lines: ['Native asset', 'TRON Network', 'Payment asset'] },
} as const;
