/**
 * The merchant portal's HTTP server.
 *
 * Unlike the console, this one faces the internet: anyone may send an
 * application or try to sign in. Its defences are the console's — generic
 * sign-in failures with lockout, a CSRF header and origin check, strict
 * cookies, a strict content policy — plus rate limits on everything public.
 */

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { hashSessionToken, newSessionToken } from '@relay/auth';
import {
  countNewAccessRequests,
  createAccessRequest,
  createMerchantSession,
  resolveMerchantSession,
  revokeMerchantSession,
  writeAudit,
  type MerchantUserRecord,
} from '@relay/db';

import { checkAccessRequest } from './access.ts';
import type { PortalConfig } from './config.ts';
import { PortalError } from './errors.ts';
import { RateLimit } from './limits.ts';
import { completeInviteFlow, inspectInvite, login, startInvite } from './login.ts';
import { registerPortalRoutes } from './routes.ts';
import {
  clearedPortalCookie,
  PORTAL_SESSION_IDLE_SECONDS,
  PORTAL_SESSION_MAX_AGE_SECONDS,
  portalCookie,
  readPortalCookie,
} from './session.ts';
import { meView } from './views.ts';

export { PortalError };

declare module 'fastify' {
  interface FastifyRequest {
    merchantUser: MerchantUserRecord;
    portalTokenHash: string;
  }
}

/** The header a state-changing request must carry. */
export const CSRF_HEADER = 'x-relay-portal';

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

/** Invitation tokens are 32 random bytes, base64url. */
const isToken = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);

export interface PortalLimits {
  readonly applications: RateLimit;
  readonly logins: RateLimit;
  readonly invites: RateLimit;
}

export function defaultLimits(): PortalLimits {
  return {
    applications: new RateLimit(5, 60 * 60 * 1000),
    logins: new RateLimit(20, 10 * 60 * 1000),
    invites: new RateLimit(30, 10 * 60 * 1000),
  };
}

