/**
 * Wallets the platform operates, as opposed to wallets it hands to users.
 *
 * Both come from the same master mnemonic, on different BIP44 accounts:
 *
 *   m/44'/195'/0'/0/n   user deposit addresses, one per user, n from a sequence
 *   m/44'/195'/1'/0/0   the hot wallet payouts are sent from
 *
 * Separate accounts rather than a reserved index on account 0, so that no
 * value the deposit-address sequence could ever reach collides with an
 * operational key. A user being handed the hot wallet's address as their
 * deposit address would be quietly catastrophic.
 */

import { DepositWallet } from './address.ts';

export const USER_ACCOUNT = 0;
export const OPERATIONAL_ACCOUNT = 1;

/** Index of the hot wallet within the operational account. */
export const HOT_WALLET_INDEX = 0;

export interface OperationalKey {
  readonly address: string;
  readonly path: string;
  readonly privateKey: Uint8Array;
}

export function deriveHotWallet(mnemonic: string): OperationalKey {
  const wallet = DepositWallet.fromMnemonic(mnemonic, { account: OPERATIONAL_ACCOUNT });
  const derived = wallet.deriveAddress(HOT_WALLET_INDEX);
  const privateKey = wallet.derivePrivateKey(HOT_WALLET_INDEX);
  // The account key is not needed again; only the one key it yielded is.
  wallet.wipe();
  return Object.freeze({ address: derived.address, path: derived.path, privateKey });
}
