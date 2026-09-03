/**
 * Reading transfers out of raw TRON block data.
 *
 * Every function here is pure, which is the point: this is where a
 * misinterpreted byte turns into money credited to the wrong account, and pure
 * functions can be tested against real captured blocks without a network.
 *
 * TRON quirk worth knowing: an address is 21 bytes on chain, a 0x41 prefix
 * followed by 20 bytes of account hash. But inside an EVM event log the prefix
 * is absent — logs carry the bare 20 bytes, because the log format is
 * inherited from Ethereum. Mixing the two up produces a valid-looking address
 * that belongs to nobody.
 */

import { encodeAddress } from '@relay/wallet';
import type { Asset } from '@relay/core';
import type { RawLog, RawTransaction, RawTransactionInfo } from '@relay/tron';

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC =
  'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface DecodedTransfer {
  readonly asset: Asset;
  readonly from: string;
  readonly to: string;
  readonly amountUnits: bigint;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`Not hex: ${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Turn a 20-byte log address (no 0x41 prefix) into a `T...` address.
 * Returns null rather than throwing, because one malformed log must not stop
 * the indexer from reading the rest of the block.
 */
export function logAddressToBase58(hex: string): string | null {
  try {
    const bytes = hexToBytes(hex);
    if (bytes.length !== 20) return null;
    return encodeAddress(bytes);
  } catch {
    return null;
  }
}

/**
 * Turn a 21-byte chain address (with the 0x41 prefix) into a `T...` address.
 * This is the form used in transaction bodies, as opposed to event logs.
 */
export function chainAddressToBase58(hex: string): string | null {
  try {
    const bytes = hexToBytes(hex);
    if (bytes.length !== 21 || bytes[0] !== 0x41) return null;
    return encodeAddress(bytes.subarray(1));
  } catch {
    return null;
  }
}

/**
 * Extract an address from a 32-byte indexed topic.
 *
 * The address occupies the last 20 bytes and the leading 12 must be zero.
 * A non-zero prefix means the topic is not an address — a different event with
 * a colliding signature, or a contract packing something else into the slot —
 * and silently truncating it would invent an address out of unrelated data.
 */
export function topicToAddress(topic: string): string | null {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(topic);
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  for (let i = 0; i < 12; i++) {
    if (bytes[i] !== 0) return null;
  }
  return encodeAddress(bytes.subarray(12));
}

/** Read a uint256 from a 32-byte data field. */
export function dataToAmount(data: string): bigint | null {
  const clean = data.startsWith('0x') ? data.slice(2) : data;
  if (clean.length === 0 || clean.length > 64 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  const value = BigInt(`0x${clean}`);
  return value < 0n ? null : value;
}

/**
 * Decode one log as a TRC20 transfer, if that is what it is.
 *
 * `contracts` maps a contract address (base58) to the asset it represents.
 * Anything from a contract we do not track is ignored: on a live network most
 * Transfer events belong to tokens that have nothing to do with us, and a
 * lookup rather than a guess is what keeps a random token from being credited
 * as USDT.
 */
export function decodeTransferLog(
  log: RawLog,
  contracts: ReadonlyMap<string, Asset>,
): DecodedTransfer | null {
  const topics = log.topics;
  if (topics === undefined || topics.length !== 3) return null;
  if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  if (log.address === undefined || log.data === undefined) return null;

  const contract = logAddressToBase58(log.address);
  if (contract === null) return null;

  const asset = contracts.get(contract);
  if (asset === undefined) return null;

  const from = topicToAddress(topics[1]!);
  const to = topicToAddress(topics[2]!);
  const amountUnits = dataToAmount(log.data);
  if (from === null || to === null || amountUnits === null) return null;

  // A zero-value transfer is legal on chain and used for probing. It moves no
  // money, so it must not open or advance a payment.
  if (amountUnits === 0n) return null;

  return Object.freeze({ asset, from, to, amountUnits });
}

// ---------------------------------------------------------------------------
// Native TRX
// ---------------------------------------------------------------------------


/**
 * Whether a transaction actually succeeded.
 *
 * Failed transactions are still recorded in blocks. Reading one as a payment
 * would credit a merchant for money that never moved, so the check is not
 * optional and the default for an unrecognised shape is "no".
 */
export function isSuccessful(tx: RawTransaction): boolean {
  const result = tx.ret?.[0]?.contractRet;
  return result === 'SUCCESS';
}

export function decodeNativeTransfer(tx: RawTransaction): DecodedTransfer | null {
  if (!isSuccessful(tx)) return null;

  const contract = tx.raw_data?.contract?.[0];
  if (contract?.type !== 'TransferContract') return null;

  const value = contract.parameter?.value;
  if (value === undefined) return null;

  const owner = value['owner_address'];
  const target = value['to_address'];
  const amount = value['amount'];

  if (typeof owner !== 'string' || typeof target !== 'string') return null;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return null;

  const from = chainAddressToBase58(owner);
  const to = chainAddressToBase58(target);
  if (from === null || to === null) return null;

  return Object.freeze({ asset: 'TRX' as Asset, from, to, amountUnits: BigInt(amount) });
}

// ---------------------------------------------------------------------------
// Whole blocks
// ---------------------------------------------------------------------------

export interface ObservedTransfer extends DecodedTransfer {
  readonly txHash: string;
  /**
   * Position of this transfer within its transaction. One transaction can
   * carry several, so the hash alone does not identify a transfer — and using
   * it alone as a key would silently drop all but one of a batch payout.
   */
  readonly logIndex: number;
}

/**
 * All TRC20 transfers in a block that belong to contracts we track.
 *
 * The log index counts every log in the transaction, not only the matching
 * ones, so it stays stable if the set of tracked contracts changes later.
 */
export function extractTrc20Transfers(
  infos: readonly RawTransactionInfo[],
  contracts: ReadonlyMap<string, Asset>,
): ObservedTransfer[] {
  const found: ObservedTransfer[] = [];

  for (const info of infos) {
    if (typeof info.id !== 'string') continue;
    // An energy-exhausted or reverted call can still carry logs.
    if (info.receipt?.result !== undefined && info.receipt.result !== 'SUCCESS') continue;

    const logs = info.log ?? [];
    for (let logIndex = 0; logIndex < logs.length; logIndex++) {
      const decoded = decodeTransferLog(logs[logIndex]!, contracts);
      if (decoded !== null) found.push({ ...decoded, txHash: info.id, logIndex });
    }
  }

  return found;
}

/** All successful native TRX transfers in a block body. */
export function extractNativeTransfers(
  transactions: readonly RawTransaction[],
): ObservedTransfer[] {
  const found: ObservedTransfer[] = [];

  for (const tx of transactions) {
    if (typeof tx.txID !== 'string') continue;
    const decoded = decodeNativeTransfer(tx);
    // A native transfer is the whole transaction, so it has no log position.
    // Index -1 keeps it from ever colliding with a TRC20 log index.
    if (decoded !== null) found.push({ ...decoded, txHash: tx.txID, logIndex: -1 });
  }

  return found;
}

export type { RawLog, RawTransaction, RawTransactionInfo };
