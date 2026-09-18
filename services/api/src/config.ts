/**
 * Configuration.
 *
 * Every value is read once at startup and validated immediately. A missing
 * mnemonic must stop the process here, not surface as a confusing error on the
 * first payment of the day.
 */

import { DepositAddresses } from '@relay/wallet';

export interface Config {
  readonly port: number;
  readonly host: string;
  /** Hands out deposit addresses. The public half of the key only: this service never signs. */
  readonly wallet: DepositAddresses;
  readonly requiredConfirmations: number;
  readonly paymentTtlMinutes: number;
  readonly network: string;
  readonly isProduction: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. See .env.example.`);
  }
  return value.trim();
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function loadConfig(): Config {
  requireEnv('DATABASE_URL');

  const network = process.env['TRON_NETWORK']?.trim() ?? 'nile';
  const isProduction = network === 'mainnet';

  // The API is the most exposed service there is, and handing out addresses is
  // all it does with the key. So it gets the extended public key and nothing
  // that can spend. In production a mnemonic in its environment is a mistake
  // worth stopping for, not a spare.
  if (process.env['NODE_ENV'] === 'production' && process.env['WALLET_MNEMONIC']?.trim()) {
    throw new Error('WALLET_MNEMONIC is set for the API, which needs only DEPOSIT_XPUB. Remove the mnemonic from its environment.');
  }
  const wallet = DepositAddresses.fromXpub(requireEnv('DEPOSIT_XPUB'));

  return Object.freeze({
    port: intEnv('PORT', 3000),
    host: process.env['HOST']?.trim() ?? '127.0.0.1',
    wallet,
    requiredConfirmations: intEnv('CONFIRMATIONS_REQUIRED', 20),
    paymentTtlMinutes: intEnv('PAYMENT_TTL_MINUTES', 15),
    network,
    isProduction,
  });
}
