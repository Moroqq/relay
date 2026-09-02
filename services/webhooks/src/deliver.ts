/**
 * Sending one webhook.
 */

import { SIGNATURE_HEADER, signPayload } from '@relay/core';
import type { DeliveryResult, DueDelivery } from '@relay/db';

import { assertEndpointAllowed, EndpointRejected, type EndpointPolicy } from './endpoint.ts';

export interface DeliverOptions {
  readonly timeoutMs: number;
  readonly policy: EndpointPolicy;
  readonly userAgent: string;
}

/**
 * POST the payload and report what happened.
 *
 * Never throws for a delivery failure — a merchant's endpoint being down is a
 * normal outcome, not an exception. The return value is what gets recorded,
 * and the retry decision is made from it.
 */
export async function deliver(
  delivery: DueDelivery,
  options: DeliverOptions,
): Promise<DeliveryResult> {
  const startedAt = performance.now();
  const elapsed = (): number => performance.now() - startedAt;

  let url: URL;
  try {
    url = assertEndpointAllowed(delivery.endpoint, options.policy);
  } catch (error) {
    // A rejected endpoint is permanent: no HTTP status, and retrying an
    // unreachable-by-policy URL every hour helps nobody.
    return {
      httpStatus: 400,
      latencyMs: elapsed(),
      error: error instanceof EndpointRejected ? error.message : String(error),
    };
  }

  // Serialised once: the bytes we sign must be the bytes we send, or the
  // merchant's verification fails for reasons nobody can reproduce.
  const body = JSON.stringify(delivery.payload);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': options.userAgent,
    'Relay-Event': delivery.event,
    'Relay-Delivery': delivery.id,
    'Relay-Attempt': String(delivery.attempt + 1),
  };

  if (delivery.secret !== null && delivery.secret !== '') {
    headers[SIGNATURE_HEADER] = signPayload(body, delivery.secret, Math.floor(Date.now() / 1000));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      // A redirect is a way to reach an address the policy just rejected.
      redirect: 'manual',
    });

    // Drain the body so the connection can be reused, but do not keep it:
    // a merchant's error page is not something to store per attempt.
    const text = await response.text().catch(() => '');

    return {
      httpStatus: response.status,
      latencyMs: elapsed(),
      error:
        response.status >= 200 && response.status < 300
          ? undefined
          : text.slice(0, 300) || undefined,
    };
  } catch (error) {
    const aborted = (error as { name?: string }).name === 'AbortError';
    return {
      httpStatus: null,
      latencyMs: elapsed(),
      error: aborted ? `Timed out after ${options.timeoutMs}ms` : (error as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}
