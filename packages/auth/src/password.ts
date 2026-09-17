/**
 * Operator passwords, stored as scrypt hashes.
 *
 * scrypt rather than a plain hash because passwords are low-entropy and a
 * leaked table is attacked offline, one guess at a time: the point is to make
 * each guess expensive in memory as well as time. Built into node:crypto, so no
 * native dependency to compile.
 *
 * Parameters are stored with each hash, so they can be raised later without
 * invalidating existing passwords.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** N = 2^15, r = 8, p = 1 — OWASP's baseline for scrypt. */
const COST_LOG2 = 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
// 128 · N · r bytes is 33.5 MB at these settings, above Node's 32 MB default.
const MAX_MEMORY = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 12;

function derive(password: string, salt: Buffer, costLog2: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: 2 ** costLog2, r, p, maxmem: MAX_MEMORY }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** `scrypt$15$8$1$<salt>$<hash>`, both base64url. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error('Password must be at least ' + MIN_PASSWORD_LENGTH + ' characters');
  }
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST_LOG2, BLOCK_SIZE, PARALLELISM);
  return ['scrypt', COST_LOG2, BLOCK_SIZE, PARALLELISM, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, costLog2, r, p, saltText, hashText] = parts;
  const expected = Buffer.from(hashText!, 'base64url');

  // Parameters out of any sane range — corrupted, or planted to make one login
  // allocate gigabytes — are refused before any work is done, and any failure
  // inside the derivation is a no rather than a thrown error.
  const cost = Number(costLog2);
  if (!Number.isInteger(cost) || cost < 10 || cost > 20 || Number(r) !== BLOCK_SIZE || Number(p) !== PARALLELISM) {
    return false;
  }
  try {
    const key = await derive(password, Buffer.from(saltText!, 'base64url'), cost, Number(r), Number(p));
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/**
 * A hash to verify against when the account does not exist.
 *
 * Checking a real hash takes tens of milliseconds; answering "no such operator"
 * instantly would let anyone learn which addresses have accounts by timing the
 * login form. So an unknown address still pays for one derivation.
 */
let decoy: Promise<string> | null = null;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(24).toString('base64url'));
  return decoy;
}

/** A strong random password for bootstrapping an operator, shown once. */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}
