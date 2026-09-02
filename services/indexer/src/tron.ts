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

import type { RawTransaction, RawTransactionInfo } from './decode.ts';

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
