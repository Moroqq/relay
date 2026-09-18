/**
 * Applications for API access, from the website's form, and what approving
 * one creates.
 */

import { newId } from '@relay/core';

import { getPool, inTransaction } from './pool.ts';

export type AccessRequestStatus = 'new' | 'approved' | 'rejected';

export interface AccessRequestRecord {
  readonly id: string;
  readonly company: string;
  readonly website: string | null;
  readonly contactName: string;
  readonly email: string;
  readonly telegram: string | null;
  readonly monthlyVolume: string;
  readonly useCase: string;
  readonly status: AccessRequestStatus;
  readonly decidedBy: string | null;
  readonly decidedByName: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly merchantId: string | null;
  /** The status of the account approving created, if any: invited until the link is used. */
  readonly accountStatus: string | null;
  readonly accountId: string | null;
  readonly ip: string | null;
  readonly createdAt: Date;
}

export class AccessRequestError extends Error {
  readonly code: 'not_found' | 'already_decided' | 'email_taken';
  constructor(code: AccessRequestError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const SELECT = `
  SELECT r.id, r.company, r.website, r.contact_name, r.email, r.telegram, r.monthly_volume, r.use_case,
         r.status, r.decided_by, o.name AS decided_by_name, r.decided_at, r.decision_note, r.merchant_id,
         r.ip, r.created_at, u.status AS account_status, u.id AS account_id
    FROM access_requests r
    LEFT JOIN operators o ON o.id = r.decided_by
    LEFT JOIN merchant_users u ON u.merchant_id = r.merchant_id AND lower(u.email) = lower(r.email)`;

function map(row: Record<string, unknown>): AccessRequestRecord {
  return Object.freeze({
    id: row['id'] as string,
    company: row['company'] as string,
    website: (row['website'] as string | null) ?? null,
    contactName: row['contact_name'] as string,
    email: row['email'] as string,
    telegram: (row['telegram'] as string | null) ?? null,
    monthlyVolume: row['monthly_volume'] as string,
    useCase: row['use_case'] as string,
    status: row['status'] as AccessRequestStatus,
    decidedBy: (row['decided_by'] as string | null) ?? null,
    decidedByName: (row['decided_by_name'] as string | null) ?? null,
    decidedAt: (row['decided_at'] as Date | null) ?? null,
    decisionNote: (row['decision_note'] as string | null) ?? null,
    merchantId: (row['merchant_id'] as string | null) ?? null,
    accountStatus: (row['account_status'] as string | null) ?? null,
    accountId: (row['account_id'] as string | null) ?? null,
    ip: (row['ip'] as string | null) ?? null,
    createdAt: row['created_at'] as Date,
  });
}

export interface NewAccessRequest {
  readonly company: string;
  readonly website: string | null;
  readonly contactName: string;
  readonly email: string;
  readonly telegram: string | null;
  readonly monthlyVolume: string;
  readonly useCase: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export async function createAccessRequest(input: NewAccessRequest): Promise<AccessRequestRecord> {
  const id = newId('accessRequest');
  await getPool().query(
    `INSERT INTO access_requests (id, company, website, contact_name, email, telegram, monthly_volume, use_case, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, input.company, input.website, input.contactName, input.email, input.telegram,
      input.monthlyVolume, input.useCase, input.ip, (input.userAgent ?? '').slice(0, 300)],
  );
  return (await findAccessRequest(id))!;
}

export async function findAccessRequest(id: string): Promise<AccessRequestRecord | null> {
  const { rows } = await getPool().query(`${SELECT} WHERE r.id = $1`, [id]);
  return rows[0] === undefined ? null : map(rows[0]);
}

export async function listAccessRequests(options: { status?: AccessRequestStatus | 'all'; limit?: number } = {}): Promise<AccessRequestRecord[]> {
  const status = options.status ?? 'all';
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const { rows } = await getPool().query(
    `${SELECT} WHERE ($1::text = 'all' OR r.status = $1) ORDER BY r.created_at DESC LIMIT $2`,
    [status, limit],
  );
  return rows.map(map);
}

export async function countNewAccessRequests(): Promise<number> {
  const { rows } = await getPool().query(`SELECT COUNT(*)::int AS n FROM access_requests WHERE status = 'new'`);
  return rows[0]!['n'] as number;
}

/** Reject an application still waiting. Null if it was already decided. */
export async function rejectAccessRequest(id: string, operatorId: string, note: string): Promise<AccessRequestRecord | null> {
  const { rowCount } = await getPool().query(
    `UPDATE access_requests SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
      WHERE id = $1 AND status = 'new'`,
    [id, operatorId, note],
  );
  return rowCount === 1 ? findAccessRequest(id) : null;
}

export interface ApproveAccessRequestInput {
  readonly requestId: string;
  readonly operatorId: string;
  readonly projectName: string;
  readonly feeRateBps: number;
  readonly webhookSecret: string;
  readonly inviteTokenHash: string;
  readonly inviteTtlSeconds: number;
}

export interface ApprovedAccess {
  readonly request: AccessRequestRecord;
  readonly merchantId: string;
  readonly projectId: string;
  readonly userId: string;
}

/**
 * Approve an application: create the merchant, their first project, an
 * account for the contact, and an invitation for that account — all or none.
 *
 * The request row is locked first, so two operators approving the same
 * application at once create one merchant, not two.
 */
export async function approveAccessRequest(input: ApproveAccessRequestInput): Promise<ApprovedAccess> {
  const ids = await inTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT id, status, company, contact_name, email FROM access_requests WHERE id = $1 FOR UPDATE',
      [input.requestId],
    );
    const request = rows[0];
    if (request === undefined) throw new AccessRequestError('not_found', 'No such application');
    if (request['status'] !== 'new') throw new AccessRequestError('already_decided', 'This application is ' + request['status']);

    const email = request['email'] as string;
    const { rows: taken } = await client.query('SELECT 1 FROM merchant_users WHERE lower(email) = lower($1)', [email]);
    if (taken.length > 0) throw new AccessRequestError('email_taken', 'An account with this email already exists');

    const merchantId = newId('merchant');
    const projectId = newId('project');
    const userId = newId('merchantUser');
    await client.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [merchantId, request['company']]);
    await client.query(
      `INSERT INTO projects (id, merchant_id, name, fee_rate_bps, webhook_secret) VALUES ($1, $2, $3, $4, $5)`,
      [projectId, merchantId, input.projectName, input.feeRateBps, input.webhookSecret],
    );
    await client.query(
      `INSERT INTO merchant_users (id, merchant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [userId, merchantId, email, request['contact_name']],
    );
    await client.query(
      `INSERT INTO merchant_invites (token_hash, user_id, created_by, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [input.inviteTokenHash, userId, input.operatorId, input.inviteTtlSeconds],
    );
    await client.query(
      `UPDATE access_requests SET status = 'approved', decided_by = $2, decided_at = now(), merchant_id = $3 WHERE id = $1`,
      [input.requestId, input.operatorId, merchantId],
    );
    return { merchantId, projectId, userId };
  });
  return { request: (await findAccessRequest(input.requestId))!, ...ids };
}
