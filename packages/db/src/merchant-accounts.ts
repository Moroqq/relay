/**
 * Merchant accounts: invitations, sign-in, sessions, and what a signed-in
 * merchant may change about their own projects.
 *
 * Like operators.ts, this stores and reads and makes the updates that must be
 * atomic. The decisions live in the portal service.
 */

import { hashApiKey, newApiKey } from '@relay/core';

import { getPool, inTransaction } from './pool.ts';
import { findProject, type ProjectRecord } from './projects.ts';

export interface MerchantUserRecord {
  readonly id: string;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly merchantStatus: string;
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string | null;
  readonly totpSecretSealed: string | null;
  readonly totpLastCounter: bigint | null;
  readonly status: 'invited' | 'active' | 'disabled';
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
  readonly lastLoginAt: Date | null;
}

const USER_SELECT = `
  SELECT u.id, u.merchant_id, m.name AS merchant_name, m.status AS merchant_status, u.email, u.name,
         u.password_hash, u.totp_secret_sealed, u.totp_last_counter, u.status, u.failed_attempts,
         u.locked_until, u.last_login_at
    FROM merchant_users u JOIN merchants m ON m.id = u.merchant_id`;

function mapUser(row: Record<string, unknown>): MerchantUserRecord {
  return Object.freeze({
    id: row['id'] as string,
    merchantId: row['merchant_id'] as string,
    merchantName: row['merchant_name'] as string,
    merchantStatus: row['merchant_status'] as string,
    email: row['email'] as string,
    name: row['name'] as string,
    passwordHash: (row['password_hash'] as string | null) ?? null,
    totpSecretSealed: (row['totp_secret_sealed'] as string | null) ?? null,
    totpLastCounter: row['totp_last_counter'] === null ? null : BigInt(row['totp_last_counter'] as string),
    status: row['status'] as MerchantUserRecord['status'],
    failedAttempts: row['failed_attempts'] as number,
    lockedUntil: (row['locked_until'] as Date | null) ?? null,
    lastLoginAt: (row['last_login_at'] as Date | null) ?? null,
  });
}

export async function findMerchantUserByEmail(email: string): Promise<MerchantUserRecord | null> {
  const { rows } = await getPool().query(`${USER_SELECT} WHERE lower(u.email) = lower($1)`, [email]);
  return rows[0] === undefined ? null : mapUser(rows[0]);
}

export async function findMerchantUserById(id: string): Promise<MerchantUserRecord | null> {
  const { rows } = await getPool().query(`${USER_SELECT} WHERE u.id = $1`, [id]);
  return rows[0] === undefined ? null : mapUser(rows[0]);
}

export async function recordMerchantFailedAttempt(userId: string, limit: number, lockSeconds: number): Promise<void> {
  await getPool().query(
    `UPDATE merchant_users
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= $2
                                THEN now() + make_interval(secs => $3) ELSE locked_until END
      WHERE id = $1`,
    [userId, limit, lockSeconds],
  );
}

/** Conditional on the code counter being newer, so one code cannot sign in twice. */
export async function acceptMerchantLogin(userId: string, totpCounter: bigint): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE merchant_users
        SET totp_last_counter = $2, failed_attempts = 0, locked_until = NULL, last_login_at = now()
      WHERE id = $1 AND (totp_last_counter IS NULL OR totp_last_counter < $2)`,
    [userId, totpCounter.toString()],
  );
  return rowCount === 1;
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export interface InviteRecord {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly merchantName: string;
  readonly userStatus: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly pendingTotpSealed: string | null;
}

/** A new invitation for an account; any earlier unused ones stop working. */
export async function createInvite(input: { userId: string; tokenHash: string; ttlSeconds: number; createdBy: string | null }): Promise<void> {
  await inTransaction(async (client) => {
    await client.query(
      'UPDATE merchant_invites SET expires_at = now() WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()',
      [input.userId],
    );
    await client.query(
      `INSERT INTO merchant_invites (token_hash, user_id, created_by, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [input.tokenHash, input.userId, input.createdBy, input.ttlSeconds],
    );
  });
}

/** The invitation behind a link, if it is still usable. */
export async function findUsableInvite(tokenHash: string): Promise<InviteRecord | null> {
  const { rows } = await getPool().query(
    `SELECT i.user_id, u.email, u.name, m.name AS merchant_name, u.status AS user_status,
            i.expires_at, i.used_at, i.pending_totp_sealed
       FROM merchant_invites i
       JOIN merchant_users u ON u.id = i.user_id
       JOIN merchants m ON m.id = u.merchant_id
      WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now() AND u.status = 'invited'`,
    [tokenHash],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    userId: row['user_id'] as string,
    email: row['email'] as string,
    name: row['name'] as string,
    merchantName: row['merchant_name'] as string,
    userStatus: row['user_status'] as string,
    expiresAt: row['expires_at'] as Date,
    usedAt: (row['used_at'] as Date | null) ?? null,
    pendingTotpSealed: (row['pending_totp_sealed'] as string | null) ?? null,
  });
}

export async function setInvitePendingTotp(tokenHash: string, sealed: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE merchant_invites SET pending_totp_sealed = $2
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash, sealed],
  );
  return rowCount === 1;
}

