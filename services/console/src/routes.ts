/**
 * Console routes behind a session: reading the queues, and deciding payouts.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  approvePayout,
  countNewAccessRequests,
  findPayout,
  isPayoutTab,
  listAudit,
  listConsolePayouts,
  readConsoleSummary,
  readServiceStatus,
  rejectPayout,
  writeAudit,
} from '@relay/db';

import { ConsoleError } from './errors.ts';
import { auditView, payoutView, summaryView, sweeperView } from './views.ts';

const MAX_REASON_LENGTH = 500;

/** Viewers may look; only operators and admins may decide where money goes. */
function requireDecider(request: FastifyRequest): void {
  if (request.operator.role !== 'admin' && request.operator.role !== 'operator') {
    throw new ConsoleError(403, 'forbidden', 'Your role can view payouts but not decide them');
  }
}

export function registerConsoleRoutes(app: FastifyInstance): void {
  app.get('/admin/api/summary', async () => ({
    ...summaryView(await readConsoleSummary()),
    sweeper: sweeperView(await readServiceStatus('sweeper'), Date.now()),
    requests_new: await countNewAccessRequests(),
  }));

  app.get<{ Querystring: { tab?: string } }>('/admin/api/payouts', async (request) => {
    const tab = request.query.tab ?? 'requested';
    if (!isPayoutTab(tab)) throw new ConsoleError(400, 'invalid_tab', 'Unknown payout tab: ' + tab);
    return { data: (await listConsolePayouts(tab)).map(payoutView) };
  });

  /**
   * Approve a payout.
   *
   * The update only succeeds from `requested`, so two operators pressing the
   * button together, or an approval arriving after a rejection, cannot both
   * take effect. The loser is told so rather than shown a success.
   */
  app.post<{ Params: { id: string } }>('/admin/api/payouts/:id/approve', async (request) => {
    requireDecider(request);
    const approved = await approvePayout(request.params.id, request.operator.id);

    if (approved === null) {
      const current = await findPayout(request.params.id);
      if (current === null) throw new ConsoleError(404, 'not_found', 'No such payout');
      throw new ConsoleError(409, 'not_awaiting_approval', 'This payout is ' + current.state + ', not awaiting approval');
    }

    await writeAudit({
      operatorId: request.operator.id,
      action: 'payout.approved',
      subjectType: 'payout',
      subjectId: approved.id,
      detail: { amount: approved.amountUnits.toString(), net: approved.netUnits.toString(), to: approved.toAddress },
      ip: request.ip,
    });
    return { ok: true, state: approved.state };
  });

  /** Reject a payout. A reason is required: the merchant will ask. */
  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>('/admin/api/payouts/:id/reject', async (request) => {
    requireDecider(request);
    const reason = request.body?.reason;
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new ConsoleError(400, 'reason_required', 'Say why the payout is rejected');
    }
    if (reason.length > MAX_REASON_LENGTH) {
      throw new ConsoleError(400, 'reason_too_long', 'Keep the reason under ' + MAX_REASON_LENGTH + ' characters');
    }

    const rejected = await rejectPayout(request.params.id, reason.trim());
    if (rejected === null) {
      const current = await findPayout(request.params.id);
      if (current === null) throw new ConsoleError(404, 'not_found', 'No such payout');
      throw new ConsoleError(409, 'not_awaiting_approval', 'This payout is ' + current.state + ', not awaiting approval');
    }

    await writeAudit({
      operatorId: request.operator.id,
      action: 'payout.rejected',
      subjectType: 'payout',
      subjectId: rejected.id,
      detail: { amount: rejected.amountUnits.toString(), reason: reason.trim() },
      ip: request.ip,
    });
    return { ok: true, state: rejected.state };
  });

  app.get<{ Querystring: { subject?: string } }>('/admin/api/audit', async (request) => {
    const entries = await listAudit(request.query.subject === undefined ? {} : { subjectId: request.query.subject });
    return { data: entries.map(auditView) };
  });
}
