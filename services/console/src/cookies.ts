/**
 * The session cookie, read and written by hand.
 *
 * One cookie, set in one place, is not worth a dependency — and its attributes
 * are the security of the session, so they are spelled out where they can be
 * read.
 */

import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from '@relay/auth';

export function readSessionCookie(header: string | undefined): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      // A session token is base64url; anything else was not issued by us.
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

/**
 * HttpOnly: page scripts cannot read it, so a cross-site scripting hole does
 * not become a stolen session. SameSite=Strict: the browser does not send it on
 * requests started by another site. Path=/ so it covers both the pages and the
 * API. Secure whenever the console is served over HTTPS.
 */
export function sessionCookie(token: string, secure: boolean): string {
  return [
    SESSION_COOKIE + '=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + SESSION_MAX_AGE_SECONDS,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return [SESSION_COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ');
}
