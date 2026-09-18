/**
 * TRON address derivation.
 *
 * A deposit address is derived, never stored as a secret. One master mnemonic
 * produces an unlimited supply of addresses along BIP44 path
 * `m/44'/195'/account'/0/index`, where 195 is TRON's registered coin type.
 * Losing the database costs us bookkeeping; losing the mnemonic costs us every
 * address at once — which is why the mnemonic belongs in a KMS in production
 * and never in this repository.
 *
 * The address itself is built the same way Ethereum builds one — keccak256 of
 * the uncompressed public key, last 20 bytes — then given TRON's 0x41 prefix
 * and Base58Check encoding. That shared lineage is what the tests exploit to
 * verify this pipeline against a public Ethereum vector.
 */

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic, generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58check } from '@scure/base';

/** TRON's registered SLIP-44 coin type. */
export const TRON_COIN_TYPE = 195;

/** Every mainnet and testnet TRON address starts with this byte, rendering as "T". */
export const TRON_ADDRESS_PREFIX = 0x41;

const b58check = base58check(sha256);

export class WalletError extends Error {
  override readonly name = 'WalletError';
}

/** Generate a fresh 24-word master mnemonic (256 bits of entropy). */
export function newMnemonic(): string {
  return generateMnemonic(wordlist, 256);
}

export function assertValidMnemonic(mnemonic: string): void {
  if (!validateMnemonic(mnemonic.trim(), wordlist)) {
    throw new WalletError('Invalid BIP39 mnemonic: checksum or wordlist mismatch');
  }
}

/**
 * Convert a raw 20-byte account hash into a `T...` address.
 * Exported because the indexer needs it to turn on-chain hex addresses,
 * which TRON returns 0x41-prefixed, back into the form merchants see.
 */
export function encodeAddress(accountHash20: Uint8Array): string {
  if (accountHash20.length !== 20) {
    throw new WalletError(`Account hash must be 20 bytes, got ${accountHash20.length}`);
  }
  const payload = new Uint8Array(21);
  payload[0] = TRON_ADDRESS_PREFIX;
  payload.set(accountHash20, 1);
  return b58check.encode(payload);
}

/**
 * Decode a `T...` address back to its 21 raw bytes (prefix included).
 * Throws on a bad checksum, which is the whole point: a mistyped payout
 * address must fail here rather than on-chain, where the funds are gone.
 */
export function decodeAddress(address: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = b58check.decode(address);
  } catch {
    throw new WalletError(`Invalid TRON address "${address}": bad Base58Check checksum`);
  }
  if (decoded.length !== 21 || decoded[0] !== TRON_ADDRESS_PREFIX) {
    throw new WalletError(`Invalid TRON address "${address}": wrong prefix or length`);
  }
  return decoded;
}

export function isValidAddress(address: string): boolean {
  try {
    decodeAddress(address);
    return true;
  } catch {
    return false;
  }
}

/** Derive the TRON address for a secp256k1 private key. */
export function addressFromPrivateKey(privateKey: Uint8Array): string {
  return addressFromPublicKey(secp256k1.getPublicKey(privateKey, false));
}

/** Derive the TRON address for a secp256k1 public key, compressed or not. */
export function addressFromPublicKey(publicKey: Uint8Array): string {
  // Uncompressed public key is 65 bytes: a 0x04 tag followed by X and Y.
  // The hash covers X||Y only, so the tag is dropped.
  const uncompressed = publicKey.length === 65 ? publicKey : secp256k1.Point.fromHex(publicKey).toBytes(false);
  const hashed = keccak_256(uncompressed.subarray(1));
  return encodeAddress(hashed.subarray(12));
}

/** Anything that can hand out deposit addresses: the full wallet, or its public half. */
export interface AddressSource {
  deriveAddress(index: number): DerivedAddress;
}

export interface DerivedAddress {
  /** BIP44 path this address came from — enough to re-derive it from the mnemonic alone. */
  readonly path: string;
  readonly index: number;
  readonly address: string;
}

/**
 * A master key held in memory for the life of the process.
 *
 * Private keys are derived on demand and returned to the caller rather than
 * cached, so that the only long-lived secret is the seed itself.
 */
