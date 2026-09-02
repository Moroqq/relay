/**
 * Money.
 *
 * Every amount in Relay is a `bigint` counted in the asset's smallest
 * indivisible unit — never a JavaScript number. `0.1 + 0.2 !== 0.3` in
 * floating point, and on a payment rail that difference is somebody's money.
 *
 * USDT (TRC20) and TRX both use 6 decimals, so 1 USDT === 1_000_000n units.
 * We still key the scale off the asset rather than hardcoding 6, because the
 * day a 18-decimal asset is added is the day a hardcoded 6 loses funds.
 */

export const ASSETS = ['USDT', 'TRX'] as const;
export type Asset = (typeof ASSETS)[number];

/** Decimal places for each supported asset. */
export const DECIMALS: Readonly<Record<Asset, number>> = Object.freeze({
  USDT: 6,
  TRX: 6,
});

export function isAsset(value: unknown): value is Asset {
  return typeof value === 'string' && (ASSETS as readonly string[]).includes(value);
}

/** 10n ** decimals for the asset — the number of base units in one whole coin. */
export function unitScale(asset: Asset): bigint {
  return 10n ** BigInt(DECIMALS[asset]);
}

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

/**
 * Parse a decimal string into base units.
 *
 * Deliberately strict — it accepts only what a human or an API client would
 * write on purpose, and rejects everything ambiguous:
 *
 *   parseAmount('480', 'USDT')       -> 480000000n
 *   parseAmount('288.4', 'USDT')     -> 288400000n
 *   parseAmount('0.000001', 'USDT')  -> 1n
 *   parseAmount('1e3', 'USDT')       -> throws (scientific notation)
 *   parseAmount('0.0000001', 'USDT') -> throws (more precision than the asset has)
 *   parseAmount('-5', 'USDT')        -> throws (negative)
 */
export function parseAmount(input: string, asset: Asset): bigint {
  if (typeof input !== 'string') {
    throw new MoneyError(`Amount must be a string, got ${typeof input}`);
  }

  const text = input.trim();
  if (text === '') throw new MoneyError('Amount is empty');

  // Digits, with at most one decimal point. No sign, no exponent, no spaces.
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new MoneyError(
      `Invalid amount "${input}": expected a plain decimal number such as "480" or "288.4"`,
    );
  }

  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  const decimals = DECIMALS[asset];

  if (fraction.length > decimals) {
    throw new MoneyError(
      `Amount "${input}" has ${fraction.length} decimal places but ${asset} supports only ${decimals}`,
    );
  }

  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

/**
 * Render base units as a decimal string.
 *
 * `trimTrailingZeros: false` (the default) keeps the asset's full precision,
 * which is what belongs in the database, in API responses and in signatures.
 * Pass `true` only for display.
 */
export function formatAmount(
  units: bigint,
  asset: Asset,
  options: { trimTrailingZeros?: boolean } = {},
): string {
  if (units < 0n) throw new MoneyError(`Amount cannot be negative: ${units}`);

  const decimals = DECIMALS[asset];
  const scale = unitScale(asset);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(decimals, '0');

  if (options.trimTrailingZeros === true) {
    const trimmed = fraction.replace(/0+$/, '');
    return trimmed === '' ? whole.toString() : `${whole}.${trimmed}`;
  }

  return `${whole}.${fraction}`;
}

/**
 * Multiply an amount by a rate in basis points (1 bp = 0.01%), rounding half up.
 *
 * Used for fees: `mulBps(480_000000n, 100n)` is 1% of 480 USDT = 4.80 USDT.
 *
 * Rounding is half-up and applied to the smallest unit, so the maximum error on
 * any single fee is half a millionth of a USDT. The direction is fixed and
 * documented rather than left to chance, because a fee that rounds one way in
 * the API and the other way in the ledger will not reconcile.
 */
export function mulBps(units: bigint, bps: bigint): bigint {
  if (units < 0n) throw new MoneyError(`Amount cannot be negative: ${units}`);
  if (bps < 0n) throw new MoneyError(`Rate cannot be negative: ${bps}`);

  const numerator = units * bps;
  const denominator = 10_000n;
  // Add half the denominator before flooring == round half up for non-negatives.
  return (numerator + denominator / 2n) / denominator;
}

/** Smallest of two amounts. */
export function minAmount(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
