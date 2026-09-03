/**
 * Signing a TRON transaction.
 *
 * The node builds the transaction and returns its `txID`, which is the SHA-256
 * of the serialised raw_data. We sign that hash with the deposit address's
 * private key and hand the result back for broadcast. Doing it this way means
 * we never serialise protobuf ourselves — a place where a wrong byte produces
 * a transaction that is valid, signed, and sends the money somewhere else.
 *
 * What we do NOT delegate to the node is verifying what we are signing. The
 * node is a remote service; a compromised or merely wrong one could return a
 * transaction whose contract fields differ from what we asked for, and a
 * signature is an irrevocable authorisation. `assertMatchesIntent` re-reads
 * the returned transaction and refuses to sign anything that is not what we
 * requested.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export class SigningError extends Error {
  override readonly name = 'SigningError';
}

/** What we asked the node to build, in the terms the transaction expresses. */
export interface TransferIntent {
  /** Owner address, 21-byte chain hex with the 0x41 prefix. */
  readonly ownerHex: string;
  /** Contract address for a TRC20 transfer, same encoding. */
  readonly contractHex: string;
  /** ABI-encoded call data: selector plus recipient and amount. */
  readonly dataHex: string;
}

interface RawTransaction {
  readonly txID?: string;
  readonly raw_data?: {
    readonly contract?: readonly {
      readonly type?: string;
      readonly parameter?: { readonly value?: Record<string, unknown> };
    }[];
  };
  readonly raw_data_hex?: string;
}

const normalise = (hex: string): string => hex.replace(/^0x/, '').toLowerCase();

/** TRON reads the signature header as recovery id + 27, the Ethereum convention. */
const RECOVERY_OFFSET = 27;

/**
 * Refuse to sign a transaction that is not the one we asked for.
 *
 * Also recomputes the txID from raw_data_hex rather than trusting the field:
 * signing the node's claimed hash instead of the hash of the bytes it sent
 * would let a hostile node have us authorise something we never saw.
 */
export function assertMatchesIntent(tx: RawTransaction, intent: TransferIntent): string {
  const rawHex = tx.raw_data_hex;
  if (typeof rawHex !== 'string' || rawHex === '') {
    throw new SigningError('Node returned no raw_data_hex to verify');
  }

  const computed = bytesToHex(sha256(hexToBytes(normalise(rawHex))));
  if (typeof tx.txID !== 'string' || normalise(tx.txID) !== computed) {
    throw new SigningError(
      `Transaction id does not match its own bytes (claimed ${String(tx.txID)}, computed ${computed})`,
    );
  }

  const contract = tx.raw_data?.contract?.[0];
  if (contract?.type !== 'TriggerSmartContract') {
    throw new SigningError(`Expected a TriggerSmartContract, got ${String(contract?.type)}`);
  }

  const value = contract.parameter?.value ?? {};
  const checks: [string, unknown, string][] = [
    ['owner_address', value['owner_address'], intent.ownerHex],
    ['contract_address', value['contract_address'], intent.contractHex],
    ['data', value['data'], intent.dataHex],
  ];

  for (const [field, actual, expected] of checks) {
    if (typeof actual !== 'string' || normalise(actual) !== normalise(expected)) {
      throw new SigningError(
        `Transaction ${field} is not what we asked for: ${String(actual)} vs ${expected}`,
      );
    }
  }

  return computed;
}

/**
 * Produce the 65-byte signature TRON expects: r, then s, then a header byte.
 *
 * The header is the recovery id PLUS 27. TRON inherited that offset from
 * Ethereum, and its validator reads the byte as a bitcoinj-style header in the
 * range 27-34 — a bare recovery id of 0 or 1 is rejected outright. Everything
 * else about the signature is identical, so the mistake produces a signature
 * that looks correct in every byte but the last and fails with nothing more
 * helpful than "signature validate failed". This value was settled by
 * comparing against TronWeb on a real transaction, not by reading a spec.
 *
 * `s` is taken in its low form. secp256k1 signatures come in pairs — (r, s)
 * and (r, n - s) are both valid for the same key — and accepting the high form
 * would let the same authorisation appear under two different signatures.
 */
export function signTransactionHash(txIdHex: string, privateKey: Uint8Array): string {
  const hash = hexToBytes(normalise(txIdHex));
  if (hash.length !== 32) {
    throw new SigningError(`Transaction id must be 32 bytes, got ${hash.length}`);
  }

  const signature = secp256k1.sign(hash, privateKey, { prehash: false, lowS: true });
  const compact = signature.toBytes('compact'); // 64 bytes: r || s

  const full = new Uint8Array(65);
  full.set(compact, 0);
  full[64] = signature.recovery + RECOVERY_OFFSET;

  return bytesToHex(full);
}

/** Attach a signature, leaving the node's transaction otherwise untouched. */
export function signTransaction<T extends RawTransaction>(
  tx: T,
  intent: TransferIntent,
  privateKey: Uint8Array,
): T & { signature: string[] } {
  const txId = assertMatchesIntent(tx, intent);
  return { ...tx, signature: [signTransactionHash(txId, privateKey)] };
}
