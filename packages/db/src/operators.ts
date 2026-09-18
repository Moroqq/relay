/**
 * Console operators, their sessions, and the audit log.
 *
 * Thin on purpose: the decisions about what a failed login means live in the
 * console service, next to the code that makes them. This file stores and
 * reads, and makes the few updates that must be atomic — the ones where a race
 * between two requests would let a code be used twice or a lockout be skipped.
 */

import { newId } from '@relay/core';

import { getPool } from './pool.ts';

export type OperatorRole = 'admin' | 'operator' | 'viewer';

export interface OperatorRecord {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: OperatorRole;
  readonly passwordHash: string;
  readonly totpSecretSealed: string;
  readonly totpLastCounter: bigint | null;
  readonly status: 'active' | 'disabled';
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
  readonly lastLoginAt: Date | null;
}

const OPERATOR_COLUMNS = `id, email, name, role, password_hash, totp_secret_sealed, totp_last_counter,
  status, failed_attempts, locked_until, last_login_at`;

function mapOperator(row: Record<string, unknown>): OperatorRecord {
  return Object.freeze({
    id: row['id'] as string,
    email: row['email'] as string,
    name: row['name'] as string,
    role: row['role'] as OperatorRole,
    passwordHash: row['password_hash'] as string,
    totpSecretSealed: row['totp_secret_sealed'] as string,
    totpLastCounter: row['totp_last_counter'] === null ? null : BigInt(row['totp_last_counter'] as string),
    status: row['status'] as OperatorRecord['status'],
    failedAttempts: row['failed_attempts'] as number,
    lockedUntil: (row['locked_until'] as Date | null) ?? null,
    lastLoginAt: (row['last_login_at'] as Date | null) ?? null,
  });
}

export async function createOperator(input: {
  email: string;
  name: string;
  role: OperatorRole;
  passwordHash: string;
  totpSecretSealed: string;
}): Promise<OperatorRecord> {
  const { rows } = await getPool().query(
    `INSERT INTO operators (id, email, name, role, password_hash, totp_secret_sealed)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${OPERATOR_COLUMNS}`,
    [newId('operator'), input.email.trim(), input.name.trim(), input.role, input.passwordHash, input.totpSecretSealed],
  );
  return mapOperator(rows[0]!);
}

export async function findOperatorByEmail(email: string): Promise<OperatorRecord | null> {
  const { rows } = await getPool().query(
    `SELECT ${OPERATOR_COLUMNS} FROM operators WHERE lower(email) = lower($1)`,
    [email.trim()],
  );
  return rows[0] === undefined ? null : mapOperator(rows[0]);
}

export async function findOperatorById(id: string): Promise<OperatorRecord | null> {
  const { rows } = await getPool().query(`SELECT ${OPERATOR_COLUMNS} FROM operators WHERE id = $1`, [id]);
  return rows[0] === undefined ? null : mapOperator(rows[0]);
}

/**
 * Count a failed attempt, locking the account once the limit is reached.
 * One statement, so concurrent guesses cannot each read "four failures" and
 * all slip through before the lock is written.
 */
export async function recordFailedAttempt(operatorId: string, limit: number, lockSeconds: number): Promise<void> {
  await getPool().query(
    `UPDATE operators
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= $2
                                THEN now() + make_interval(secs => $3) ELSE locked_until END
      WHERE id = $1`,
    [operatorId, limit, lockSeconds],
  );
}

/**
 * Accept a TOTP code: store its counter, reset failures, stamp the login.
 *
 * Conditional on the counter being strictly newer than the stored one. Two
 * sign-ins racing with the same code both pass the in-memory check; only one of
 * them gets a row back here, and the other is refused.
 */
