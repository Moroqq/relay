/**
 * Sweeper configuration.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_SWEEP_POLICY, type SweepPolicy } from '@relay/core';
import { DEFAULT_MAX_PRICE_AGE_SECONDS, USDT_TRX_FEEDS } from '@relay/tron';
import {
  DepositAddresses,
  isValidAddress,
  parseKeystore,
  type DepositWallet,
  type Keystore,
  type OperationalKey,
} from '@relay/wallet';

export interface SweeperSettings {
  readonly fullNode: string;
  readonly apiKey: string | undefined;
  readonly usdtContract: string;
  /**
   * The one wallet every user address is consolidated into.
   *
   * Required, and validated at startup rather than at the first sweep: an
   * unset or mistyped treasury is the difference between money arriving and
   * money gone.
   */
  readonly treasuryAddress: string;
  /**
   * The wallet payouts are signed from. Its key is on the server, which is
   * exactly why it should only ever hold a working float.
   */
  readonly hotWalletAddress: string;
  /** The account key deposit addresses come from — the same one the API holds. */
  readonly depositXpub: string;
  /** Where the signing keys come from. See KeySource. */
  readonly keySource: KeySource;
  /**
   * Payouts are broadcast only when PAYOUT_BROADCAST is exactly "true" —
   * independently of sweeps, because this is the one flow that sends money to
   * addresses we do not own.
   */
  readonly payoutsDryRun: boolean;
  readonly policy: SweepPolicy;
  /**
   * The WINkLink USDT/TRX price feed, as its proxy address.
   *
   * Replaces a TRX price typed into configuration. A typed price is right on
   * the day it is typed and wrong every day after; the sweep decision it feeds
   * either burns money on dust or leaves funds that were worth moving.
   * Defaults to the official feed for TRON_NETWORK.
   */
  readonly priceFeed: string;
  /** How old an oracle price may be before sweeps wait for a fresh one. */
  readonly maxPriceAgeSeconds: number;
  /**
   * Ceiling on what the network may charge for one sweep, in sun. A
   * transaction that would exceed it fails rather than draining the address.
   */
  readonly feeLimitSun: number;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  /** Build and sign, but never broadcast. On until deliberately turned off. */
  readonly dryRun: boolean;
  readonly requiredConfirmations: number;
}

/**
 * A keystore file the operator unlocks after each start, or — for development
 * only — the mnemonic in the environment.
 */
export type KeySource =
  | { readonly kind: 'keystore'; readonly path: string; readonly keystore: Keystore; readonly controlSocket: string }
  | { readonly kind: 'environment'; readonly mnemonic: string };

/** What signing needs, present only while the keys are unlocked. */
export interface SigningKeys {
  readonly wallet: DepositWallet;
  readonly hotWallet: OperationalKey;
}

