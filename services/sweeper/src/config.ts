/**
 * Sweeper configuration.
 */

import { DEFAULT_SWEEP_POLICY, type SweepPolicy } from '@relay/core';
import { DEFAULT_MAX_PRICE_AGE_SECONDS, USDT_TRX_FEEDS } from '@relay/tron';
import { DepositWallet, deriveHotWallet, isValidAddress, type OperationalKey } from '@relay/wallet';

export interface SweeperConfig {
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
   * The wallet payouts are signed by. Derived on the server, which is exactly
   * why it should only ever hold a working float.
   */
  readonly hotWallet: OperationalKey;
  /**
   * Payouts are broadcast only when PAYOUT_BROADCAST is exactly "true" —
   * independently of sweeps, because this is the one flow that sends money to
   * addresses we do not own.
   */
  readonly payoutsDryRun: boolean;
  readonly wallet: DepositWallet;
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
 * Derive the hot wallet and cross-check it against the configured address.
 *
 * The indexer needs the hot wallet's address to recognise refills, and it
 * deliberately does not hold the mnemonic. So the address is configured
 * separately — and if it disagrees with what this mnemonic derives, one of the
 * two is wrong, and refusing to start is the only safe answer. Carrying on
 * would sign payouts from one wallet while the books watch another.
 */
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

function requireHotWallet(): OperationalKey {
  const hot = deriveHotWallet(requireEnv('WALLET_MNEMONIC'));
  const configured = process.env['HOT_WALLET_ADDRESS']?.trim();

  if (configured === undefined || configured === '') {
    throw new Error(
      'HOT_WALLET_ADDRESS is not set. This mnemonic derives ' + hot.address +
        ' at ' + hot.path + ' — set HOT_WALLET_ADDRESS to that, then fund it with TRX and a USDT float.',
    );
  }
  if (configured !== hot.address) {
    throw new Error(
      'HOT_WALLET_ADDRESS is ' + configured + ' but WALLET_MNEMONIC derives ' + hot.address +
        '. One of them is wrong; refusing to start rather than sign from a wallet the books are not watching.',
    );
  }
  return hot;
}

export function loadSweeperConfig(): SweeperConfig {
  return Object.freeze({
    fullNode: requireEnv('TRON_FULL_NODE'),
    apiKey: process.env['TRONGRID_API_KEY']?.trim() || undefined,
    usdtContract: requireEnv('USDT_CONTRACT'),
    treasuryAddress: requireTreasury(),
    hotWallet: requireHotWallet(),
    payoutsDryRun: process.env['PAYOUT_BROADCAST'] !== 'true',
    wallet: DepositWallet.fromMnemonic(requireEnv('WALLET_MNEMONIC')),
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
