/**
 * Console configuration.
 */

import { parseSecretboxKey } from '@relay/auth';

export interface ConsoleConfig {
  readonly port: number;
  /**
   * Loopback by default. The console moves money; it should be reached over a
   * VPN or an SSH tunnel, never by being exposed to the internet and trusting
   * a login form to hold the line alone.
   */
  readonly host: string;
  /** Opens every operator's sealed TOTP secret. Lives in the environment only. */
  readonly secretKey: Buffer;
  /**
   * Marks the session cookie Secure. On in production, where the console is
   * served over HTTPS; off only for plain-HTTP development on localhost, where
   * a Secure cookie would never be sent back.
   */
  readonly secureCookies: boolean;
  /** The one origin allowed to make state-changing requests. */
  readonly allowedOrigin: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(name + ' must be a positive whole number');
  return parsed;
}

export function loadConsoleConfig(): ConsoleConfig {
  const port = intEnv('CONSOLE_PORT', 3100);
  const host = process.env['CONSOLE_HOST']?.trim() || '127.0.0.1';
  const production = process.env['NODE_ENV'] === 'production';
  const secureCookies = process.env['CONSOLE_SECURE_COOKIES'] === undefined
    ? production
    : process.env['CONSOLE_SECURE_COOKIES'] === 'true';

  if (production && !secureCookies) {
    throw new Error('CONSOLE_SECURE_COOKIES cannot be false in production: the session cookie would travel in the clear');
  }

  return Object.freeze({
    port,
    host,
    secretKey: parseSecretboxKey(process.env['CONSOLE_SECRET_KEY']),
    secureCookies,
    allowedOrigin: process.env['CONSOLE_ORIGIN']?.trim() || 'http://127.0.0.1:' + port,
  });
}
