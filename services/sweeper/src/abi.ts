/**
 * Encoding a TRC20 `transfer` call.
 *
 * TRC20 is TRON's copy of ERC20, so the call data is Ethereum ABI encoding:
 * a four-byte function selector followed by each argument padded to 32 bytes.
 *
 * Written out by hand rather than pulled from a library because it is twelve
 * lines, and because the alternative is trusting a dependency with the field
 * that says who receives the money.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { decodeAddress } from '@relay/wallet';

export class AbiError extends Error {
  override readonly name = 'AbiError';
}

/** First four bytes of keccak256 of the signature text. */
export function selectorOf(signature: string): string {
  return bytesToHex(keccak_256(utf8ToBytes(signature)).subarray(0, 4));
}

/** `transfer(address,uint256)` — 0xa9059cbb, the most transferred selector on earth. */
export const TRANSFER_SELECTOR = selectorOf('transfer(address,uint256)');

function padLeft(hex: string, bytes = 32): string {
  const clean = hex.replace(/^0x/, '').toLowerCase();
  if (clean.length > bytes * 2) throw new AbiError(`Value too long for ${bytes} bytes: ${hex}`);
  return clean.padStart(bytes * 2, '0');
}

/**
 * Encode `transfer(to, amount)`.
 *
 * The address is encoded as its 20-byte account hash, without TRON's 0x41
 * prefix — inside the EVM an address is 20 bytes, and including the prefix
 * would shift every byte and send the funds to an address nobody controls.
 */
export function encodeTransfer(toAddress: string, amountUnits: bigint): string {
  if (amountUnits <= 0n) throw new AbiError(`Transfer amount must be positive: ${amountUnits}`);
  if (amountUnits >= 2n ** 256n) throw new AbiError('Transfer amount exceeds uint256');

  // Throws on a bad checksum, which is the point: a mistyped payout address
  // must fail here rather than on chain.
  const decoded = decodeAddress(toAddress);
  const accountHash = bytesToHex(decoded.subarray(1));

  return TRANSFER_SELECTOR + padLeft(accountHash) + padLeft(amountUnits.toString(16));
}

/**
 * Read back what an encoded transfer says.
 * Used to re-check a transaction the node built before signing it.
 */
export function decodeTransfer(dataHex: string): { toAccountHash: string; amountUnits: bigint } {
  const clean = dataHex.replace(/^0x/, '').toLowerCase();
  if (!clean.startsWith(TRANSFER_SELECTOR)) {
    throw new AbiError('Call data is not a transfer(address,uint256)');
  }
  if (clean.length !== 8 + 64 + 64) {
    throw new AbiError(`Call data is ${clean.length} hex chars, expected 136`);
  }

  const toWord = clean.slice(8, 8 + 64);
  if (!/^0{24}/.test(toWord)) {
    throw new AbiError('Recipient word has non-zero padding; it is not an address');
  }

  return {
    toAccountHash: toWord.slice(24),
    amountUnits: BigInt(`0x${clean.slice(8 + 64)}`),
  };
}
