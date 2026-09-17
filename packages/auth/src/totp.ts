/**
 * Time-based one-time codes (RFC 6238), for the second factor on the console.
 *
 * The console approves money leaving the system. A password alone would make a
 * phished or reused password a stolen payout; the code from an authenticator
 * app on the operator's phone is what stands between the two.
 *
 * Implemented here rather than pulled in: it is thirty lines over node:crypto,
 * and it is checked against the test vectors printed in the RFCs themselves.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32nopad } from '@scure/base';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/**
 * Steps either side of now a code is accepted from. One step is thirty seconds:
 * it absorbs a phone clock slightly off and a code typed as it rolled over.
 * Wider only gives an attacker more live codes to guess against.
 */
export const TOTP_WINDOW = 1;

/** A fresh secret: 20 bytes, the length RFC 4226 recommends for HMAC-SHA1. */
export function newTotpSecret(): string {
  return base32nopad.encode(randomBytes(20));
}

export function decodeTotpSecret(secret: string): Uint8Array {
  return base32nopad.decode(secret.replace(/=+$/, '').replace(/ /g, '').toUpperCase());
}

/** HOTP (RFC 4226): the code for one counter value. */
export function hotp(key: Uint8Array, counter: bigint, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const mac = createHmac('sha1', key).update(message).digest();

  // Dynamic truncation: the low nibble of the last byte picks four bytes, whose
  // top bit is masked off so the result is never negative.
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpCounter(unixSeconds: number): bigint {
  return BigInt(Math.floor(unixSeconds / TOTP_STEP_SECONDS));
}

export function totp(key: Uint8Array, unixSeconds: number, digits = TOTP_DIGITS): string {
  return hotp(key, totpCounter(unixSeconds), digits);
}

export interface TotpCheck {
  readonly ok: boolean;
  /** The counter the code matched, to be stored so it cannot be used again. */
  readonly counter: bigint | null;
}

/**
 * Check a code, refusing any at or before the last one accepted.
 *
 * Without that condition a code stays valid for its whole window, so one read
 * over a shoulder or lifted from a screen recording could be replayed within
 * the minute. Storing the matched counter and requiring strictly newer closes it.
 */
export function verifyTotp(
  key: Uint8Array,
  code: string,
  unixSeconds: number,
  lastUsedCounter: bigint | null,
): TotpCheck {
  const clean = code.replace(/ /g, '');
  if (!/^[0-9]{6}$/.test(clean)) return { ok: false, counter: null };

  const now = totpCounter(unixSeconds);
  const given = Buffer.from(clean);

  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
    const counter = now + BigInt(offset);
    if (counter < 0n) continue;
    if (lastUsedCounter !== null && counter <= lastUsedCounter) continue;
    if (timingSafeEqual(given, Buffer.from(hotp(key, counter)))) return { ok: true, counter };
  }
  return { ok: false, counter: null };
}

/** The link an authenticator app understands, for manual entry or a QR code. */
export function otpauthUri(secret: string, account: string, issuer = 'Relay Console'): string {
  const label = encodeURIComponent(issuer + ':' + account);
  const params = new URLSearchParams({
    secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS),
  });
  return 'otpauth://totp/' + label + '?' + params.toString();
}
