/**
 * A small HTTP client for a TRON full node.
 *
 * Deliberately thin. The indexer needs three calls, and a general-purpose
 * library would bring a large dependency into the one process that must keep
 * running unattended for months.
 *
 * Every call has a timeout and bounded retries. A public RPC endpoint will
 * time out, rate limit, and occasionally return HTML from a proxy — none of
 * which should stop the indexer, and all of which must be distinguishable from
 * "this block genuinely has no transactions".
 */

import type { RawTransaction, RawTransactionInfo } from './types.ts';
import { interpretEstimate, decodeHexMessage, type EstimateResult, type RawEstimate } from './estimate.ts';

export class TronError extends Error {
  override readonly name = 'TronError';
  readonly retriable: boolean;
  constructor(message: string, retriable: boolean) {
    super(message);
    this.retriable = retriable;
  }
}

export interface TronClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly apiKey?: string | undefined;
}

export interface BlockHeader {
  readonly number: number;
  readonly timestamp: Date;
}

export interface Block extends BlockHeader {
  readonly transactions: readonly RawTransaction[];
}

interface RawBlock {
  block_header?: { raw_data?: { number?: number; timestamp?: number } };
  transactions?: RawTransaction[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class TronClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #apiKey: string | undefined;

  constructor(options: TronClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxAttempts = options.maxAttempts ?? 4;
    this.#apiKey = options.apiKey;
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

      try {
        const response = await fetch(`${this.#baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.#apiKey === undefined ? {} : { 'TRON-PRO-API-KEY': this.#apiKey }),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          // 429 and 5xx are the endpoint's problem and will likely pass.
          const retriable = response.status === 429 || response.status >= 500;
          throw new TronError(`${path} returned HTTP ${response.status}`, retriable);
        }

        const text = await response.text();
        try {
          return JSON.parse(text) as T;
        } catch {
          // A proxy error page rather than JSON. Worth retrying.
          throw new TronError(`${path} returned non-JSON: ${text.slice(0, 120)}`, true);
        }
      } catch (error) {
        lastError = error;
        const retriable = error instanceof TronError ? error.retriable : true;
        if (!retriable || attempt === this.#maxAttempts) break;
        // 0.5s, 1s, 2s — long enough to clear a rate limit, short enough that
        // the indexer does not fall far behind the head.
        await sleep(500 * 2 ** (attempt - 1));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new TronError(`${path} failed: ${String(lastError)}`, false);
  }

  /** The current chain head. */
  async getHead(): Promise<BlockHeader> {
    const raw = await this.#post<RawBlock>('/wallet/getnowblock', {});
    return parseHeader(raw);
  }

  /** A block with its transaction bodies — this is where native TRX transfers live. */
  async getBlock(number: number): Promise<Block> {
    const raw = await this.#post<RawBlock>('/wallet/getblockbynum', { num: number });
    const header = parseHeader(raw);
    return { ...header, transactions: raw.transactions ?? [] };
  }

  /**
   * Execution results for every transaction in a block, including event logs.
   * One call per block rather than one per transaction, which is the
   * difference between keeping up with the chain and not.
   */
  async getBlockTransactionInfo(number: number): Promise<RawTransactionInfo[]> {
    const raw = await this.#post<RawTransactionInfo[] | Record<string, unknown>>(
      '/wallet/gettransactioninfobyblocknum',
      { num: number },
    );
    // An empty block returns {} rather than [].
    return Array.isArray(raw) ? raw : [];
  }

/**
   * One transaction's receipt, or null if the node does not know it.
   *
   * `solidified` asks the solidity node instead, which only reports
   * transactions in blocks the network has irreversibly confirmed. That is the
   * answer to "may I book this as done"; the ordinary node's answer is only
   * "has this landed in a block that could still be orphaned".
   */
  async getTransactionInfo(
    txHash: string,
    options: { solidified?: boolean } = {},
  ): Promise<RawTransactionInfo | null> {
    const path = options.solidified === true
      ? '/walletsolidity/gettransactioninfobyid'
      : '/wallet/gettransactioninfobyid';
    const raw = await this.#post<RawTransactionInfo>(path, {
      value: txHash,
    });
    // An unknown or pending transaction comes back as {}.
    return typeof raw.id === 'string' ? raw : null;
  }

  /**
   * Current resource prices.
   *
   * Read from the chain rather than configured, because these are governance
   * parameters: they differ between mainnet and testnet and change by vote.
   */
  async getChainPrices(): Promise<ChainPrices> {
    const raw = await this.#get<{ chainParameter?: { key?: string; value?: number }[] }>(
      '/wallet/getchainparameters',
    );

    const find = (key: string, fallback: bigint): bigint => {
      const entry = raw.chainParameter?.find((p) => p.key === key);
      return typeof entry?.value === 'number' ? BigInt(entry.value) : fallback;
    };

    return {
      energyFeeSun: find('getEnergyFee', 210n),
      bandwidthFeeSun: find('getTransactionFee', 1000n),
      newAccountFeeSun: find('getCreateNewAccountFeeInSystemContract', 1_000_000n),
    };
  }

  /**
   * Simulate the transfer without sending it.
   *
   * A reverting transfer still burns the fee limit, and finding out here costs
   * nothing. Interpreting the reply is delegated to `interpretEstimate`, which
   * is where the subtlety lives and where the tests are.
   */
  async estimateTransfer(input: BuildTransferInput): Promise<EstimateResult> {
    const raw = await this.#post<RawEstimate>('/wallet/triggerconstantcontract', {
      owner_address: input.ownerHex,
      contract_address: input.contractHex,
      function_selector: 'transfer(address,uint256)',
      parameter: input.parameterHex,
      call_value: 0,
    });
    return interpretEstimate(raw);
  }

/**
   * What an account holds and can spend without paying for resources.
   *
   * The hot wallet needs both halves checked before a payout: TRX to cover
   * whatever the network charges, and the energy it already has, which is
   * what decides how much of that charge there will be. A payout attempted
   * without enough of either fails on chain — after the fee is taken.
   */
  async getAccountState(addressHex: string): Promise<AccountState> {
    const [account, resources] = await Promise.all([
      this.#post<{ balance?: number }>('/wallet/getaccount', { address: addressHex }),
      this.#post<{ EnergyLimit?: number; EnergyUsed?: number; freeNetLimit?: number; freeNetUsed?: number }>(
        '/wallet/getaccountresource',
        { address: addressHex },
      ),
    ]);

    const energyAvailable = (resources.EnergyLimit ?? 0) - (resources.EnergyUsed ?? 0);
    const bandwidthAvailable = (resources.freeNetLimit ?? 0) - (resources.freeNetUsed ?? 0);

    return {
      // An account that has never received anything comes back as {}.
      trxSun: BigInt(account.balance ?? 0),
      energyAvailable: BigInt(Math.max(energyAvailable, 0)),
      freeBandwidthAvailable: BigInt(Math.max(bandwidthAvailable, 0)),
    };
  }


  /** TRC20 balance of an address, straight from the contract. */
  async readTokenBalance(contractHex: string, ownerHex: string): Promise<bigint> {
    const raw = await this.#post<{ constant_result?: string[]; result?: { result?: boolean } }>(
      '/wallet/triggerconstantcontract',
      {
        owner_address: ownerHex,
        contract_address: contractHex,
        function_selector: 'balanceOf(address)',
        parameter: ownerHex.slice(2).padStart(64, '0'),
        call_value: 0,
      },
    );

    const value = raw.constant_result?.[0];
    if (raw.result?.result !== true || value === undefined || value === '') {
      throw new TronError('Could not read the token balance', true);
    }
    return BigInt(`0x${value}`);
  }

  /**
   * Ask the node to build the transaction.
   *
   * The node does the protobuf serialisation, which we deliberately do not
   * reimplement — but the caller must verify the result before signing it,
   * because a node is a remote service and a signature is irrevocable.
   */
  async buildTransfer(input: BuildTransferInput): Promise<RawTransaction> {
    const raw = await this.#post<{ transaction?: RawTransaction; result?: { message?: string } }>(
      '/wallet/triggersmartcontract',
      {
        owner_address: input.ownerHex,
        contract_address: input.contractHex,
        function_selector: 'transfer(address,uint256)',
        parameter: input.parameterHex,
        fee_limit: input.feeLimitSun,
        call_value: 0,
      },
    );

    if (raw.transaction === undefined) {
      throw new TronError(
        `Node refused to build the transfer: ${decodeHexMessage(raw.result?.message ?? '')}`,
        false,
      );
    }
    return raw.transaction;
  }

  /**
   * Hand a signed transaction to the network.
   *
   * Re-broadcasting bytes that were already accepted is safe and expected: the
   * network recognises the transaction id and reports a duplicate rather than
   * executing it twice. That is what makes a crash between signing and
   * broadcasting survivable, and why a duplicate counts as accepted here.
   */
  async broadcast(signed: unknown): Promise<{ accepted: boolean; code: string; message: string }> {
    const raw = await this.#post<{ result?: boolean; code?: string; message?: string }>(
      '/wallet/broadcasttransaction',
      signed,
    );

    const code = raw.code ?? (raw.result === true ? 'SUCCESS' : 'UNKNOWN');
    return {
      accepted: raw.result === true || code === 'DUP_TRANSACTION_ERROR',
      code,
      message: decodeHexMessage(raw.message ?? ''),
    };
  }

  async #get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      headers: this.#apiKey === undefined ? {} : { 'TRON-PRO-API-KEY': this.#apiKey },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new TronError(`${path} returned HTTP ${response.status}`, true);
    return (await response.json()) as T;
  }
}

function parseHeader(raw: RawBlock): BlockHeader {
  const number = raw.block_header?.raw_data?.number;
  const timestamp = raw.block_header?.raw_data?.timestamp;
  if (typeof number !== 'number') {
    throw new TronError('Block response has no block number', false);
  }
  return {
    number,
    // The genesis block has no timestamp field; nothing else should reach here.
    timestamp: new Date(typeof timestamp === 'number' ? timestamp : 0),
  };
}


/** Network resource prices, set by governance vote rather than by us. */
export interface ChainPrices {
  readonly energyFeeSun: bigint;
  readonly bandwidthFeeSun: bigint;
  readonly newAccountFeeSun: bigint;
}

export interface BuildTransferInput {
  /** 21-byte chain hex, 0x41 prefixed. */
  readonly ownerHex: string;
  readonly contractHex: string;
  /** ABI arguments without the four-byte selector. */
  readonly parameterHex: string;
  /** Ceiling on what the network may charge, in sun. */
  readonly feeLimitSun: number;
}

export interface AccountState {
  readonly trxSun: bigint;
  /** Energy the account can spend right now, staked or delegated to it. */
  readonly energyAvailable: bigint;
  /** What is left of today's free bandwidth allowance. */
  readonly freeBandwidthAvailable: bigint;
}
