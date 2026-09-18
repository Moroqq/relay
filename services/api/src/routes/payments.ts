/**
 * Payment endpoints.
 */

import type { FastifyInstance } from 'fastify';
import { MoneyError, isAsset, parseAmount, type Asset } from '@relay/core';
import { createPayment, findPayment, listPayments, serializePayment, PaymentError } from '@relay/db';
import type { AddressSource } from '@relay/wallet';

import { ApiError, badRequest, notFound } from '../errors.ts';

interface RouteOptions {
  readonly wallet: AddressSource;
  readonly requiredConfirmations: number;
  readonly paymentTtlMinutes: number;
}

/** The upper bound on how long we hold a deposit address open. */
const MAX_TTL_MINUTES = 24 * 60;
const MAX_EXTERNAL_REF_LENGTH = 200;

interface CreateBody {
  amount?: unknown;
  asset?: unknown;
  external_ref?: unknown;
  expires_in_minutes?: unknown;
}

/**
 * Validate by hand rather than by schema.
 *
 * The error a merchant gets for a bad amount is the difference between a
 * five-minute integration and an afternoon of guessing, so each field says
 * what was wrong with it and what was expected instead.
 */
function parseCreateBody(
  body: CreateBody,
  defaults: RouteOptions,
): { asset: Asset; expectedUnits: bigint; externalRef: string | null; ttlMinutes: number } {
  const { amount, asset, external_ref: externalRef, expires_in_minutes: ttl } = body;

  if (asset !== undefined && !isAsset(asset)) {
    throw badRequest('invalid_asset', 'Unsupported asset', `Expected "USDT" or "TRX", got ${JSON.stringify(asset)}`);
  }
  const resolvedAsset: Asset = (asset as Asset | undefined) ?? 'USDT';

  if (typeof amount !== 'string') {
    throw badRequest(
      'invalid_amount',
      'Amount must be a decimal string',
      'Send amounts as strings, e.g. "480.00" — JSON numbers lose precision on large values.',
    );
  }

  let expectedUnits: bigint;
  try {
    expectedUnits = parseAmount(amount, resolvedAsset);
  } catch (error) {
    throw badRequest(
      'invalid_amount',
      'Amount could not be parsed',
      error instanceof MoneyError ? error.message : undefined,
    );
  }
  if (expectedUnits <= 0n) {
    throw badRequest('invalid_amount', 'Amount must be greater than zero');
  }

  if (externalRef !== undefined && externalRef !== null) {
    if (typeof externalRef !== 'string' || externalRef.trim() === '') {
      throw badRequest('invalid_external_ref', 'external_ref must be a non-empty string');
    }
    if (externalRef.length > MAX_EXTERNAL_REF_LENGTH) {
      throw badRequest(
        'invalid_external_ref',
        `external_ref must be at most ${MAX_EXTERNAL_REF_LENGTH} characters`,
      );
    }
  }

  let ttlMinutes = defaults.paymentTtlMinutes;
  if (ttl !== undefined) {
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_MINUTES) {
      throw badRequest(
        'invalid_expiry',
        `expires_in_minutes must be a whole number between 1 and ${MAX_TTL_MINUTES}`,
      );
    }
    ttlMinutes = ttl;
  }

  return {
    asset: resolvedAsset,
    expectedUnits,
    externalRef: typeof externalRef === 'string' ? externalRef.trim() : null,
    ttlMinutes,
  };
}

export function registerPaymentRoutes(app: FastifyInstance, options: RouteOptions): void {
  app.post('/payments', async (request, reply) => {
    const input = parseCreateBody((request.body ?? {}) as CreateBody, options);

    try {
      const { payment, created } = await createPayment(
        {
          projectId: request.project.id,
          externalRef: input.externalRef,
          asset: input.asset,
          expectedUnits: input.expectedUnits,
          ttlMinutes: input.ttlMinutes,
          requiredConfirmations: options.requiredConfirmations,
        },
        options.wallet,
      );

      // 200 rather than 201 on a repeat tells a careful client that its retry
      // was recognised, without making the common case an error.
      return reply.status(created ? 201 : 200).send(serializePayment(payment));
    } catch (error) {
      if (error instanceof PaymentError) {
        if (error.code === 'project_inactive') {
          throw new ApiError(403, error.code, 'This project cannot accept payments right now');
        }
        throw badRequest(error.code, error.message);
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/payments/:id', async (request) => {
    const payment = await findPayment(request.params.id);
    // Scoped to the caller's project: a valid id from another merchant must
    // look exactly like an id that does not exist.
    if (payment === null || payment.projectId !== request.project.id) {
      throw notFound(`No payment with id ${request.params.id}`);
    }
    return serializePayment(payment);
  });

  app.get<{ Querystring: { limit?: string } }>('/payments', async (request) => {
    const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw badRequest('invalid_limit', 'limit must be a whole number between 1 and 100');
    }
    const payments = await listPayments(request.project.id, limit === undefined ? {} : { limit });
    return { object: 'list', data: payments.map(serializePayment) };
  });
}
