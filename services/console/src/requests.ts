/**
 * Applications for API access, as the console sees them: review, approve,
 * reject, and issue a fresh invitation when the first one lapsed.
 *
 * Approving creates the merchant, their first project and an account for the
 * contact, and returns a one-time invitation link. The link is shown to the
 * operator once, to pass on to the applicant; only its hash is stored, so it
 * cannot be read back later — a lost link is replaced, not recovered.
 */

import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hashSessionToken, newSessionToken } from '@relay/auth';
import {
  AccessRequestError,
  approveAccessRequest,
  createInvite,
  findAccessRequest,
  listAccessRequests,
  rejectAccessRequest,
  writeAudit,
  type AccessRequestRecord,
  type AccessRequestStatus,
} from '@relay/db';

import type { ConsoleConfig } from './config.ts';
import { ConsoleError } from './errors.ts';

export const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
const STATUSES = ['new', 'approved', 'rejected', 'all'] as const;

function requireDecider(request: FastifyRequest): void {
  if (request.operator.role !== 'admin' && request.operator.role !== 'operator') {
    throw new ConsoleError(403, 'forbidden', 'Your role can view applications but not decide them');
  }
}

export function requestView(r: AccessRequestRecord) {
  return {
    id: r.id,
    company: r.company,
    website: r.website,
    contact_name: r.contactName,
    email: r.email,
    telegram: r.telegram,
    monthly_volume: r.monthlyVolume,
    use_case: r.useCase,
    status: r.status,
    decided_by: r.decidedByName,
    decided_at: r.decidedAt?.toISOString() ?? null,
    decision_note: r.decisionNote,
    merchant_id: r.merchantId,
    account_status: r.accountStatus,
    ip: r.ip,
    created_at: r.createdAt.toISOString(),
  };
}

/** The link the applicant opens. The token rides in the fragment, which browsers never send to a server. */
const inviteUrl = (config: ConsoleConfig, token: string) => config.portalUrl + '#/invite/' + token;

export function registerRequestRoutes(app: FastifyInstance, config: ConsoleConfig): void {
  app.get<{ Querystring: { status?: string } }>('/admin/api/requests', async (request) => {
    const status = request.query.status ?? 'new';
    if (!(STATUSES as readonly string[]).includes(status)) throw new ConsoleError(400, 'invalid_status', 'Unknown status: ' + status);
    return { data: (await listAccessRequests({ status: status as AccessRequestStatus | 'all' })).map(requestView) };
  });

  app.post<{ Params: { id: string }; Body: { project_name?: unknown; fee_percent?: unknown } }>(
    '/admin/api/requests/:id/approve',
    async (request) => {
      requireDecider(request);
      const current = await findAccessRequest(request.params.id);
      if (current === null) throw new ConsoleError(404, 'not_found', 'No such application');

      const fee = Number(request.body?.fee_percent ?? 1);
      if (!Number.isFinite(fee) || fee < 0 || fee > 20) throw new ConsoleError(400, 'invalid_fee', 'The fee must be between 0 and 20 percent');
      const rawName = typeof request.body?.project_name === 'string' ? request.body.project_name.trim() : '';
      const projectName = (rawName || current.company).slice(0, 120);

      const token = newSessionToken();
      try {
        const approved = await approveAccessRequest({
          requestId: current.id,
          operatorId: request.operator.id,
          projectName,
          feeRateBps: Math.round(fee * 100),
          webhookSecret: 'whsec_' + randomBytes(24).toString('base64url'),
          inviteTokenHash: hashSessionToken(token),
          inviteTtlSeconds: INVITE_TTL_SECONDS,
        });
        await writeAudit({
          operatorId: request.operator.id,
          action: 'access.approved',
          subjectType: 'access_request',
          subjectId: current.id,
          detail: { merchant: approved.merchantId, project: approved.projectId, fee_percent: fee, email: current.email },
          ip: request.ip,
        });
        return { ok: true, request: requestView(approved.request), invite_url: inviteUrl(config, token), expires_in_days: INVITE_TTL_SECONDS / 86400 };
      } catch (error) {
        if (error instanceof AccessRequestError) {
          throw new ConsoleError(error.code === 'not_found' ? 404 : 409, error.code, error.message);
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { note?: unknown } }>('/admin/api/requests/:id/reject', async (request) => {
    requireDecider(request);
    const note = typeof request.body?.note === 'string' ? request.body.note.trim() : '';
    if (note === '') throw new ConsoleError(400, 'note_required', 'Say why, for the record');
    if (note.length > 500) throw new ConsoleError(400, 'note_too_long', 'Keep it under 500 characters');
    const rejected = await rejectAccessRequest(request.params.id, request.operator.id, note);
    if (rejected === null) {
      const current = await findAccessRequest(request.params.id);
      if (current === null) throw new ConsoleError(404, 'not_found', 'No such application');
      throw new ConsoleError(409, 'already_decided', 'This application is ' + current.status);
    }
    await writeAudit({ operatorId: request.operator.id, action: 'access.rejected', subjectType: 'access_request', subjectId: rejected.id, detail: { note }, ip: request.ip });
    return { ok: true, request: requestView(rejected) };
  });

  /** A new invitation for an approved applicant who has not yet used theirs. The old link stops working. */
  app.post<{ Params: { id: string } }>('/admin/api/requests/:id/reinvite', async (request) => {
    requireDecider(request);
    const current = await findAccessRequest(request.params.id);
    if (current === null) throw new ConsoleError(404, 'not_found', 'No such application');
    if (current.status !== 'approved' || current.accountId === null || current.accountStatus !== 'invited') {
      throw new ConsoleError(409, 'not_invited', 'Only an approved applicant who has not signed up yet can be invited again');
    }
    const token = newSessionToken();
    await createInvite({ userId: current.accountId, tokenHash: hashSessionToken(token), ttlSeconds: INVITE_TTL_SECONDS, createdBy: request.operator.id });
    await writeAudit({ operatorId: request.operator.id, action: 'access.reinvited', subjectType: 'access_request', subjectId: current.id, ip: request.ip });
    return { ok: true, invite_url: inviteUrl(config, token), expires_in_days: INVITE_TTL_SECONDS / 86400 };
  });
}
