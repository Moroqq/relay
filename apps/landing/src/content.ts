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

/** Paths, not bare anchors, so the menu also works from the application page. */
export const NAV = [
  { href: '/#product', label: 'Product' },
  { href: '/#infrastructure', label: 'Infrastructure' },
  { href: '/#developers', label: 'Developers' },
  { href: '/#company', label: 'Company' },
  { href: '/#status', label: 'Status' },
];

/** Where the calls to action go. */
export const LINKS = {
  apply: '/access/',
  login: '/app/',
};

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

/**
 * The coins in the hero field, laid out after the reference render of the
 * first screen. Positions are px from the centre of the Relay mark at full
 * scale; the field scales the whole composition around that centre. Depth 4
 * floats in front of the mark, out of focus; depth 1 sits far back.
 */
export interface CoinSpec {
  id: number;
  sprite: number;
  asset: 'USDT' | 'TRX';
  dx: number;
  dy: number;
  size: number;
  depth: 1 | 2 | 3 | 4;
  blur: number;
  glow: number;
}

export const COINS: CoinSpec[] = [
  { sprite: 1, asset: 'USDT', dx: 17, dy: -215, size: 175, depth: 3, blur: 0, glow: 0.34 },
  { sprite: 0, asset: 'USDT', dx: -159, dy: 296, size: 200, depth: 4, blur: 7, glow: 0.2 },
  { sprite: 3, asset: 'TRX', dx: -192, dy: 94, size: 112, depth: 2, blur: 0.2, glow: 0.26 },
  { sprite: 7, asset: 'TRX', dx: 369, dy: -194, size: 98, depth: 2, blur: 0, glow: 0.26 },
  { sprite: 8, asset: 'TRX', dx: 345, dy: 122, size: 90, depth: 2, blur: 0.2, glow: 0.24 },
  { sprite: 4, asset: 'USDT', dx: 178, dy: 240, size: 70, depth: 2, blur: 0.6, glow: 0.2 },
  { sprite: 10, asset: 'USDT', dx: 254, dy: -75, size: 68, depth: 2, blur: 0.3, glow: 0.2 },
  { sprite: 9, asset: 'TRX', dx: -396, dy: -191, size: 58, depth: 1, blur: 0.5, glow: 0.18 },
  { sprite: 11, asset: 'USDT', dx: -216, dy: -138, size: 52, depth: 1, blur: 0.6, glow: 0.16 },
  { sprite: 13, asset: 'USDT', dx: -452, dy: -43, size: 50, depth: 1, blur: 1.2, glow: 0.15 },
  { sprite: 14, asset: 'TRX', dx: -398, dy: 100, size: 42, depth: 1, blur: 1.4, glow: 0.14 },
].map((c, id) => ({ ...c, id }) as CoinSpec);

export const COIN_LABELS = {
  USDT: { name: 'USDT', lines: ['TRC20', 'TRON Network', 'Payment asset'] },
  TRX: { name: 'TRX', lines: ['Native asset', 'TRON Network', 'Payment asset'] },
} as const;
