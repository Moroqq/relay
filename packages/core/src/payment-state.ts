/**
 * Payment lifecycle.
 *
 * Two independent state machines, on purpose.
 *
 * `PaymentState` answers "where is the money?" — a question only the TRON
 * blockchain can answer.
 *
 * `WebhookState` answers "does the merchant know?" — a question only the
 * merchant's HTTP endpoint can answer.
 *
 * The design mockups show a single `webhook_failed` payment state, which reads
 * well in a table but is wrong as a model: a payment whose funds are confirmed
 * on-chain is COMPLETED, permanently, whatever the merchant's server does
 * afterwards. Collapsing the two lets a webhook outage silently reopen settled
 * money. Keep them apart here; compose the label for display.
 */

export const PAYMENT_STATES = [
  /** Address issued, nothing received yet. */
  'waiting',
  /** A transfer to the address is in the mempool or a fresh block. */
  'detected',
  /** Transfer is in a block; counting confirmations. */
  'confirming',
  /** Confirmed, and the amount covers what was expected. */
  'completed',
  /** Confirmed, but less arrived than expected. Needs a decision. */
  'underpaid',
  /** Confirmed, but more arrived than expected. Needs a refund decision. */
  'overpaid',
  /** The window closed with nothing received. */
  'expired',
  /** The transfer reverted on-chain, or the payment was cancelled. */
  'failed',
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

/**
 * Allowed transitions. Anything not listed here is a bug, and the code that
 * applies transitions must reject it loudly rather than coerce it.
 *
 * The table's job is to stop a payment moving BACKWARDS — settled money must
 * never become unsettled, and a terminal state must stay terminal. It is not
 * where "do not settle unconfirmed funds" is enforced; that rule belongs to
 * whoever compares confirmations against the required depth, because it is a
 * fact about the chain rather than about the shape of the graph.
 *
 * So a payment may jump straight from `waiting` to `completed`. That is not a
 * skipped confirmation: it is the indexer coming back after an outage and
 * seeing a transfer that is already twenty blocks deep. Forcing it through the
 * intermediate states would mean either delaying settlement by two more passes
 * or sending the merchant `detected` and `confirming` webhooks for moments
 * that have long since passed.
 */
const PAYMENT_TRANSITIONS: Readonly<Record<PaymentState, readonly PaymentState[]>> =
  Object.freeze({
    waiting: ['detected', 'confirming', 'completed', 'underpaid', 'overpaid', 'expired', 'failed'],
    detected: ['confirming', 'completed', 'underpaid', 'overpaid', 'failed'],
    confirming: ['completed', 'underpaid', 'overpaid', 'failed'],

    // An underpaid payment can be topped up by a later transfer, and the
    // top-up can overshoot.
    underpaid: ['confirming', 'completed', 'overpaid', 'failed'],

    // An overpaid payment stays overpaid until a human resolves the excess;
    // resolution is recorded as a refund, not as a state change.
    overpaid: [],

    // Money arriving after the window closed is routine, not an incident. If
    // it is confirmed and covers the invoice, the payment settles: leaving a
    // customer's funds in limbo because a timer elapsed is the worse outcome,
    // and the merchant is notified either way.
    expired: ['detected', 'confirming', 'completed', 'underpaid', 'overpaid'],

    completed: [],
    failed: [],
  });

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

/** A state from which the payment can still change on its own. */
export function isTerminal(state: PaymentState): boolean {
  return PAYMENT_TRANSITIONS[state].length === 0;
}

/** Money is irrevocably ours to forward. */
export function isSettled(state: PaymentState): boolean {
  return state === 'completed' || state === 'overpaid';
}

export class PaymentTransitionError extends Error {
  override readonly name = 'PaymentTransitionError';
  readonly from: PaymentState;
  readonly to: PaymentState;

  constructor(from: PaymentState, to: PaymentState) {
    super(`Illegal payment transition: ${from} -> ${to}`);
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: PaymentState, to: PaymentState): void {
  if (!canTransition(from, to)) throw new PaymentTransitionError(from, to);
}

// ---------------------------------------------------------------------------
// Webhook delivery — the merchant's side of the story
// ---------------------------------------------------------------------------

export const WEBHOOK_STATES = ['pending', 'delivered', 'retrying', 'failed'] as const;
export type WebhookState = (typeof WEBHOOK_STATES)[number];

/**
 * The composite label the operations console shows in its exceptions grid,
 * e.g. "money in, merchant blind" — a completed payment nobody was told about.
 */
export function displayState(payment: PaymentState, webhook: WebhookState): string {
  if (isSettled(payment) && webhook === 'failed') return 'webhook_failed';
  return payment;
}
