/**
 * Public identifiers.
 *
 * Prefixed so that an id is self-describing wherever it turns up — in a log
 * line, a support ticket, or a merchant's database. `PAY_` is a payment,
 * `PRJ_` a project, and nobody has to guess.
 *
 * The random part uses Crockford's base32 alphabet, which drops I, L, O and U.
 * That removes the characters people confuse when reading an id off a screen
 * or over the phone, which is most of what support does with them.
 *
 * Sixteen characters is longer than the six the design mockups show. Six would
 * be 16 million possibilities: with a birthday collision, two payments would
 * collide somewhere around the twenty-thousandth. Sixteen gives 80 bits, which
 * will not collide before the heat death of the business.
 */

import { createHash, randomFillSync } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const RANDOM_LENGTH = 16;

export const ID_PREFIXES = {
  merchant: 'MER',
  project: 'PRJ',
  endUser: 'USR',
  deposit: 'DEP',
  payout: 'PYT',
  operator: 'OPR',
  merchantUser: 'MUS',
  accessRequest: 'REQ',
  payment: 'PAY',
  apiKey: 'AKY',
  webhookDelivery: 'WHD',
  ledgerTransaction: 'LTX',
  ledgerAccount: 'ACC',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/**
 * Rejection sampling rather than `% 32`.
 *
 * A byte holds 256 values and the alphabet has 32, which divides evenly — so
 * modulo would in fact be uniform here. It is written this way regardless,
 * because the day someone changes the alphabet length to something that does
 * not divide 256, a modulo would quietly start favouring the early letters and
 * nothing would fail visibly.
 */
function randomToken(length: number): string {
  const limit = 256 - (256 % ALPHABET.length);
  const out: string[] = [];
  const buffer = new Uint8Array(length * 2);

  while (out.length < length) {
    randomFillSync(buffer);
    for (const byte of buffer) {
      if (byte >= limit) continue;
      out.push(ALPHABET[byte % ALPHABET.length]!);
      if (out.length === length) break;
    }
  }

  return out.join('');
}

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomToken(RANDOM_LENGTH)}`;
}

/** Whether a string is a well-formed id of the given kind. */
export function isId(value: unknown, kind: IdKind): value is string {
  if (typeof value !== 'string') return false;
  const pattern = new RegExp(`^${ID_PREFIXES[kind]}_[${ALPHABET}]{${RANDOM_LENGTH}}$`);
  return pattern.test(value);
}

/**
 * A short form for dense tables, where the full id does not fit.
 * Display only — never store or look up by this.
 */
export function shortenId(id: string): string {
  const underscore = id.indexOf('_');
  if (underscore === -1) return id.slice(0, 10);
  return `${id.slice(0, underscore + 1)}${id.slice(underscore + 1, underscore + 7)}`;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/**
 * A generated API key. The full secret exists exactly once, at this moment —
 * it is shown to the merchant and never recoverable afterwards, because only
 * its hash is stored.
 */
export interface GeneratedApiKey {
  readonly id: string;
  /** The full secret. Show once, then forget. */
  readonly secret: string;
  /** The leading part, safe to store and display so a key is recognisable. */
  readonly prefix: string;
}

export function newApiKey(live: boolean): GeneratedApiKey {
  const environment = live ? 'live' : 'test';
  const body = randomToken(40); // 200 bits
  const secret = `ak_${environment}_${body}`;
  return Object.freeze({
    id: newId('apiKey'),
    secret,
    prefix: secret.slice(0, `ak_${environment}_`.length + 4),
  });
}

/**
 * Hash an API key for storage and lookup.
 *
 * A plain SHA-256, not a password hash. Password hashing is slow on purpose
 * because passwords are low-entropy and guessable; an API key here carries 200
 * bits of randomness, so there is nothing to guess and the slowdown would only
 * be paid on every authenticated request. What matters is that the stored form
 * is one-way, so a leaked database cannot be used to create payments.
 */
export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}
