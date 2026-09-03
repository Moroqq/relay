/**
 * The merchant-facing HTTP API.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { findProjectByApiKey, type ProjectRecord } from '@relay/db';
import type { DepositWallet } from '@relay/wallet';

import { ApiError, unauthorized } from './errors.ts';
import { registerPaymentRoutes } from './routes/payments.ts';
import { registerUserRoutes } from './routes/users.ts';

declare module 'fastify' {
  interface FastifyRequest {
    project: ProjectRecord;
  }
}

export interface ServerOptions {
  readonly wallet: DepositWallet;
  readonly requiredConfirmations: number;
  readonly paymentTtlMinutes: number;
  readonly logger?: boolean;
}

/**
 * Pull the API key out of `Authorization: Bearer <key>`.
 *
 * Also accepted as `X-Api-Key`, because half of integrations reach for that
 * header first and a 401 with no explanation is an expensive support ticket.
 */
function extractApiKey(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const value = header.slice('Bearer '.length).trim();
    if (value !== '') return value;
  }

  const alternative = request.headers['x-api-key'];
  if (typeof alternative === 'string' && alternative.trim() !== '') return alternative.trim();

  return null;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // Money endpoints do not need megabyte bodies, and a small cap is one
    // fewer way to tie up the process.
    bodyLimit: 64 * 1024,
    // Merchants retry; a request that has already been abandoned should not
    // keep a database connection busy.
    requestTimeout: 20_000,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.status).send(error.toJSON());
    }

    if ((error as { statusCode?: number }).statusCode === 400) {
      return reply.status(400).send({
        error: { code: 'invalid_request', message: 'Request body could not be parsed' },
      });
    }

    // Anything unrecognised is our fault and our problem: log it in full,
    // tell the merchant nothing about our internals.
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'Something went wrong on our side' },
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  // Everything under /v1 is authenticated.
  app.register(
    async (scope) => {
      scope.addHook('preHandler', async (request) => {
        const key = extractApiKey(request);
        if (key === null) throw unauthorized();

        const project = await findProjectByApiKey(key);
        if (project === null) throw unauthorized();
        if (project.status === 'archived') {
          throw new ApiError(403, 'project_archived', 'This project is archived');
        }

        request.project = project;
      });

      registerPaymentRoutes(scope, options);
      registerUserRoutes(scope, options);
    },
    { prefix: '/v1' },
  );

  return app;
}