/** Settings plus unlocked keys: what building and signing a transaction takes. */
export type SweeperConfig = SweeperSettings & SigningKeys;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. See .env.example.`);
  }
  return value.trim();
}

function requireTreasury(): string {
  const address = requireEnv('TREASURY_ADDRESS');
  // Base58Check catches a mistyped character here rather than on chain,
  // where the funds would be gone.
  if (!isValidAddress(address)) {
    throw new Error('TREASURY_ADDRESS is not a valid TRON address: ' + address);
  }
  return address;
}

/**
 * The oracle to read. An explicit ORACLE_USDT_TRX wins; otherwise the official
 * feed for the configured network. An unknown network with no explicit feed is
 * refused rather than guessed at — Nile's feed on mainnet would be a real
 * contract returning a testnet price.
 */
function requirePriceFeed(): string {
  const explicit = process.env['ORACLE_USDT_TRX']?.trim();
  if (explicit !== undefined && explicit !== '') {
    if (!isValidAddress(explicit)) throw new Error('ORACLE_USDT_TRX is not a valid TRON address: ' + explicit);
    return explicit;
  }
  const network = process.env['TRON_NETWORK']?.trim() ?? 'nile';
  if (network !== 'nile' && network !== 'mainnet') {
    throw new Error('No known USDT/TRX price feed for TRON_NETWORK=' + network + '; set ORACLE_USDT_TRX.');
  }
  return USDT_TRX_FEEDS[network];
}

function requireAddress(name: string): string {
  const address = requireEnv(name);
  if (!isValidAddress(address)) throw new Error(name + ' is not a valid TRON address: ' + address);
  return address;
}

function requireDepositXpub(): string {
  const xpub = requireEnv('DEPOSIT_XPUB');
  DepositAddresses.fromXpub(xpub); // throws, with a reason, on anything but an account-level public key
  return xpub;
}

/** Named pipe on Windows, a socket beside the keystore elsewhere. */
function defaultControlSocket(keystorePath: string): string {
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\relay-sweeper-keys'
    : path.join(path.dirname(path.resolve(keystorePath)), 'sweeper.sock');
}

/**
 * Where the signing keys will come from.
 *
 * With KEYSTORE_PATH the file is read and checked now, before anyone is asked
 * for a passphrase: a keystore for different addresses than the ones this
 * deployment hands out and watches is a configuration error, and finding it at
 * three in the morning after typing the passphrase helps nobody.
 *
 * The mnemonic in the environment is for development and is refused in
 * production, where it would sit on the server's disk in the clear.
 */
function requireKeySource(): KeySource {
  const keystorePath = process.env['KEYSTORE_PATH']?.trim();
  if (keystorePath) {
    let text: string;
    try {
      text = readFileSync(keystorePath, 'utf8');
    } catch (error) {
      throw new Error('KEYSTORE_PATH cannot be read: ' + (error as Error).message);
    }
    const keystore = parseKeystore(text);
    const hot = requireEnv('HOT_WALLET_ADDRESS');
    if (keystore.hotWallet !== hot) {
      throw new Error('The keystore signs for hot wallet ' + keystore.hotWallet + ' but HOT_WALLET_ADDRESS is ' + hot + '. One of them is wrong.');
    }
    if (keystore.depositXpub !== requireEnv('DEPOSIT_XPUB')) {
      throw new Error('The keystore is for different deposit addresses than DEPOSIT_XPUB. Sweeps would sign for addresses the API never handed out.');
    }
    return {
      kind: 'keystore',
      path: keystorePath,
      keystore,
      controlSocket: process.env['KEYS_SOCKET']?.trim() || defaultControlSocket(keystorePath),
    };
  }

  const mnemonic = process.env['WALLET_MNEMONIC']?.trim();
  if (!mnemonic) throw new Error('Set KEYSTORE_PATH (production) or WALLET_MNEMONIC (development only). See .env.example.');
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('WALLET_MNEMONIC is refused in production: it would sit on the server in the clear. Seal it with `npm run keys:seal` and set KEYSTORE_PATH.');
  }
  return { kind: 'environment', mnemonic };
}

export function loadSweeperSettings(): SweeperSettings {
  return Object.freeze({
    fullNode: requireEnv('TRON_FULL_NODE'),
    apiKey: process.env['TRONGRID_API_KEY']?.trim() || undefined,
    usdtContract: requireEnv('USDT_CONTRACT'),
    treasuryAddress: requireTreasury(),
    hotWalletAddress: requireAddress('HOT_WALLET_ADDRESS'),
    depositXpub: requireDepositXpub(),
    keySource: requireKeySource(),
    payoutsDryRun: process.env['PAYOUT_BROADCAST'] !== 'true',
    policy: {
      maxFeeBps: BigInt(intEnv('SWEEP_MAX_FEE_BPS', Number(DEFAULT_SWEEP_POLICY.maxFeeBps))),
      minValueUnits: BigInt(intEnv('SWEEP_MIN_UNITS', Number(DEFAULT_SWEEP_POLICY.minValueUnits))),
    } satisfies SweepPolicy,
    priceFeed: requirePriceFeed(),
    maxPriceAgeSeconds: intEnv('ORACLE_MAX_AGE_HOURS', DEFAULT_MAX_PRICE_AGE_SECONDS / 3600) * 3600,
    feeLimitSun: intEnv('SWEEP_FEE_LIMIT_SUN', 40_000_000), // 40 TRX
    pollIntervalMs: intEnv('SWEEP_POLL_MS', 30_000),
    batchSize: intEnv('SWEEP_BATCH_SIZE', 10),
    // Moving real money is opt-in. A misconfigured sweeper that only builds
    // and signs costs nothing; one that broadcasts by default can empty every
    // deposit address to the wrong place before anyone reads the logs.
    dryRun: process.env['SWEEP_BROADCAST'] !== 'true',
    requiredConfirmations: intEnv('CONFIRMATIONS_REQUIRED', 20),
  });
}
