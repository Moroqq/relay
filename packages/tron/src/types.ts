/**
 * The shapes a TRON node returns.
 *
 * Every field is optional and every consumer checks: this is data from a
 * remote service, and a node that is out of date, rate limiting, or simply
 * wrong must produce a skipped record rather than a crash.
 */

export interface RawLog {
  readonly address?: string;
  readonly topics?: readonly string[];
  readonly data?: string;
}

export interface RawTransaction {
  readonly txID?: string;
  readonly ret?: readonly { contractRet?: string }[];
  readonly raw_data?: {
    readonly contract?: readonly {
      readonly type?: string;
      readonly parameter?: { readonly value?: Record<string, unknown> };
    }[];
  };
  readonly raw_data_hex?: string;
  readonly signature?: readonly string[];
}

export interface RawTransactionInfo {
  readonly id?: string;
  readonly receipt?: {
    readonly result?: string;
    readonly energy_usage_total?: number;
    readonly net_usage?: number;
  };
  readonly fee?: number;
  readonly blockNumber?: number;
  readonly log?: readonly RawLog[];
}
