/**
 * The signing keys, and whether we have them.
 *
 * With a keystore the sweeper starts locked. It keeps reconciling what is
 * already on chain, but signs nothing — no sweeps, no payouts — until an
 * operator unlocks it with the passphrase. Deposits keep being credited
 * meanwhile: that is the indexer and the API, and neither holds a key.
 */

import { DepositWallet, deriveHotWallet, openKeystore, USER_ACCOUNT } from '@relay/wallet';

import type { KeySource, SigningKeys, SweeperSettings } from './config.ts';

export type KeyState = 'locked' | 'unlocked';

/**
 * Derive the keys and check them against what this deployment is configured
 * to watch.
 *
 * The indexer and the API know the hot wallet and the deposit addresses only
 * by their public forms, configured separately. If the mnemonic disagrees with
 * either, one of them is wrong, and refusing is the only safe answer: carrying
 * on would sign from wallets the books are not watching.
 */
export function checkKeys(mnemonic: string, settings: Pick<SweeperSettings, 'hotWalletAddress' | 'depositXpub'>): SigningKeys {
  const wallet = DepositWallet.fromMnemonic(mnemonic, { account: USER_ACCOUNT });
  const hotWallet = deriveHotWallet(mnemonic);
  const wipe = () => { wallet.wipe(); hotWallet.privateKey.fill(0); };

  if (hotWallet.address !== settings.hotWalletAddress) {
    const derived = hotWallet.address;
    wipe();
    throw new Error('This mnemonic signs for hot wallet ' + derived + ' but HOT_WALLET_ADDRESS is ' + settings.hotWalletAddress + '.');
  }
  if (wallet.accountXpub() !== settings.depositXpub) {
    wipe();
    throw new Error('This mnemonic derives different deposit addresses than DEPOSIT_XPUB describes.');
  }
  return Object.freeze({ wallet, hotWallet });
}

export class KeyHolder {
  readonly #settings: Pick<SweeperSettings, 'hotWalletAddress' | 'depositXpub'>;
  readonly #source: KeySource;
  #keys: SigningKeys | null = null;
  #busy = false;

  constructor(settings: Pick<SweeperSettings, 'hotWalletAddress' | 'depositXpub'>, source: KeySource) {
    this.#settings = settings;
    this.#source = source;
    // Development: the mnemonic is right there, so there is nothing to wait for.
    if (source.kind === 'environment') this.#keys = checkKeys(source.mnemonic, settings);
  }

  get state(): KeyState {
    return this.#keys === null ? 'locked' : 'unlocked';
  }

  /** The keys, or null while locked. Read once per pass, not held across passes. */
  get keys(): SigningKeys | null {
    return this.#keys;
  }

  async unlock(passphrase: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.#source.kind !== 'keystore') return { ok: false, reason: 'Keys come from the environment; there is nothing to unlock' };
    if (this.#keys !== null) return { ok: true };
    if (this.#busy) return { ok: false, reason: 'An unlock is already in progress' };
    this.#busy = true;
    try {
      const mnemonic = await openKeystore(this.#source.keystore, passphrase);
      this.#keys = checkKeys(mnemonic, this.#settings);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Forget the keys. Anything signing at this moment fails and is retried
   * after the next unlock; nothing half-done is left behind, because a
   * transaction is only recorded once it is signed.
   */
  lock(): void {
    const keys = this.#keys;
    this.#keys = null;
    if (keys !== null) {
      keys.wallet.wipe();
      keys.hotWallet.privateKey.fill(0);
    }
  }
}
