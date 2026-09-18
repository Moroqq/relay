/**
 * What a signed-in merchant can see and do, always within their own merchant.
 *
 * Every project route looks the project up by the signed-in merchant first; a
 * project that belongs to someone else answers exactly like one that does not
 * exist.
 */

import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MoneyError, parseAmount, type Asset } from '@relay/core';
import {
  createApiKey,
  findMerchantProject,
  listApiKeys,
  listDeposits,
  listMerchantProjects,
  listPayouts,
  PayoutError,
  readMerchantBalance,
  requestPayout,
  revokeApiKey,
  setWebhookSecret,
  setWebhookUrl,
  writeAudit,
  type ProjectRecord,
} from '@relay/db';
import { isValidAddress } from '@relay/wallet';

import type { PortalConfig } from './config.ts';
import { PortalError } from './errors.ts';
import { apiKeyView, depositView, payoutView, projectView } from './views.ts';

type ProjectParams = { Params: { projectId: string } };

async function ownProject(request: FastifyRequest<ProjectParams>): Promise<ProjectRecord> {
  const project = await findMerchantProject(request.merchantUser.merchantId, request.params.projectId);
  if (project === null) throw new PortalError(404, 'not_found', 'No such project');
  return project;
}

const audit = (request: FastifyRequest, action: string, subjectType: string, subjectId: string, detail: Record<string, unknown> = {}) =>
  writeAudit({ operatorId: null, merchantUserId: request.merchantUser.id, action, subjectType, subjectId, detail, ip: request.ip });

export function registerPortalRoutes(app: FastifyInstance, config: PortalConfig): void {
  app.get('/portal/api/projects', async (request) => {
    const projects = await listMerchantProjects(request.merchantUser.merchantId);
    const data = await Promise.all(projects.map(async (p) => projectView(p, {
      usdt: await readMerchantBalance(p.id, 'USDT'),
      trx: await readMerchantBalance(p.id, 'TRX'),
    })));
    return { data };
  });

  app.get<ProjectParams>('/portal/api/projects/:projectId/deposits', async (request) => {
    const project = await ownProject(request);
    return { data: (await listDeposits(project.id, { limit: 50 })).map(depositView) };
  });

  app.get<ProjectParams>('/portal/api/projects/:projectId/payouts', async (request) => {
    const project = await ownProject(request);
    return { data: (await listPayouts(project.id, { limit: 50 })).map(payoutView) };
  });

  /** Ask for a payout. Nothing moves until an operator approves it (or it is under the automatic limit). */
  app.post<ProjectParams & { Body: { amount?: unknown; asset?: unknown; to_address?: unknown } }>(
    '/portal/api/projects/:projectId/payouts',
    async (request, reply) => {
      const project = await ownProject(request);
      const { amount, asset = 'USDT', to_address: to } = request.body ?? {};
      if (asset !== 'USDT' && asset !== 'TRX') throw new PortalError(400, 'invalid_asset', 'Asset must be USDT or TRX');
      if (typeof to !== 'string' || !isValidAddress(to.trim())) {
        throw new PortalError(400, 'invalid_address', 'That is not a valid TRON address');
      }
      let units: bigint;
      try {
        units = parseAmount(String(amount ?? '').trim(), asset as Asset);
      } catch (error) {
        if (error instanceof MoneyError) throw new PortalError(400, 'invalid_amount', 'Enter an amount like 250 or 250.50');
        throw error;
      }
      if (units <= 0n) throw new PortalError(400, 'invalid_amount', 'The amount must be more than zero');

      try {
        const { payout } = await requestPayout({ projectId: project.id, externalRef: null, asset: asset as Asset, amountUnits: units, toAddress: to.trim() });
        await audit(request, 'payout.requested', 'payout', payout.id, { amount: units.toString(), asset, to: payout.toAddress });
        reply.status(201);
        return payoutView(payout);
      } catch (error) {
        if (error instanceof PayoutError) {
          const messages: Record<string, string> = {
            insufficient_balance: 'That is more than the available balance',
            amount_below_fee: 'The amount is smaller than the withdrawal fee',
            project_inactive: 'This project is not active',
          };
          throw new PortalError(409, error.code, messages[error.code] ?? error.message);
        }
        throw error;
      }
    },
  );

  app.get<ProjectParams>('/portal/api/projects/:projectId/keys', async (request) => {
    const project = await ownProject(request);
    return { data: (await listApiKeys(project.id)).map(apiKeyView) };
  });

  /** A new API key. The secret is in this response and nowhere else, ever. */
  app.post<ProjectParams & { Body: { label?: unknown } }>('/portal/api/projects/:projectId/keys', async (request, reply) => {
    const project = await ownProject(request);
    const label = typeof request.body?.label === 'string' ? request.body.label.trim().slice(0, 60) : '';
    const active = (await listApiKeys(project.id)).filter((k) => k.revokedAt === null);
    if (active.length >= 10) throw new PortalError(409, 'too_many_keys', 'Revoke an unused key before creating another (10 at most)');
    const key = await createApiKey(project.id, label, config.liveKeys);
    await audit(request, 'api_key.created', 'api_key', key.id, { project: project.id, prefix: key.prefix, label });
    reply.status(201);
    return { id: key.id, prefix: key.prefix, secret: key.secret, label };
  });

  app.post<{ Params: { projectId: string; keyId: string } }>('/portal/api/projects/:projectId/keys/:keyId/revoke', async (request) => {
    const project = await ownProject(request);
    if (!(await revokeApiKey(project.id, request.params.keyId))) throw new PortalError(404, 'not_found', 'No such active key');
    await audit(request, 'api_key.revoked', 'api_key', request.params.keyId, { project: project.id });
    return { ok: true };
  });

  /** Where payment notifications go. HTTPS only on mainnet: they carry real payment data. */
  app.put<ProjectParams & { Body: { url?: unknown } }>('/portal/api/projects/:projectId/webhook', async (request) => {
    const project = await ownProject(request);
    const raw = typeof request.body?.url === 'string' ? request.body.url.trim() : '';
    let url: string | null = null;
    if (raw !== '') {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        throw new PortalError(400, 'invalid_url', 'Enter a full address, like https://example.com/relay/webhook');
      }
      const httpsOnly = config.network === 'mainnet';
      if (parsed.protocol !== 'https:' && (httpsOnly || parsed.protocol !== 'http:')) {
        throw new PortalError(400, 'invalid_url', 'The address must start with https://');
      }
      if (raw.length > 500) throw new PortalError(400, 'invalid_url', 'That address is too long');
      url = parsed.toString();
    }
    await setWebhookUrl(project.id, url);
    await audit(request, 'webhook.url_set', 'project', project.id, { url });
    return { ok: true, webhook_url: url };
  });

  /** A new signing secret for notifications. Shown once; the old one stops working at once. */
  app.post<ProjectParams>('/portal/api/projects/:projectId/webhook/secret', async (request) => {
    const project = await ownProject(request);
    const secret = 'whsec_' + randomBytes(24).toString('base64url');
    await setWebhookSecret(project.id, secret);
    await audit(request, 'webhook.secret_rotated', 'project', project.id);
    return { secret };
  });
}
