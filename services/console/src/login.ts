/**
 * Signing an operator in.
 *
 * Every failure — no such address, wrong password, wrong code, locked, disabled
 * — produces the same answer and takes about the same time. Anything more
 * specific tells whoever is guessing which of those they got right.
 */

import {
  decodeTotpSecret,
  decoyHash,
  open,
  verifyPassword,
  verifyTotp,
} from '@relay/auth';
import {
  acceptLogin,
  acceptPasswordLogin,
  findOperatorByEmail,
  recordFailedAttempt,
  writeAudit,
  type OperatorRecord,
} from '@relay/db';

/** Consecutive failures before an account locks, and for how long. */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_SECONDS = 15 * 60;

export type LoginResult =
  | { readonly ok: true; readonly operator: OperatorRecord }
  | { readonly ok: false };

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly code: string;
  /** False only in local development: the password alone signs in. */
  readonly requireCode: boolean;
  readonly ip: string | null;
  readonly nowSeconds: number;
}

export async function login(input: LoginInput, secretKey: Buffer): Promise<LoginResult> {
  const operator = await findOperatorByEmail(input.email);

  if (operator === null) {
    // Pay for one derivation anyway, so an unknown address is not answered
    // faster than a known one.
    await verifyPassword(input.password, await decoyHash());
    await writeAudit({ operatorId: null, action: 'login.failed', detail: { reason: 'unknown_email' }, ip: input.ip });
    return { ok: false };
  }

  const fail = async (reason: string): Promise<LoginResult> => {
    await recordFailedAttempt(operator.id, MAX_FAILED_ATTEMPTS, LOCK_SECONDS);
    await writeAudit({ operatorId: operator.id, action: 'login.failed', detail: { reason }, ip: input.ip });
    return { ok: false };
  };

  // A locked or disabled account is refused before its password is checked,
  // so a lock actually stops guessing rather than merely hiding the result —
  // but the same work is still done, so the response does not reveal the lock.
  if (operator.status !== 'active' || (operator.lockedUntil !== null && operator.lockedUntil.getTime() > Date.now())) {
    await verifyPassword(input.password, await decoyHash());
    await writeAudit({
      operatorId: operator.id,
      action: 'login.refused',
      detail: { reason: operator.status !== 'active' ? 'disabled' : 'locked' },
      ip: input.ip,
    });
    return { ok: false };
  }

  if (!(await verifyPassword(input.password, operator.passwordHash))) return fail('password');

  if (!input.requireCode) {
    await acceptPasswordLogin(operator.id);
    await writeAudit({ operatorId: operator.id, action: 'login.succeeded', detail: { code: 'not_required' }, ip: input.ip });
    return { ok: true, operator };
  }

  let key: Uint8Array;
  try {
    key = decodeTotpSecret(open(operator.totpSecretSealed, secretKey));
  } catch {
    // The stored secret cannot be opened with this server's key — a key
    // mismatch after a deployment, most likely. Not the operator's fault, and
    // not something to count against them, but not a way in either.
    await writeAudit({ operatorId: operator.id, action: 'login.refused', detail: { reason: 'totp_unreadable' }, ip: input.ip });
    return { ok: false };
  }

  const check = verifyTotp(key, input.code, input.nowSeconds, operator.totpLastCounter);
  if (!check.ok || check.counter === null) return fail('code');

  // Conditional on the counter being newer, so two sign-ins racing with one
  // code cannot both succeed.
  if (!(await acceptLogin(operator.id, check.counter))) return fail('code_replayed');

  await writeAudit({ operatorId: operator.id, action: 'login.succeeded', ip: input.ip });
  return { ok: true, operator };
}