export class DepositWallet implements AddressSource {
  readonly #master: HDKey;
  readonly #account: number;

  private constructor(master: HDKey, account: number) {
    this.#master = master;
    this.#account = account;
  }

  static fromMnemonic(mnemonic: string, options: { account?: number; passphrase?: string } = {}): DepositWallet {
    const trimmed = mnemonic.trim();
    assertValidMnemonic(trimmed);
    const seed = mnemonicToSeedSync(trimmed, options.passphrase ?? '');
    const master = HDKey.fromMasterSeed(seed);
    seed.fill(0); // the master key is all that is needed from here on
    return new DepositWallet(master, options.account ?? 0);
  }

  /** `m/44'/195'/account'/0/index` */
  pathFor(index: number): string {
    return pathFor(this.#account, index);
  }

  /**
   * The account's extended public key, `m/44'/195'/account'`. Enough to
   * derive every deposit address of the account and nothing to spend from
   * them — what a service that only hands out addresses should hold.
   */
  accountXpub(): string {
    return this.#master.derive(`m/44'/${TRON_COIN_TYPE}'/${this.#account}'`).publicExtendedKey;
  }

  /** Overwrite the key material this object holds. It cannot be used afterwards. */
  wipe(): void {
    this.#master.wipePrivateData();
  }

  deriveAddress(index: number): DerivedAddress {
    const path = this.pathFor(index);
    const node = this.#master.derive(path);
    if (node.privateKey === null) {
      throw new WalletError(`Derivation produced no private key at ${path}`);
    }
    return Object.freeze({ path, index, address: addressFromPrivateKey(node.privateKey) });
  }

  /**
   * The private key for a derived address, needed only when sweeping funds off
   * it. Callers must not persist the result.
   */
  derivePrivateKey(index: number): Uint8Array {
    const path = this.pathFor(index);
    const node = this.#master.derive(path);
    if (node.privateKey === null) {
      throw new WalletError(`Derivation produced no private key at ${path}`);
    }
    return node.privateKey;
  }
}

/** `m/44'/195'/account'/0/index` */
function pathFor(account: number, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) {
    throw new WalletError(`Address index must be a non-negative 31-bit integer, got ${index}`);
  }
  return `m/44'/${TRON_COIN_TYPE}'/${account}'/0/${index}`;
}

const HARDENED = 2 ** 31;

/**
 * Deposit addresses from the account's extended public key alone.
 *
 * Gives exactly the addresses the full wallet gives, and cannot sign for any
 * of them. The merchant API holds this rather than the mnemonic: it is the
 * most exposed service there is, and handing out addresses is all it does.
 *
 * One caution that comes with any extended public key: together with the
 * private key of a single address under it, it yields the private keys of all
 * of them. It is not a secret the way the mnemonic is, but it is not public
 * either.
 */
export class DepositAddresses implements AddressSource {
  readonly #account: HDKey;
  readonly #accountIndex: number;

  private constructor(account: HDKey, accountIndex: number) {
    this.#account = account;
    this.#accountIndex = accountIndex;
  }

  static fromXpub(xpub: string): DepositAddresses {
    let key: HDKey;
    try {
      key = HDKey.fromExtendedKey(xpub.trim());
    } catch {
      throw new WalletError('Not a valid extended public key');
    }
    if (key.privateKey !== null) {
      // Someone pasted the private half. Refuse it rather than quietly hold a
      // key that can spend from every address.
      throw new WalletError('That is an extended PRIVATE key. Give this service the public one (xpub…) only.');
    }
    if (key.depth !== 3 || key.index < HARDENED) {
      throw new WalletError(`Expected the account-level key m/44'/${TRON_COIN_TYPE}'/account' (depth 3), got depth ${key.depth}`);
    }
    return new DepositAddresses(key, key.index - HARDENED);
  }

  get xpub(): string {
    return this.#account.publicExtendedKey;
  }

  deriveAddress(index: number): DerivedAddress {
    const path = pathFor(this.#accountIndex, index);
    const node = this.#account.deriveChild(0).deriveChild(index);
    if (node.publicKey === null) {
      throw new WalletError(`Derivation produced no public key at ${path}`);
    }
    return Object.freeze({ path, index, address: addressFromPublicKey(node.publicKey) });
  }
}
