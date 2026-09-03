/**
 * Users and their deposits.
 *
 * The account model's whole API is smaller than the invoice model's, because
 * there is nothing to invoice. A merchant asks for a user's address once,
 * shows it to them, and waits to be told money arrived.
 */

import type { FastifyInstance } from 'fastify';
import {
  ensureEndUser,
  findEndUser,
  findDeposit,
  listDeposits,
  serializeEndUser,
  serializeDeposit,
  EndUserError,
} from '@relay/db';
import type { DepositWallet } from '@relay/wallet';

import { ApiError, badRequest, notFound } from '../errors.ts';

interface RouteOptions {
  readonly wallet: DepositWallet;
}

const MAX_REF_LENGTH = 200;

function requireRef(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(
      'invalid_user_ref',
      'ref must be a non-empty string',
      "Send your own identifier for the user — whatever you call them in your database.",
    );
  }
  if (value.length > MAX_REF_LENGTH) {
    throw badRequest('invalid_user_ref', `ref must be at most ${MAX_REF_LENGTH} characters`);
  }
  return value.trim();
}

export function registerUserRoutes(app: FastifyInstance, options: RouteOptions): void {
  /**
   * Get this user's deposit address, assigning one on first sight.
   *
   * Deliberately idempotent rather than a create: a merchant calling it on
   * every page load must get the same address every time. 201 on the first
   * call and 200 afterwards tells a careful client which happened without
   * making the common case an error.
   */
  app.post<{ Body: { ref?: unknown } }>('/users', async (request, reply) => {
    const ref = requireRef((request.body ?? {}).ref);

    try {
      const { user, created } = await ensureEndUser(request.project.id, ref, options.wallet);
      return reply.status(created ? 201 : 200).send(serializeEndUser(user));
    } catch (error) {
      if (error instanceof EndUserError) {
        if (error.code === 'project_inactive') {
          throw new ApiError(403, error.code, 'This project cannot accept deposits right now');
        }
        throw badRequest(error.code, error.message);
      }
      throw error;
    }
  });

  app.get<{ Params: { ref: string } }>('/users/:ref', async (request) => {
    const user = await findEndUser(request.project.id, request.params.ref);
    if (user === null) throw notFound(`No user with ref ${request.params.ref}`);
    return serializeEndUser(user);
  });

  app.get<{ Querystring: { user?: string; limit?: string } }>('/deposits', async (request) => {
    const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw badRequest('invalid_limit', 'limit must be a whole number between 1 and 100');
    }

    const deposits = await listDeposits(request.project.id, {
      ...(request.query.user === undefined ? {} : { endUserId: request.query.user }),
      ...(limit === undefined ? {} : { limit }),
    });
    return { object: 'list', data: deposits.map(serializeDeposit) };
  });

  app.get<{ Params: { id: string } }>('/deposits/:id', async (request) => {
    const deposit = await findDeposit(request.params.id);
    // A deposit belonging to another merchant must look exactly like one that
    // does not exist.
    if (deposit === null || deposit.projectId !== request.project.id) {
      throw notFound(`No deposit with id ${request.params.id}`);
    }
    return serializeDeposit(deposit);
  });
}
