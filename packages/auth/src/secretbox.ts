/**
 * Encrypting secrets that must be stored but must not be readable from a dump.
 *
 * An operator's TOTP secret has to be recoverable — the server regenerates codes
 * from it — so it cannot be hashed like a password. Stored in plain text, a
 * database leak would hand over the second factor of every operator at once.
 * AES-256-GCM with a key that lives in the environment, not in the database,
 * means a dump alone is not enough.
 *
 * GCM authenticates as well as encrypts, so a value tampered with in the
 * database fails to open rather than decrypting to something else.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export class SecretboxError extends Error {
  override readonly name = 'SecretboxError';
}

/** The key must be exactly 32 bytes, given as base64. */
export function parseSecretboxKey(base64: string | undefined): Buffer {
  if (base64 === undefined || base64.trim() === '') {
    throw new SecretboxError('CONSOLE_SECRET_KEY is not set');
  }
  const key = Buffer.from(base64.trim(), 'base64');
  if (key.length !== 32) {
    throw new SecretboxError('CONSOLE_SECRET_KEY must decode to 32 bytes, got ' + key.length);
  }
  return key;
}

export function newSecretboxKey(): string {
  return randomBytes(32).toString('base64');
}

export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join('.');
}

export function open(sealed: string, key: Buffer): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretboxError('Unrecognised sealed value');

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1]!, 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, or the value was altered. Either way: do not guess.
    throw new SecretboxError('Sealed value could not be opened');
  }
}
