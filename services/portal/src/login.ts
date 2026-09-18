/**
 * Signing a merchant in, and accepting an invitation.
 *
 * Sign-in follows the console exactly: every failure — no such address, wrong
 * password, wrong code, locked, disabled, not yet activated — gives the same
 * answer after about the same work, so nothing tells a guesser which part they
 * got right.
 */

import {
  decodeTotpSecret,
  decoyHash,
  hashPassword,
  newTotpSecret,
  open,
  otpauthUri,
  seal,
  verifyPassword,
  verifyTotp,
} from '@relay/auth';
import {
  acceptMerchantLogin,
  completeInvite,
  findMerchantUserByEmail,
  findMerchantUserById,
  findUsableInvite,
  recordMerchantFailedAttempt,
  setInvitePendingTotp,
  writeAudit,
  type InviteRecord,
  type MerchantUserRecord,
} from '@relay/db';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_SECONDS = 15 * 60;
export const MIN_PASSWORD_LENGTH = 12;

export type LoginResult = { readonly ok: true; readonly user: MerchantUserRecord } | { readonly ok: false };

export async function login(
  input: { email: string; password: string; code: string; ip: string | null; nowSeconds: number },
  secretKey: Buffer,
): Promise<LoginResult> {
  const user = await findMerchantUserByEmail(input.email);

  if (user === null || user.passwordHash === null || user.totpSecretSealed === null) {
    // Unknown address, or an account whose invitation was never accepted.
    await verifyPassword(input.password, await decoyHash());
    await writeAudit({ operatorId: null, merchantUserId: user?.id ?? null, action: 'merchant.login_failed', detail: { reason: user === null ? 'unknown_email' : 'not_activated' }, ip: input.ip });
    return { ok: false };
  }

  const fail = async (reason: string): Promise<LoginResult> => {
    await recordMerchantFailedAttempt(user.id, MAX_FAILED_ATTEMPTS, LOCK_SECONDS);
    await writeAudit({ operatorId: null, merchantUserId: user.id, action: 'merchant.login_failed', detail: { reason }, ip: input.ip });
    return { ok: false };
  };

  const locked = user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();
  if (user.status !== 'active' || user.merchantStatus !== 'active' || locked) {
    await verifyPassword(input.password, await decoyHash());
    await writeAudit({
      operatorId: null,
      merchantUserId: user.id,
      action: 'merchant.login_refused',
      detail: { reason: locked ? 'locked' : 'disabled' },
      ip: input.ip,
    });
    return { ok: false };
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) return fail('password');

  let key: Uint8Array;
  try {
    key = decodeTotpSecret(open(user.totpSecretSealed, secretKey));
  } catch {
    await writeAudit({ operatorId: null, merchantUserId: user.id, action: 'merchant.login_refused', detail: { reason: 'totp_unreadable' }, ip: input.ip });
    return { ok: false };
  }

  const check = verifyTotp(key, input.code, input.nowSeconds, user.totpLastCounter);
  if (!check.ok || check.counter === null) return fail('code');
  if (!(await acceptMerchantLogin(user.id, check.counter))) return fail('code_replayed');

  await writeAudit({ operatorId: null, merchantUserId: user.id, action: 'merchant.login_succeeded', ip: input.ip });
  return { ok: true, user };
}

/** What the invitation page shows before anything is set. */
export async function inspectInvite(tokenHash: string): Promise<InviteRecord | null> {
  return findUsableInvite(tokenHash);
}

/**
 * Offer a second-factor secret for the account. Asking again replaces it —
 * someone who closed the page before scanning the code can simply start over.
 */
export async function startInvite(tokenHash: string, secretKey: Buffer): Promise<{ secret: string; uri: string } | null> {
  const invite = await findUsableInvite(tokenHash);
  if (invite === null) return null;
  const secret = newTotpSecret();
  if (!(await setInvitePendingTotp(tokenHash, seal(secret, secretKey)))) return null;
  return { secret, uri: otpauthUri(secret, invite.email, 'Relay') };
}

export type CompleteResult =
  | { readonly ok: true; readonly user: MerchantUserRecord }
  | { readonly ok: false; readonly reason: 'invalid' | 'password' | 'code' };

/**
 * Finish the invitation: a code from the merchant's app proves it holds the
 * secret, and only then do the password and the secret become the account's.
 */
export async function completeInviteFlow(
  input: { tokenHash: string; password: string; code: string; ip: string | null; nowSeconds: number },
  secretKey: Buffer,
): Promise<CompleteResult> {
  if (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > 200) return { ok: false, reason: 'password' };

  const invite = await findUsableInvite(input.tokenHash);
  if (invite === null || invite.pendingTotpSealed === null) return { ok: false, reason: 'invalid' };

  let secret: string;
  try {
    secret = open(invite.pendingTotpSealed, secretKey);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const check = verifyTotp(decodeTotpSecret(secret), input.code, input.nowSeconds, null);
  if (!check.ok || check.counter === null) return { ok: false, reason: 'code' };

  const userId = await completeInvite({
    tokenHash: input.tokenHash,
    passwordHash: await hashPassword(input.password),
    totpSealed: seal(secret, secretKey),
    totpCounter: check.counter,
  });
  if (userId === null) return { ok: false, reason: 'invalid' };

  await writeAudit({ operatorId: null, merchantUserId: userId, action: 'merchant.invite_accepted', ip: input.ip });
  const user = await findMerchantUserById(userId);
  return user === null ? { ok: false, reason: 'invalid' } : { ok: true, user };
}
