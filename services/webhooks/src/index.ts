/**
 * The webhook delivery worker.
 *
 * Closes the loop: the indexer settles a payment, settlement queues a
 * notification, and this process tells the merchant. Several copies can run at
 * once — the queue hands each worker rows nobody else is holding.
 */

import { closePool, claimDueDeliveries, recordDeliveryResult } from '@relay/db';

import { deliver } from './deliver.ts';
import type { EndpointPolicy } from './endpoint.ts';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

const isProduction = process.env['TRON_NETWORK'] === 'mainnet';

const config = {
  pollIntervalMs: intEnv('WEBHOOK_POLL_MS', 2_000),
  batchSize: intEnv('WEBHOOK_BATCH_SIZE', 20),
  timeoutMs: intEnv('WEBHOOK_TIMEOUT_MS', 10_000),
  userAgent: 'Relay-Webhooks/0.1',
  policy: {
    requireHttps: isProduction,
    // Development points webhooks at 127.0.0.1 constantly; production must not.
    allowPrivate: !isProduction,
  } satisfies EndpointPolicy,
};

let running = true;

const log = (message: string, extra: Record<string, unknown> = {}): void => {
  const detail = Object.entries(extra)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  console.log(`[webhooks] ${message}${detail === '' ? '' : ` ${detail}`}`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function pass(): Promise<number> {
  const due = await claimDueDeliveries(config.batchSize);
  if (due.length === 0) return 0;

  // Sent in parallel: one merchant timing out for ten seconds must not hold up
  // notifications to every other merchant in the batch.
  await Promise.all(
    due.map(async (delivery) => {
      const result = await deliver(delivery, config);
      const recorded = await recordDeliveryResult(delivery, result);

      log(recorded.state, {
        delivery: delivery.id,
        payment: delivery.paymentId,
        event: delivery.event,
        attempt: `${recorded.attempt}/${delivery.maxAttempts}`,
        http: result.httpStatus ?? 'none',
        ms: Math.round(result.latencyMs),
        ...(recorded.nextAttemptAt === null
          ? {}
          : { retry_at: recorded.nextAttemptAt.toISOString() }),
      });
    }),
  );

  return due.length;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`${signal} received, stopping`);
    running = false;
  });
}

log('started', {
  interval: `${config.pollIntervalMs}ms`,
  batch: config.batchSize,
  https_only: config.policy.requireHttps,
});

while (running) {
  try {
    const handled = await pass();
    // Only pause when the queue is empty. A backlog is worked through as fast
    // as the endpoints will answer.
    if (handled === 0 && running) await sleep(config.pollIntervalMs);
  } catch (error) {
    log('pass failed, will retry', { error: (error as Error).message });
    if (running) await sleep(config.pollIntervalMs);
  }
}

await closePool();
log('stopped');