export async function acceptLogin(operatorId: string, totpCounter: bigint): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE operators
        SET totp_last_counter = $2, failed_attempts = 0, locked_until = NULL, last_login_at = now()
      WHERE id = $1 AND (totp_last_counter IS NULL OR totp_last_counter < $2)`,
    [operatorId, totpCounter.toString()],
  );
  return rowCount === 1;
}

/**
 * Accept a sign-in by password alone, where the console is configured not to
 * ask for a code (local development only): reset failures, stamp the login.
 */
export async function acceptPasswordLogin(operatorId: string): Promise<void> {
  await getPool().query(
    'UPDATE operators SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
    [operatorId],
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionContext {
  readonly operator: OperatorRecord;
  readonly expiresAt: Date;
}

export async function createSession(input: {
  tokenHash: string;
  operatorId: string;
  maxAgeSeconds: number;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO operator_sessions (token_hash, operator_id, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5)`,
    [input.tokenHash, input.operatorId, input.maxAgeSeconds, input.ip, (input.userAgent ?? '').slice(0, 300)],
  );
}

/**
 * Resolve a session, refusing it if it has expired, been revoked, sat idle too
 * long, or belongs to an operator who has since been disabled. Using it counts
 * as activity, so the idle clock restarts.
 *
 * The disabled check matters: turning an operator off must take effect on their
 * open sessions immediately, not whenever those sessions happen to expire.
 */
export async function resolveSession(tokenHash: string, idleSeconds: number): Promise<SessionContext | null> {
  const { rows } = await getPool().query(
    `UPDATE operator_sessions s
        SET last_seen_at = now()
       FROM operators o
      WHERE s.token_hash = $1
        AND o.id = s.operator_id
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(secs => $2)
        AND o.status = 'active'
    RETURNING s.operator_id, s.expires_at`,
    [tokenHash, idleSeconds],
  );
  const row = rows[0];
  if (row === undefined) return null;

  const operator = await findOperatorById(row['operator_id'] as string);
  if (operator === null) return null;
  return { operator, expiresAt: row['expires_at'] as Date };
}

export async function revokeSession(tokenHash: string): Promise<void> {
  await getPool().query(
    'UPDATE operator_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash],
  );
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditEntry {
  readonly operatorId: string | null;
  /** Set instead of operatorId when a merchant, signed in to the portal, did it. */
  readonly merchantUserId?: string | null;
  readonly action: string;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly detail?: Record<string, unknown>;
  readonly ip?: string | null;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  await getPool().query(
    `INSERT INTO audit_log (operator_id, action, subject_type, subject_id, detail, ip, merchant_user_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      entry.operatorId,
      entry.action,
      entry.subjectType ?? null,
      entry.subjectId ?? null,
      JSON.stringify(entry.detail ?? {}),
      entry.ip ?? null,
      entry.merchantUserId ?? null,
    ],
  );
}

export interface AuditRecord {
  readonly id: string;
  readonly operatorId: string | null;
  readonly operatorName: string | null;
  readonly action: string;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly detail: Record<string, unknown>;
  readonly ip: string | null;
  readonly createdAt: Date;
}

export async function listAudit(options: { subjectId?: string; limit?: number } = {}): Promise<AuditRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const { rows } = await getPool().query(
    `SELECT a.id, a.operator_id, o.name AS operator_name, a.action, a.subject_type, a.subject_id,
            a.detail, a.ip, a.created_at
       FROM audit_log a LEFT JOIN operators o ON o.id = a.operator_id
      WHERE ($1::text IS NULL OR a.subject_id = $1)
      ORDER BY a.id DESC LIMIT $2`,
    [options.subjectId ?? null, limit],
  );
  return rows.map((row) => Object.freeze({
    id: String(row['id']),
    operatorId: (row['operator_id'] as string | null) ?? null,
    operatorName: (row['operator_name'] as string | null) ?? null,
    action: row['action'] as string,
    subjectType: (row['subject_type'] as string | null) ?? null,
    subjectId: (row['subject_id'] as string | null) ?? null,
    detail: row['detail'] as Record<string, unknown>,
    ip: (row['ip'] as string | null) ?? null,
    createdAt: row['created_at'] as Date,
  }));
}
