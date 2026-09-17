/**
 * The TRX price, from WINkLink.
 *
 * WINkLink is TRON's own price oracle: independent nodes push prices on chain,
 * and contracts expose them through the same AggregatorV3Interface Chainlink
 * uses. We read the USDT/TRX pair — how many TRX one USDT is worth — because it
 * is a single read that means the same thing on mainnet and on Nile. Deriving
 * the rate from TRX/USD and USDT/USD would take two reads and a division to
 * reach the same number.
 *
 * Addresses come from the official table at doc.winklink.org/v2/doc/pricing.html
 * and were each checked on chain before being written here: every one is an
 * EACAggregatorProxy whose description() reads back "USDT/TRX". They are proxy
 * addresses, which is what WINkLink says to read from — the aggregator behind a
 * proxy can be replaced without the address changing.
 */

export const USDT_TRX_FEEDS = Object.freeze({
  mainnet: 'TUfV7S4RYtdmBvtHzedfFPVsK9nvndtETp',
  nile: 'TVZjuqiJNNuLQAQoPAFfUqvYUxhZYkUX5Z',
} as const);

/** What the feed must call itself, checked before a single price is trusted. */
export const USDT_TRX_DESCRIPTION = 'USDT/TRX';

/**
 * How old a price may be.
 *
 * WINkLink pushes USDT/TRX when it moves more than 1%, and otherwise at least
 * every 24 hours — its heartbeat, read off winklink.org/#/solutions. A day-old
 * price is therefore normal and means the market has not moved; WINkLink's own
 * guidance is that the limit must exceed the heartbeat. Two hours of slack
 * cover a slow update.
 */
export const DEFAULT_MAX_PRICE_AGE_SECONDS = 26 * 60 * 60;

/**
 * Bounds on USDT per TRX, in USDT base units, beyond which a reading is a bug
 * rather than a market.
 *
 * Deliberately far apart. They are not a view on where TRX should trade; they
 * exist to catch a decimals mistake or a misread word, which lands orders of
 * magnitude away. A bound tight enough to say something about the market would
 * one day refuse a real price.
 */
export const MIN_TRX_PRICE_UNITS = 100n; // 0.0001 USDT
export const MAX_TRX_PRICE_UNITS = 1_000_000_000n; // 1000 USDT

export interface RoundData {
  readonly roundId: bigint;
  readonly answer: bigint;
  readonly startedAt: bigint;
  readonly updatedAt: bigint;
  readonly answeredInRound: bigint;
}

export class OracleError extends Error {
  override readonly name = 'OracleError';
}

const word = (hex: string, index: number): string => hex.slice(index * 64, (index + 1) * 64);

/** latestRoundData() returns five 32-byte words; answer is a signed int256. */
export function decodeRoundData(hex: string): RoundData {
  const clean = hex.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length < 5 * 64) {
    throw new OracleError(`latestRoundData returned ${clean.length / 2} bytes, expected 160`);
  }

  const answerWord = BigInt(`0x${word(clean, 1)}`);
  const answer = answerWord >= 1n << 255n ? answerWord - (1n << 256n) : answerWord;

  return Object.freeze({
    roundId: BigInt(`0x${word(clean, 0)}`),
    answer,
    startedAt: BigInt(`0x${word(clean, 2)}`),
    updatedAt: BigInt(`0x${word(clean, 3)}`),
    answeredInRound: BigInt(`0x${word(clean, 4)}`),
  });
}

export function decodeUint(hex: string): bigint {
  const clean = hex.replace(/^0x/, '');
  if (clean.length === 0 || clean.length > 64 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new OracleError(`Not a uint256: "${hex}"`);
  }
  return BigInt(`0x${clean}`);
}

/** An ABI-encoded string: offset, length, then the bytes. */
export function decodeString(hex: string): string {
  const clean = hex.replace(/^0x/, '');
  if (clean.length < 2 * 64) throw new OracleError('String return value is too short');
  const length = Number(BigInt(`0x${word(clean, 1)}`));
  const bytes = clean.slice(2 * 64, 2 * 64 + length * 2);
  if (bytes.length !== length * 2) throw new OracleError('String return value is truncated');
  return Buffer.from(bytes, 'hex').toString('utf8');
}

export type PriceVerdict =
  | { readonly ok: true; readonly trxPriceUnits: bigint; readonly ageSeconds: number }
  | { readonly ok: false; readonly reason: string };

export interface ValidationOptions {
  readonly nowSeconds: number;
  readonly decimals: number;
  readonly maxAgeSeconds?: number;
}

/**
 * Turn a USDT/TRX round into USDT base units per one TRX, or refuse.
 *
 * Every refusal here leaves money where it is rather than moving it on a wrong
 * number: the price only decides whether a sweep is worth its fee, so a sweep
 * that waits for a trustworthy price loses nothing but time.
 */
export function priceFromRound(round: RoundData, options: ValidationOptions): PriceVerdict {
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_PRICE_AGE_SECONDS;
  const refuse = (reason: string): PriceVerdict => ({ ok: false, reason });

  if (round.answer <= 0n) return refuse(`oracle answer is ${round.answer}, not a price`);
  if (round.updatedAt === 0n) return refuse('oracle round has never been updated');

  // A round answered in an earlier round than it claims to be is a carried-over
  // value, not a fresh one — the Chainlink interface's way of saying "stale".
  if (round.answeredInRound < round.roundId) {
    return refuse(`round ${round.roundId} was answered in earlier round ${round.answeredInRound}`);
  }

  const age = options.nowSeconds - Number(round.updatedAt);
  // A price from the future means one of the two clocks is wrong, and there is
  // no telling which.
  if (age < -300) return refuse(`oracle price is timestamped ${-age}s in the future`);
  if (age > maxAge) {
    return refuse(`oracle price is ${Math.round(age / 3600)}h old, limit is ${Math.round(maxAge / 3600)}h`);
  }

  if (!Number.isInteger(options.decimals) || options.decimals < 0 || options.decimals > 36) {
    return refuse(`oracle reports ${options.decimals} decimals`);
  }

  // The feed says how many TRX one USDT buys, scaled by 10^decimals. We want
  // the inverse, in USDT base units (six decimals):
  //
  //     units per TRX = 10^6 · 10^decimals / answer
  //
  // Rounded up. The figure only ever converts a TRX fee into USDT, so rounding
  // up overstates that cost by at most a millionth of a USDT — and an error in
  // that direction refuses a marginal sweep rather than approving one.
  const numerator = 1_000_000n * 10n ** BigInt(options.decimals);
  const trxPriceUnits = (numerator + round.answer - 1n) / round.answer;

  if (trxPriceUnits < MIN_TRX_PRICE_UNITS || trxPriceUnits > MAX_TRX_PRICE_UNITS) {
    return refuse(`derived TRX price of ${trxPriceUnits} units is outside any plausible market`);
  }

  return { ok: true, trxPriceUnits, ageSeconds: Math.max(age, 0) };
}
