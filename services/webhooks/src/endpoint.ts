/**
 * Deciding whether an endpoint is safe to call.
 *
 * The URL comes from the merchant, and our worker sits inside our own network.
 * Left unchecked, a merchant could point a webhook at `http://localhost:5433`
 * or at a cloud metadata service and use our worker as a probe into our
 * infrastructure — a request that our firewall would trust because it
 * originates from us. This is the standard server-side request forgery hole,
 * and a payment platform is a rewarding place to find one.
 *
 * The checks here are the cheap, honest ones: scheme, obvious private ranges,
 * and no redirect following. They do NOT defeat a hostname that resolves to a
 * private address at connect time (a DNS rebind). Closing that properly means
 * resolving the name ourselves and pinning the socket to the resolved public
 * address, or putting the worker behind an egress proxy that only reaches the
 * public internet. Until one of those exists, this is a mitigation and the
 * comment says so rather than implying otherwise.
 */

export interface EndpointPolicy {
  /** Production requires https and refuses private addresses outright. */
  readonly requireHttps: boolean;
  /** Development points webhooks at 127.0.0.1 constantly. */
  readonly allowPrivate: boolean;
}

export class EndpointRejected extends Error {
  override readonly name = 'EndpointRejected';
}

const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
]);

/** Literal IPv4 and IPv6 addresses that must never be reachable from here. */
function isPrivateAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (PRIVATE_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return true;
  }

  // IPv6 loopback and unique-local / link-local ranges.
  if (host === '::1' || host === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 === null) return false;

  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a >= 224) return true; // multicast and reserved
  return false;
}

export function assertEndpointAllowed(rawUrl: string, policy: EndpointPolicy): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EndpointRejected(`Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EndpointRejected(`Unsupported scheme ${url.protocol}`);
  }
  if (policy.requireHttps && url.protocol !== 'https:') {
    throw new EndpointRejected('Webhook endpoints must use https');
  }
  if (!policy.allowPrivate && isPrivateAddress(url.hostname)) {
    throw new EndpointRejected(`Refusing to call a private address: ${url.hostname}`);
  }

  return url;
}
