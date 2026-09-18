/**
 * The master mnemonic, encrypted under a passphrase.
 *
 * On a server we do not physically control, the mnemonic must not sit on disk
 * in the clear: a disk image, a backup, a copied .env and it is gone, and with
 * it every deposit address and the hot wallet. So the server keeps only this
 * file, and the passphrase that opens it is typed in after each start and
 * never written down on the machine.
 *
 * What this does not do is protect a running server from whoever controls its
 * memory. Nothing on the machine can. That is why the treasury key is never on
 * the server at all, and why the hot wallet holds only a working float.
 *
 * Format: scrypt turns the passphrase into a key; AES-256-GCM encrypts the
 * mnemonic. The public facts stored beside it — which deposit addresses and
 * which hot wallet this mnemonic yields — are bound into the authentication
 * tag, so they cannot be swapped for another keystore's without the file
 * failing to open.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, type BinaryLike, type ScryptOptions } from 'node:crypto';

import { assertValidMnemonic, DepositWallet, WalletError } from './address.ts';
import { deriveHotWallet, USER_ACCOUNT } from './operational.ts';

export class KeystoreError extends WalletError {}

export const KEYSTORE_VERSION = 1;

/** 2^17 × r=8 is 128 MiB of memory per guess, about a second on a small server. */
const DEFAULT_COST = 2 ** 17;
const MIN_COST = 2 ** 15;
const MAX_COST = 2 ** 20;

export interface Keystore {
  readonly version: number;
  readonly kdf: { readonly name: 'scrypt'; readonly n: number; readonly r: number; readonly p: number; readonly salt: string };
  readonly cipher: { readonly name: 'aes-256-gcm'; readonly iv: string; readonly tag: string };
  readonly ciphertext: string;
  /** Account-level extended public key the deposit addresses come from. */
  readonly depositXpub: string;
  /** The hot wallet address this mnemonic signs for. */
  readonly hotWallet: string;
}

function scrypt(password: BinaryLike, salt: BinaryLike, length: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function deriveKey(passphrase: string, kdf: Keystore['kdf']): Promise<Buffer> {
  return scrypt(passphrase.normalize('NFKC'), Buffer.from(kdf.salt, 'base64'), 32, {
    N: kdf.n, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.n * kdf.r * 2,
  });
}

/** Everything but the secret, in a fixed order: what the tag vouches for. */
function header(ks: Pick<Keystore, 'version' | 'kdf' | 'depositXpub' | 'hotWallet'>): Buffer {
  return Buffer.from(JSON.stringify([ks.version, ks.kdf.name, ks.kdf.n, ks.kdf.r, ks.kdf.p, ks.kdf.salt, ks.depositXpub, ks.hotWallet]));
}

export async function sealMnemonic(mnemonic: string, passphrase: string, options: { cost?: number } = {}): Promise<Keystore> {
  const phrase = mnemonic.trim();
  assertValidMnemonic(phrase);
  if (passphrase.length < 16) throw new KeystoreError('Use a passphrase of at least 16 characters');

  const wallet = DepositWallet.fromMnemonic(phrase, { account: USER_ACCOUNT });
  const hot = deriveHotWallet(phrase);
  const kdf = { name: 'scrypt' as const, n: options.cost ?? DEFAULT_COST, r: 8, p: 1, salt: randomBytes(16).toString('base64') };
  const base = { version: KEYSTORE_VERSION, kdf, depositXpub: wallet.accountXpub(), hotWallet: hot.address };
  wallet.wipe();
  hot.privateKey.fill(0);

  const key = await deriveKey(passphrase, kdf);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header(base));
  const ciphertext = Buffer.concat([cipher.update(phrase, 'utf8'), cipher.final()]);
  key.fill(0);

  return Object.freeze({
    ...base,
    cipher: { name: 'aes-256-gcm' as const, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    ciphertext: ciphertext.toString('base64'),
  });
}

/** Parse a keystore file, refusing anything malformed or with parameters outside sane bounds. */
export function parseKeystore(text: string): Keystore {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new KeystoreError('Keystore file is not valid JSON');
  }
  const ks = raw as Partial<Keystore> | null;
  const kdf = ks?.kdf;
  const cipher = ks?.cipher;
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

  if (ks?.version !== KEYSTORE_VERSION) throw new KeystoreError('Unsupported keystore version');
  if (kdf?.name !== 'scrypt' || !str(kdf.salt) || kdf.r !== 8 || kdf.p !== 1) throw new KeystoreError('Unsupported key derivation settings');
  // Bounds both ways: too cheap is a weak file, too dear is a file built to
  // exhaust the memory of whoever opens it.
  if (!Number.isInteger(kdf.n) || kdf.n < MIN_COST || kdf.n > MAX_COST || (kdf.n & (kdf.n - 1)) !== 0) {
    throw new KeystoreError('Key derivation cost out of bounds');
  }
  if (cipher?.name !== 'aes-256-gcm' || !str(cipher.iv) || !str(cipher.tag) || !str(ks.ciphertext)) {
    throw new KeystoreError('Unsupported cipher settings');
  }
  if (!str(ks.depositXpub) || !str(ks.hotWallet)) throw new KeystoreError('Keystore is missing its public keys');

  return Object.freeze({
    version: ks.version,
    kdf: Object.freeze({ name: kdf.name, n: kdf.n, r: kdf.r, p: kdf.p, salt: kdf.salt }),
    cipher: Object.freeze({ name: cipher.name, iv: cipher.iv, tag: cipher.tag }),
    ciphertext: ks.ciphertext,
    depositXpub: ks.depositXpub,
    hotWallet: ks.hotWallet,
  });
}

export function serializeKeystore(ks: Keystore): string {
  return JSON.stringify(ks, null, 2) + '\n';
}

/**
 * The mnemonic, or an error that says the same thing whether the passphrase
 * was wrong or the file was tampered with — GCM cannot tell them apart, and
 * neither should the message.
 */
export async function openKeystore(ks: Keystore, passphrase: string): Promise<string> {
  const key = await deriveKey(passphrase, ks.kdf);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ks.cipher.iv, 'base64'));
    decipher.setAAD(header(ks));
    decipher.setAuthTag(Buffer.from(ks.cipher.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ks.ciphertext, 'base64')), decipher.final()]);
    const mnemonic = plain.toString('utf8');
    plain.fill(0);
    return mnemonic;
  } catch {
    throw new KeystoreError('Wrong passphrase, or the keystore file was altered');
  } finally {
    key.fill(0);
  }
}
