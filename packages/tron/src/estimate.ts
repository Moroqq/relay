/**
 * Reading a contract simulation's answer.
 *
 * Separated from the HTTP call so it can be tested against captured responses
 * without a network, because the interpretation is where the money is lost.
 *
 * The trap: a TRON node answers `result.result === true` to mean "the
 * simulation ran to completion", NOT "the call would succeed". A transfer that
 * reverts for insufficient balance comes back with result true, a `message` of
 * "REVERT opcode executed", an energy figure far too small to be a real
 * transfer, and an empty `constant_result`. Code that reads only the boolean
 * will happily broadcast transactions that revert on chain and burn the fee
 * limit on every one.
 */

export interface RawEstimate {
  readonly energy_used?: number;
  readonly constant_result?: readonly string[];
  readonly result?: { readonly result?: boolean; readonly message?: string };
}

export interface EstimateResult {
  readonly energyUsed: bigint;
  /** True only when the call ran, did not revert, and returned boolean true. */
  readonly willSucceed: boolean;
  readonly message: string | undefined;
}

/** Node error messages arrive hex-encoded more often than not. */
export function decodeHexMessage(message: string): string {
  if (message === '' || !/^[0-9a-fA-F]+$/.test(message) || message.length % 2 !== 0) {
    return message;
  }
  try {
    return Buffer.from(message, 'hex').toString('utf8');
  } catch {
    return message;
  }
}

/** A 32-byte word that is all zeroes but for a final 1 — Solidity's `true`. */
const SOLIDITY_TRUE = /^0{63}1$/;

export function interpretEstimate(raw: RawEstimate): EstimateResult {
  const ran = raw.result?.result === true;
  const message = raw.result?.message;
  const reverted = message !== undefined && message !== '';
  const returned = raw.constant_result?.[0] ?? '';
  const returnedTrue = SOLIDITY_TRUE.test(returned);

  return Object.freeze({
    energyUsed: BigInt(raw.energy_used ?? 0),
    willSucceed: ran && !reverted && returnedTrue,
    message: reverted
      ? decodeHexMessage(message)
      : returnedTrue
        ? undefined
        : `contract returned ${returned === '' ? 'nothing' : returned}`,
  });
}
