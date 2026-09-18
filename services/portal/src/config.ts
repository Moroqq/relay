/**
 * Portal configuration.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseSecretboxKey } from '@relay/auth';

export interface PortalConfig {
  readonly port: number;
  /**
   * Loopback by default: the portal is meant to sit behind the web server that
   * also serves the website, on the same origin.
   */
  readonly host: string;
  /** Seals merchants' second-factor secrets. Its own key, not the console's. */
  readonly secretKey: Buffer;
  /** Secure cookies: forced on in production. */
  readonly secureCookies: boolean;
  /** Origins allowed to send state-changing requests: the site, and the portal itself. */
  readonly allowedOrigins: readonly string[];
  readonly network: string;
  /** Keys issued on mainnet say so (ak_live_…); anywhere else they are test keys. */
  readonly liveKeys: boolean;
  /** Built portal pages (apps/portal/dist). Null serves the API alone. */
  readonly webDir: string | null;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(name + ' must be a positive whole number');
  return parsed;
}

function webDir(): string | null {
  const configured = process.env['PORTAL_WEB_DIR']?.trim();
  if (configured) {
    if (!existsSync(configured)) throw new Error('PORTAL_WEB_DIR does not exist: ' + configured);
    return configured;
  }
  const built = fileURLToPath(new URL('../../../apps/portal/dist', import.meta.url));
  return existsSync(built) ? built : null;
}

export function loadPortalConfig(): PortalConfig {
  const port = intEnv('PORTAL_PORT', 3200);
  const production = process.env['NODE_ENV'] === 'production';
  const secureCookies = process.env['PORTAL_SECURE_COOKIES'] === undefined
    ? production
    : process.env['PORTAL_SECURE_COOKIES'] === 'true';
  if (production && !secureCookies) {
    throw new Error('PORTAL_SECURE_COOKIES cannot be false in production: the session cookie would travel in the clear');
  }
  const network = process.env['TRON_NETWORK']?.trim() || 'nile';
  const origins = (process.env['PORTAL_ORIGINS']?.trim() || `http://127.0.0.1:${port},http://127.0.0.1:5174`)
    .split(',').map((o) => o.trim()).filter(Boolean);

  return Object.freeze({
    port,
    host: process.env['PORTAL_HOST']?.trim() || '127.0.0.1',
    secretKey: parseSecretboxKey(process.env['PORTAL_SECRET_KEY']),
    secureCookies,
    allowedOrigins: Object.freeze(origins),
    network,
    liveKeys: network === 'mainnet',
    webDir: webDir(),
  });
}
