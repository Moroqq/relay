/**
 * Balance and withdrawals.
 *
 * The merchant's side of the money leaving. Approving a payout is not here on
 * purpose: it is our decision, not theirs, and belongs to the operations
 * console rather than to the API they authenticate against.
 */

import type { FastifyInstance } from 'fastify';
import { MoneyError, isAsset, parseAmount, type Asset } from '@relay/core';
import {
  findPayout,
  listPayouts,
  readMerchantBalance,
  requestPayout,
  serializeBalance,
  serializePayout,
  PayoutError,
} from '@relay/db';
import { isValidAddress } from '@relay/wallet';

import { ApiError, badRequest, notFound } from '../errors.ts';

const MAX_EXTERNAL_REF_LENGTH = 200;

export function registerPayoutRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { asset?: string } }>('/balance', async (request) => {
    const asset = request.query.asset ?? 'USDT';
    if (!isAsset(asset)) {
      throw badRequest('invalid_asset', 'Unsupported asset', `Expected "USDT" or "TRX"`);
    }
    return serializeBalance(await readMerchantBalance(request.project.id, asset));
  });

  app.post<{
    Body: { amount?: unknown; asset?: unknown; to_address?: unknown; external_ref?: unknown };
  }>('/payouts', async (request, reply) => {
    const body = request.body ?? {};

    if (body.asset !== undefined && !isAsset(body.asset)) {
      throw badRequest('invalid_asset', 'Unsupported asset');
    }
    const asset: Asset = (body.asset as Asset | undefined) ?? 'USDT';

    if (typeof body.amount !== 'string') {
      throw badRequest(
        'invalid_amount',
        'Amount must be a decimal string',
        'Send amounts as strings, e.g. "480.00" — JSON numbers lose precision on large values.',
      );
    }

    let amountUnits: bigint;
    try {
      amountUnits = parseAmount(body.amount, asset);
    } catch (error) {
      throw badRequest(
        'invalid_amount',
        'Amount could not be parsed',
        error instanceof MoneyError ? error.message : undefined,
      );
    }
    if (amountUnits <= 0n) throw badRequest('invalid_amount', 'Amount must be greater than zero');

    // Checked here rather than at signing time. Base58Check catches a mistyped
    // character while the money is still ours; on chain it is simply gone.
    if (typeof body.to_address !== 'string' || !isValidAddress(body.to_address)) {
      throw badRequest(
        'invalid_address',
        'to_address is not a valid TRON address',
        'The checksum did not match — check for a mistyped or truncated character.',
      );
    }

    let externalRef: string | null = null;
    if (body.external_ref !== undefined && body.external_ref !== null) {
      if (typeof body.external_ref !== 'string' || body.external_ref.trim() === '') {
        throw badRequest('invalid_external_ref', 'external_ref must be a non-empty string');
      }
      if (body.external_ref.length > MAX_EXTERNAL_REF_LENGTH) {
        throw badRequest(
          'invalid_external_ref',
          `external_ref must be at most ${MAX_EXTERNAL_REF_LENGTH} characters`,
        );
      }
      externalRef = body.external_ref.trim();
    }

    try {
      const { payout, created } = await requestPayout({
        projectId: request.project.id,
        externalRef,
        asset,
        amountUnits,
        toAddress: body.to_address,
      });
      return reply.status(created ? 201 : 200).send(serializePayout(payout));
    } catch (error) {
      if (error instanceof PayoutError) {
        if (error.code === 'insufficient_balance') {
          throw new ApiError(
            422,
            error.code,
            'Not enough available balance for this payout',
            'Funds already claimed by a payout in flight are not available. See GET /v1/balance.',
          );
        }
        if (error.code === 'project_inactive') {
          throw new ApiError(403, error.code, 'This project cannot withdraw right now');
        }
        throw badRequest(error.code, error.message);
      }
      throw error;
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/payouts', async (request) => {
    const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw badRequest('invalid_limit', 'limit must be a whole number between 1 and 100');
    }
    const payouts = await listPayouts(request.project.id, limit === undefined ? {} : { limit });
    return { object: 'list', data: payouts.map(serializePayout) };
  });

  app.get<{ Params: { id: string } }>('/payouts/:id', async (request) => {
    const payout = await findPayout(request.params.id);
    if (payout === null || payout.projectId !== request.project.id) {
      throw notFound(`No payout with id ${request.params.id}`);
    }
    return serializePayout(payout);
  });
}
