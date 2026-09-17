/**
 * Indexer configuration.
 */

import type { Asset } from '@relay/core';
import type { OperationalAddresses } from '@relay/db';
import { isValidAddress } from '@relay/wallet';

export interface IndexerConfig {
  readonly fullNode: string;
  readonly apiKey: string | undefined;
  /** Contract address to asset. Anything not listed here is not our money. */
  readonly contracts: ReadonlyMap<string, Asset>;
  readonly pollIntervalMs: number;
  /** How many blocks to catch up in one pass before pausing. */
  readonly batchSize: number;
  /** Where to start when the database has no recorded position. */
  readonly startBehindHead: number;
  /**
   * The treasury and hot wallet, so transfers between them can be booked.
   * Addresses only: the indexer never holds a key. Null when either is unset,
   * in which case refills simply go unrecorded until they are configured.
   */
  readonly operational: OperationalAddresses | null;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative whole number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function readOperational(): OperationalAddresses | null {
  const treasury = process.env['TREASURY_ADDRESS']?.trim();
  const hotWallet = process.env['HOT_WALLET_ADDRESS']?.trim();
  if (!treasury || !hotWallet) return null;
  for (const [name, value] of [['TREASURY_ADDRESS', treasury], ['HOT_WALLET_ADDRESS', hotWallet]] as const) {
    if (!isValidAddress(value)) throw new Error(`${name} is not a valid TRON address: ${value}`);
  }
  if (treasury === hotWallet) {
    throw new Error('TREASURY_ADDRESS and HOT_WALLET_ADDRESS must be different wallets');
  }
  return { treasury, hotWallet };
}

export function loadIndexerConfig(): IndexerConfig {
  const fullNode = process.env['TRON_FULL_NODE']?.trim();
  if (fullNode === undefined || fullNode === '') {
    throw new Error('TRON_FULL_NODE is not set. See .env.example.');
  }

  const usdt = process.env['USDT_CONTRACT']?.trim();
  if (usdt === undefined || usdt === '') {
    throw new Error('USDT_CONTRACT is not set. See .env.example.');
  }

  return Object.freeze({
    fullNode,
    apiKey: process.env['TRONGRID_API_KEY']?.trim() || undefined,
    contracts: new Map<string, Asset>([[usdt, 'USDT']]),
    // TRON produces a block every three seconds.
    pollIntervalMs: intEnv('INDEXER_POLL_MS', 3_000),
    batchSize: intEnv('INDEXER_BATCH_SIZE', 25),
    // A fresh install starts near the head rather than at the genesis block:
    // there are no deposit addresses in history to find.
    startBehindHead: intEnv('INDEXER_START_BEHIND_HEAD', 20),
    operational: readOperational(),
  });
}
