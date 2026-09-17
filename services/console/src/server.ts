/**
 * The operations console's HTTP server.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { SESSION_IDLE_SECONDS, SESSION_MAX_AGE_SECONDS, hashSessionToken, newSessionToken } from '@relay/auth';
import { createSession, resolveSession, revokeSession, type OperatorRecord } from '@relay/db';

import type { ConsoleConfig } from './config.ts';
import { ConsoleError } from './errors.ts';
import { clearedSessionCookie, readSessionCookie, sessionCookie } from './cookies.ts';
import { login } from './login.ts';
import { operatorView } from './views.ts';
import { registerConsoleRoutes } from './routes.ts';

export { ConsoleError };

declare module 'fastify' {
  interface FastifyRequest {
    operator: OperatorRecord;
    sessionTokenHash: string;
  }
}


/** The header a state-changing request must carry. See the CSRF hook below. */
export const CSRF_HEADER = 'x-relay-console';

const clientIp = (request: FastifyRequest): string => request.ip;

export function buildConsoleServer(config: ConsoleConfig, options: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16 * 1024 });

  app.addHook('onSend', async (_request, reply) => {
    // Refuse to be framed. Otherwise a hostile page can lay the console,
    // invisible, under its own button and have an operator click Approve.
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
  });

  /**
   * Cross-site request forgery, closed three ways at once.
   *
   * The cookie is SameSite=Strict, so another site's request does not carry it.
   * A state-changing request must also carry a custom header, which a browser
   * will not let another origin set without a CORS preflight this server never
   * answers. And when the browser sends an Origin, it must be ours.
   */
  app.addHook('preHandler', async (request) => {
    if (request.method === 'GET' || request.method === 'HEAD') return;
    if (request.headers[CSRF_HEADER] !== '1') {
      throw new ConsoleError(403, 'csrf', 'Request refused');
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== config.allowedOrigin) {
      throw new ConsoleError(403, 'csrf', 'Request refused');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ConsoleError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    if ((error as { statusCode?: number }).statusCode === 400) {
      return reply.status(400).send({ error: { code: 'invalid_request', message: 'Request could not be parsed' } });
    }
    request.log.error({ err: error }, 'unhandled console error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  app.post<{ Body: { email?: unknown; password?: unknown; code?: unknown } }>('/admin/api/login', async (request, reply) => {
    const { email, password, code } = request.body ?? {};
    const invalid = new ConsoleError(401, 'invalid_credentials', 'Email, password or code is incorrect');
    if (typeof email !== 'string' || typeof password !== 'string' || typeof code !== 'string') throw invalid;
    if (email.length > 320 || password.length > 1024 || code.length > 16) throw invalid;

    const result = await login(
      { email, password, code, ip: clientIp(request), nowSeconds: Math.floor(Date.now() / 1000) },
      config.secretKey,
    );
    if (!result.ok) throw invalid;

    const token = newSessionToken();
    await createSession({
      tokenHash: hashSessionToken(token),
      operatorId: result.operator.id,
      maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
      ip: clientIp(request),
      userAgent: request.headers['user-agent'] ?? null,
    });

    reply.header('Set-Cookie', sessionCookie(token, config.secureCookies));
    return { operator: operatorView(result.operator) };
  });

  // Everything else needs a live session.
  app.register(async (scope) => {
    scope.addHook('preHandler', async (request, reply) => {
      const token = readSessionCookie(request.headers.cookie);
      const context = token === null ? null : await resolveSession(hashSessionToken(token), SESSION_IDLE_SECONDS);
      if (context === null) {
        reply.header('Set-Cookie', clearedSessionCookie(config.secureCookies));
        throw new ConsoleError(401, 'unauthenticated', 'Sign in to continue');
      }
      request.operator = context.operator;
      request.sessionTokenHash = hashSessionToken(token!);
    });

    scope.post('/admin/api/logout', async (request, reply) => {
      await revokeSession(request.sessionTokenHash);
      reply.header('Set-Cookie', clearedSessionCookie(config.secureCookies));
      return { ok: true };
    });

    scope.get('/admin/api/me', async (request) => ({ operator: operatorView(request.operator) }));

    registerConsoleRoutes(scope);
  });

  return app;
}