/**
 * Finish an invitation: the account gets its password and second factor and
 * becomes active, and the link is spent — in one transaction, with the
 * invitation locked, so a link cannot be used twice.
 */
export async function completeInvite(input: { tokenHash: string; passwordHash: string; totpSealed: string; totpCounter: bigint }): Promise<string | null> {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT i.user_id FROM merchant_invites i JOIN merchant_users u ON u.id = i.user_id
        WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now() AND u.status = 'invited'
        FOR UPDATE OF i`,
      [input.tokenHash],
    );
    const userId = rows[0]?.['user_id'] as string | undefined;
    if (userId === undefined) return null;
    await client.query(
      `UPDATE merchant_users
          SET password_hash = $2, totp_secret_sealed = $3, totp_last_counter = $4, status = 'active',
              failed_attempts = 0, locked_until = NULL, last_login_at = now()
        WHERE id = $1`,
      [userId, input.passwordHash, input.totpSealed, input.totpCounter.toString()],
    );
    await client.query('UPDATE merchant_invites SET used_at = now(), pending_totp_sealed = NULL WHERE token_hash = $1', [input.tokenHash]);
    return userId;
  });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createMerchantSession(input: {
  tokenHash: string; userId: string; maxAgeSeconds: number; ip: string | null; userAgent: string | null;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO merchant_sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5)`,
    [input.tokenHash, input.userId, input.maxAgeSeconds, input.ip, (input.userAgent ?? '').slice(0, 300)],
  );
}

/**
 * The account behind a session, or null if the session is expired, revoked,
 * idle too long, or the account or its merchant is no longer active.
 */
export async function resolveMerchantSession(tokenHash: string, idleSeconds: number): Promise<MerchantUserRecord | null> {
  const { rows } = await getPool().query(
    `UPDATE merchant_sessions s
        SET last_seen_at = now()
       FROM merchant_users u JOIN merchants m ON m.id = u.merchant_id
      WHERE s.token_hash = $1
        AND u.id = s.user_id
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(secs => $2)
        AND u.status = 'active'
        AND m.status = 'active'
    RETURNING s.user_id`,
    [tokenHash, idleSeconds],
  );
  const row = rows[0];
  return row === undefined ? null : findMerchantUserById(row['user_id'] as string);
}

export async function revokeMerchantSession(tokenHash: string): Promise<void> {
  await getPool().query(
    'UPDATE merchant_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash],
  );
}

// ---------------------------------------------------------------------------
// The merchant's own projects
// ---------------------------------------------------------------------------

export async function listMerchantProjects(merchantId: string): Promise<ProjectRecord[]> {
  const { rows } = await getPool().query(
    `SELECT id FROM projects WHERE merchant_id = $1 AND status <> 'archived' ORDER BY created_at`,
    [merchantId],
  );
  const projects = await Promise.all(rows.map((r) => findProject(r['id'] as string)));
  return projects.filter((p): p is ProjectRecord => p !== null);
}

/** The project, only if it belongs to this merchant. Anything else looks like it does not exist. */
export async function findMerchantProject(merchantId: string, projectId: string): Promise<ProjectRecord | null> {
  const project = await findProject(projectId);
  return project !== null && project.merchantId === merchantId ? project : null;
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly label: string;
  readonly prefix: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

export async function listApiKeys(projectId: string): Promise<ApiKeyRecord[]> {
  const { rows } = await getPool().query(
    `SELECT id, label, key_prefix, created_at, last_used_at, revoked_at FROM api_keys
      WHERE project_id = $1 ORDER BY revoked_at IS NOT NULL, created_at DESC`,
    [projectId],
  );
  return rows.map((row) => Object.freeze({
    id: row['id'] as string,
    label: row['label'] as string,
    prefix: row['key_prefix'] as string,
    createdAt: row['created_at'] as Date,
    lastUsedAt: (row['last_used_at'] as Date | null) ?? null,
    revokedAt: (row['revoked_at'] as Date | null) ?? null,
  }));
}

/** A new key. The secret is returned here and nowhere else: only its hash is kept. */
export async function createApiKey(projectId: string, label: string, live: boolean): Promise<{ id: string; prefix: string; secret: string }> {
  const key = newApiKey(live);
  await getPool().query(
    `INSERT INTO api_keys (id, project_id, label, key_prefix, key_hash) VALUES ($1, $2, $3, $4, $5)`,
    [key.id, projectId, label, key.prefix, hashApiKey(key.secret)],
  );
  return { id: key.id, prefix: key.prefix, secret: key.secret };
}

export async function revokeApiKey(projectId: string, keyId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL',
    [keyId, projectId],
  );
  return rowCount === 1;
}

export async function setWebhookUrl(projectId: string, url: string | null): Promise<void> {
  await getPool().query('UPDATE projects SET webhook_url = $2 WHERE id = $1', [projectId, url]);
}

export async function setWebhookSecret(projectId: string, secret: string): Promise<void> {
  await getPool().query('UPDATE projects SET webhook_secret = $2 WHERE id = $1', [projectId, secret]);
}

export async function setPayoutAddress(projectId: string, address: string | null): Promise<void> {
  await getPool().query('UPDATE projects SET payout_address = $2 WHERE id = $1', [projectId, address]);
}
