/**
 * The indexer loop.
 *
 * Reads TRON block by block, records transfers to our deposit addresses, keeps
 * confirmation counts current, and settles payments that have reached their
 * required depth. This is the process that makes money visible; without it the
 * API hands out addresses nobody is watching.
 */

import {
  closePool,
  expireStalePayments,
  getLastIndexedBlock,
  refreshConfirmations,
  settlePayment,
} from '@relay/db';

import { loadIndexerConfig } from './config.ts';
import { scanBlock } from './scan.ts';
import { TronClient } from './tron.ts';

const config = loadIndexerConfig();
const tron = new TronClient({ baseUrl: config.fullNode, apiKey: config.apiKey });

let running = true;

const log = (message: string, extra: Record<string, unknown> = {}): void => {
  const detail = Object.entries(extra)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  console.log(`[indexer] ${message}${detail === '' ? '' : ` ${detail}`}`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Where to resume.
 *
 * A fresh install starts near the head: there are no deposit addresses in the
 * chain's history, so scanning it would be millions of blocks of nothing.
 */
async function resumePoint(head: number): Promise<number> {
  const last = await getLastIndexedBlock();
  if (last !== null) return last + 1;

  const start = Math.max(head - config.startBehindHead, 0);
  log('no recorded position, starting near the head', { start });
  return start;
}

async function settleAll(paymentIds: Iterable<string>): Promise<void> {
  for (const paymentId of new Set(paymentIds)) {
    try {
      const outcome = await settlePayment(paymentId);
      if (outcome?.changed === true) {
        log('payment advanced', {
          payment: outcome.paymentId,
          from: outcome.previousState,
          to: outcome.state,
          confirmations: outcome.confirmations,
        });
      }
    } catch (error) {
      // One payment failing to settle must not stop the others. It stays open
      // and will be retried on the next pass.
      log('settlement failed', { payment: paymentId, error: (error as Error).message });
    }
  }
}

async function pass(): Promise<void> {
  const head = await tron.getHead();
  const from = await resumePoint(head.number);

  const touched = new Set<string>();

  if (from <= head.number) {
    const to = Math.min(head.number, from + config.batchSize - 1);
    for (let blockNumber = from; blockNumber <= to && running; blockNumber++) {
      const result = await scanBlock(tron, config, blockNumber);
      for (const paymentId of result.touchedPayments) touched.add(paymentId);
      if (result.transfersOurs > 0) {
        log('recorded transfers', {
          block: blockNumber,
          ours: result.transfersOurs,
          inserted: result.inserted,
        });
      }
    }
    if (to < head.number) {
      log('catching up', { at: to, head: head.number, behind: head.number - to });
    }
  }

  // Confirmations are recomputed from the head every pass, so a restart or a
  // missed cycle cannot leave a payment stuck one short of settling.
  for (const paymentId of await refreshConfirmations(head.number)) touched.add(paymentId);

  await settleAll(touched);

  const expired = await expireStalePayments();
  if (expired.length > 0) log('expired', { count: expired.length });
}

async function shutdown(signal: string): Promise<void> {
  log(`${signal} received, stopping`);
  running = false;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

log('started', {
  node: config.fullNode,
  contracts: [...config.contracts.keys()].join(','),
  interval: `${config.pollIntervalMs}ms`,
});

while (running) {
  try {
    await pass();
  } catch (error) {
    // A full node that is down, rate limiting, or returning nonsense is a
    // normal Tuesday. Log it and try again rather than exiting, or the
    // indexer will need a babysitter.
    log('pass failed, will retry', { error: (error as Error).message });
  }
  if (running) await sleep(config.pollIntervalMs);
}

await closePool();
log('stopped');
