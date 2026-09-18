/**
 * The merchant session cookie.
 *
 * Its own name, so a browser signed in to both the console and the portal
 * keeps two separate sessions. Longer than the console's: merchants check in
 * over a working day, and approving payouts is not something they can do.
 */

export const PORTAL_COOKIE = 'relay_portal';
export const PORTAL_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
export const PORTAL_SESSION_IDLE_SECONDS = 2 * 60 * 60;

export function readPortalCookie(header: string | undefined): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === PORTAL_COOKIE) {
      const value = part.slice(eq + 1).trim();
      // A session token is base64url; anything else was not issued by us.
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

/** HttpOnly, SameSite=Strict, Path=/, Secure over HTTPS: as the console's, for the same reasons. */
export function portalCookie(token: string, secure: boolean): string {
  return [
    PORTAL_COOKIE + '=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + PORTAL_SESSION_MAX_AGE_SECONDS,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedPortalCookie(secure: boolean): string {
  return [PORTAL_COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ');
}