export function buildPortalServer(
  config: PortalConfig,
  options: { logger?: boolean; limits?: PortalLimits } = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16 * 1024, trustProxy: '127.0.0.1' });
  const limits = options.limits ?? defaultLimits();

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', request.url.startsWith('/app/assets/') && reply.statusCode === 200
      ? 'public, max-age=31536000, immutable'
      : 'no-store');
  });

  // Same three locks as the console: SameSite=Strict cookie, a custom header
  // another origin cannot send without a preflight, and a known Origin.
  app.addHook('preHandler', async (request) => {
    if (request.method === 'GET' || request.method === 'HEAD') return;
    if (request.headers[CSRF_HEADER] !== '1') throw new PortalError(403, 'csrf', 'Request refused');
    const origin = request.headers.origin;
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) throw new PortalError(403, 'csrf', 'Request refused');
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PortalError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    if ((error as { statusCode?: number }).statusCode === 400) {
      return reply.status(400).send({ error: { code: 'invalid_request', message: 'Request could not be parsed' } });
    }
    request.log.error({ err: error }, 'unhandled portal error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  const limit = (bucket: RateLimit, request: FastifyRequest) => {
    if (!bucket.take(request.ip)) throw new PortalError(429, 'rate_limited', 'Too many attempts. Wait a few minutes and try again.');
  };

  const signIn = async (user: MerchantUserRecord, request: FastifyRequest): Promise<string> => {
    const token = newSessionToken();
    await createMerchantSession({
      tokenHash: hashSessionToken(token),
      userId: user.id,
      maxAgeSeconds: PORTAL_SESSION_MAX_AGE_SECONDS,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    return portalCookie(token, config.secureCookies);
  };

  // ---- public: the website's application form ----
  app.post<{ Body: Record<string, unknown> }>('/portal/api/access-requests', async (request, reply) => {
    limit(limits.applications, request);
    const check = checkAccessRequest(request.body);
    if (check.kind === 'invalid') throw new PortalError(400, 'invalid_' + check.field, check.message);
    // A bot filled the hidden field: thank it and store nothing.
    if (check.kind === 'bot') return reply.status(201).send({ ok: true });
    const created = await createAccessRequest({ ...check.value, ip: request.ip, userAgent: request.headers['user-agent'] ?? null });
    await writeAudit({ operatorId: null, action: 'access.requested', subjectType: 'access_request', subjectId: created.id, detail: { company: created.company }, ip: request.ip });
    request.log.info({ pending: await countNewAccessRequests() }, 'new access request');
    return reply.status(201).send({ ok: true });
  });

  // ---- public: accepting an invitation (the token is the credential) ----
  app.post<{ Body: { token?: unknown } }>('/portal/api/invite/inspect', async (request) => {
    limit(limits.invites, request);
    const token = request.body?.token;
    const invite = isToken(token) ? await inspectInvite(hashSessionToken(token)) : null;
    if (invite === null) throw new PortalError(404, 'invite_invalid', 'This invitation link is not valid, or it has expired or been used');
    return { email: invite.email, name: invite.name, company: invite.merchantName, expires_at: invite.expiresAt.toISOString() };
  });

  app.post<{ Body: { token?: unknown } }>('/portal/api/invite/start', async (request) => {
    limit(limits.invites, request);
    const token = request.body?.token;
    const started = isToken(token) ? await startInvite(hashSessionToken(token), config.secretKey) : null;
    if (started === null) throw new PortalError(404, 'invite_invalid', 'This invitation link is not valid, or it has expired or been used');
    return { secret: started.secret, otpauth: started.uri };
  });

  app.post<{ Body: { token?: unknown; password?: unknown; code?: unknown } }>('/portal/api/invite/complete', async (request, reply) => {
    limit(limits.invites, request);
    const { token, password, code } = request.body ?? {};
    if (!isToken(token) || typeof password !== 'string' || typeof code !== 'string') {
      throw new PortalError(400, 'invalid_request', 'Request could not be parsed');
    }
    const result = await completeInviteFlow(
      { tokenHash: hashSessionToken(token), password, code: code.trim(), ip: request.ip, nowSeconds: Math.floor(Date.now() / 1000) },
      config.secretKey,
    );
    if (!result.ok) {
      if (result.reason === 'password') throw new PortalError(400, 'weak_password', 'Use a password of at least 12 characters');
      if (result.reason === 'code') throw new PortalError(400, 'wrong_code', 'That code is not right. Check the time on your phone and try the current code.');
      throw new PortalError(404, 'invite_invalid', 'This invitation link is not valid, or it has expired or been used');
    }
    reply.header('Set-Cookie', await signIn(result.user, request));
    return meView(result.user, config.network);
  });

  // ---- public: signing in ----
  app.post<{ Body: { email?: unknown; password?: unknown; code?: unknown } }>('/portal/api/login', async (request, reply) => {
    limit(limits.logins, request);
    const { email, password, code } = request.body ?? {};
    const invalid = new PortalError(401, 'invalid_credentials', 'Email, password or code is incorrect');
    if (typeof email !== 'string' || typeof password !== 'string' || typeof code !== 'string') throw invalid;
    if (email.length > 320 || password.length > 1024 || code.length > 16) throw invalid;
    const result = await login(
      { email: email.trim(), password, code: code.trim(), ip: request.ip, nowSeconds: Math.floor(Date.now() / 1000) },
      config.secretKey,
    );
    if (!result.ok) throw invalid;
    reply.header('Set-Cookie', await signIn(result.user, request));
    return meView(result.user, config.network);
  });

  // ---- everything else needs a merchant session ----
  app.register(async (scope) => {
    scope.addHook('preHandler', async (request, reply) => {
      const token = readPortalCookie(request.headers.cookie);
      const user = token === null ? null : await resolveMerchantSession(hashSessionToken(token), PORTAL_SESSION_IDLE_SECONDS);
      if (user === null) {
        reply.header('Set-Cookie', clearedPortalCookie(config.secureCookies));
        throw new PortalError(401, 'unauthenticated', 'Sign in to continue');
      }
      request.merchantUser = user;
      request.portalTokenHash = hashSessionToken(token!);
    });

    scope.post('/portal/api/logout', async (request, reply) => {
      await revokeMerchantSession(request.portalTokenHash);
      reply.header('Set-Cookie', clearedPortalCookie(config.secureCookies));
      return { ok: true };
    });

    scope.get('/portal/api/me', async (request) => meView(request.merchantUser, config.network));

    registerPortalRoutes(scope, config);
  });

  if (config.webDir) {
    app.register(fastifyStatic, { root: config.webDir, prefix: '/app/', redirect: true, cacheControl: false, etag: true });
  }

  return app;
}
