/**
 * Webhook contract.
 *
 * The merchant's endpoint is the only part of the payment flow we do not
 * control, so everything here assumes it will fail: the signature assumes
 * someone will try to forge a callback, the retry schedule assumes a temporary
 * outage, and the attempt cap assumes a permanent one.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_EVENTS = [
  'payment.created',
  'payment.detected',
  'payment.confirming',
  'payment.completed',
  'payment.underpaid',
  'payment.overpaid',
  'payment.expired',
  'payment.failed',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return typeof value === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export const SIGNATURE_HEADER = 'relay-signature';

/**
 * How old a signed timestamp may be before a receiver should reject it.
 * Without this, a callback captured once could be replayed forever.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * `t=<unix seconds>,v1=<hex hmac>`
 *
 * The timestamp is inside the signed material, not merely alongside it, so an
 * attacker cannot take a genuine signature and re-date it.
 */
export function signPayload(body: string, secret: string, timestampSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

/**
 * Verify a signature header. Written to be handed to merchants as reference
 * code, which is why it is careful about the two things integrations get
 * wrong: comparing with `===`, and ignoring the timestamp.
 */
export function verifySignature(
  body: string,
  secret: string,
  header: string,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;

  const parts = new Map(
    header.split(',').map((piece) => {
      const index = piece.indexOf('=');
      return [piece.slice(0, index).trim(), piece.slice(index + 1).trim()] as const;
    }),
  );

  const timestamp = Number(parts.get('t'));
  const provided = parts.get('v1');
  if (!Number.isSafeInteger(timestamp) || provided === undefined) return false;
  if (Math.abs(now - timestamp) > tolerance) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  let providedBytes: Buffer;
  try {
    providedBytes = Buffer.from(provided, 'hex');
  } catch {
    return false;
  }

  // Length must match before timingSafeEqual, which throws on a mismatch.
  if (providedBytes.length !== expected.length) return false;
  return timingSafeEqual(providedBytes, expected);
}

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

export const MAX_WEBHOOK_ATTEMPTS = 5;

/**
 * Delay before attempt N (1-based), in milliseconds.
 *
 * Spread wide on purpose. A merchant deploying a broken release needs minutes
 * to notice and roll back, not seconds — a tight retry loop just adds load to
 * an endpoint that is already struggling, and burns the attempt budget before
 * anybody has woken up.
 *
 *   1 → immediately
 *   2 → 30 seconds
 *   3 → 2 minutes
 *   4 → 10 minutes
 *   5 → 1 hour
 */
const BACKOFF_MS = [0, 30_000, 120_000, 600_000, 3_600_000] as const;

export function retryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`Attempt must be a positive integer, got ${attempt}`);
  }
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1]!;
}

/**
 * Whether an HTTP response means "try again later" or "this will never work".
 *
 * 4xx other than 408 and 429 are the merchant rejecting the payload — retrying
 * an identical body will get an identical rejection, so we stop and raise it
 * as an exception for a human instead of spending an hour proving the point.
 */
export function isRetriableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500 || status < 200;
}

export function shouldRetry(attempt: number, status: number | null): boolean {
  if (attempt >= MAX_WEBHOOK_ATTEMPTS) return false;
  // No status at all means the connection failed — always worth another try.
  if (status === null) return true;
  return isRetriableStatus(status);
}
