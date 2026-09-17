/**
 * Console session tokens.
 *
 * The browser holds the token; the database holds only its SHA-256. A leaked
 * sessions table therefore cannot be replayed as cookies. A plain hash is right
 * here, unlike for passwords: the token is 256 random bits, so there is nothing
 * to guess and nothing to slow down.
 */

import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'relay_console';

/** Absolute lifetime: a working day, after which the operator signs in again. */
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/** Idle limit: a console left open and unattended locks itself. */
export const SESSION_IDLE_SECONDS = 30 * 60;

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
