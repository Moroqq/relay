/**
 * When a signed transaction stops being able to land.
 *
 * Every TRON transaction carries `raw_data.expiration`, a timestamp roughly a
 * minute after it was built. The network refuses to include it after that, so
 * a signed transaction that is past its expiry and not on chain will never be
 * on chain.
 *
 * That fact is what makes it safe to throw away stored bytes and build again.
 * Without it the only options after a crash between signing and broadcasting
 * are to wait forever, or to rebuild and risk paying twice. With it, there is a
 * point in time after which rebuilding is provably safe.
 */

/**
 * Slack added to the expiry before treating a transaction as dead.
 *
 * Covers a node that is a few blocks behind and so has not yet reported a
 * transaction that did land in time. Three minutes is dozens of blocks.
 */
export const EXPIRY_MARGIN_MS = 3 * 60 * 1000;

/** The expiry of a stored transaction, in milliseconds since the epoch. */
export function transactionExpiry(tx: unknown): number | null {
  if (typeof tx !== 'object' || tx === null) return null;
  const raw = (tx as { raw_data?: { expiration?: unknown } }).raw_data;
  const expiration = raw?.expiration;
  return typeof expiration === 'number' && Number.isFinite(expiration) ? expiration : null;
}

/**
 * Whether a transaction can no longer land.
 *
 * A transaction with no readable expiry is never considered dead: the safe
 * answer to "can I rebuild this?" when we cannot tell is no.
 */
export function isPastExpiry(tx: unknown, nowMs: number, marginMs = EXPIRY_MARGIN_MS): boolean {
  const expiry = transactionExpiry(tx);
  if (expiry === null) return false;
  return nowMs > expiry + marginMs;
}
