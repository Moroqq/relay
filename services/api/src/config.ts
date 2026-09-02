/**
 * Configuration.
 *
 * Every value is read once at startup and validated immediately. A missing
 * mnemonic must stop the process here, not surface as a confusing error on the
 * first payment of the day.
 */

import { DepositWallet } from '@relay/wallet';

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly wallet: DepositWallet;
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

  const wallet = DepositWallet.fromMnemonic(requireEnv('WALLET_MNEMONIC'));

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
