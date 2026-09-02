/**
 * Entry point.
 */

import { closePool } from '@relay/db';

import { loadConfig } from './config.ts';
import { buildServer } from './server.ts';

const config = loadConfig();

const app = buildServer({
  wallet: config.wallet,
  requiredConfirmations: config.requiredConfirmations,
  paymentTtlMinutes: config.paymentTtlMinutes,
  logger: true,
});

/**
 * Finish in-flight requests before exiting. A process killed mid-request can
 * leave a payment created in the database whose address the merchant never
 * received — money will arrive at an address nobody is waiting on.
 */
async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} received, shutting down`);
  try {
    await app.close();
    await closePool();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Relay API on ${config.host}:${config.port} — TRON ${config.network}, ` +
      `${config.requiredConfirmations} confirmations, ${config.paymentTtlMinutes} minute window`,
  );
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
