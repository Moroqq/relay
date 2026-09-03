/**
 * The sweeper.
 *
 * Moves settled funds off deposit addresses to the merchants they belong to,
 * and only when doing so is worth the network fee.
 *
 * Broadcasting is off unless SWEEP_BROADCAST=true. A sweeper that only builds
 * and signs costs nothing when misconfigured; one that broadcasts by default
 * can empty every deposit address to the wrong place before anyone reads a log
 * line.
 */

import { closePool, findSweepCandidates, findUnfinishedSweeps, recordConfirmed } from '@relay/db';
import { TronClient } from '@relay/tron';

import { loadSweeperConfig } from './config.ts';
import { describeDecision, sweepPayment } from './sweep.ts';

const config = loadSweeperConfig();
const client = new TronClient({ baseUrl: config.fullNode, apiKey: config.apiKey });

let running = true;

const log = (message: string, extra: Record<string, unknown> = {}): void => {
  const detail = Object.entries(extra)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  console.log(`[sweeper] ${message}${detail === '' ? '' : ` ${detail}`}`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Check whether sweeps we already sent have landed, and book them. */
async function reconcile(): Promise<void> {
  for (const sweep of await findUnfinishedSweeps(config.batchSize)) {
    if (sweep.txHash === null) continue;

    const info = await client.getTransactionInfo(sweep.txHash);
    // Still pending, or never broadcast in dry-run mode.
    if (info === null) continue;

    if (info.receipt?.result !== undefined && info.receipt.result !== 'SUCCESS') {
      log('sweep failed on chain', { sweep: sweep.id, result: info.receipt.result });
      continue;
    }

    await recordConfirmed(
      sweep.id,
      BigInt(info.fee ?? 0),
      info.receipt?.energy_usage_total === undefined
        ? null
        : BigInt(info.receipt.energy_usage_total),
    );
    log('sweep confirmed', {
      sweep: sweep.id,
      payment: sweep.paymentId,
      tx: sweep.txHash.slice(0, 16),
      fee_sun: info.fee ?? 0,
    });
  }
}

async function pass(): Promise<void> {
  await reconcile();

  const candidates = await findSweepCandidates(config.batchSize);
  if (candidates.length === 0) return;

  // Prices are read once per pass rather than per sweep: they are governance
  // parameters that change by vote, not by the minute.
  const prices = await client.getChainPrices();

  for (const candidate of candidates) {
    if (!running) break;

    const outcome = await sweepPayment(candidate, client, prices, config);

    switch (outcome.kind) {
      case 'skipped':
        log('skipped', { payment: candidate.paymentId, reason: outcome.reason });
        break;
      case 'uneconomic':
        log('left in place', {
          payment: candidate.paymentId,
          verdict: outcome.decision.verdict,
          detail: describeDecision(outcome.decision, 'USDT'),
        });
        break;
      case 'signed':
        log('signed but NOT broadcast (dry run)', {
          payment: candidate.paymentId,
          tx: outcome.txHash.slice(0, 16),
          detail: describeDecision(outcome.decision, 'USDT'),
        });
        break;
      case 'broadcast':
        log('broadcast', {
          payment: candidate.paymentId,
          tx: outcome.txHash.slice(0, 16),
          detail: describeDecision(outcome.decision, 'USDT'),
        });
        break;
      case 'failed':
        log('failed', { payment: candidate.paymentId, reason: outcome.reason });
        break;
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`${signal} received, stopping`);
    running = false;
  });
}

log('started', {
  node: config.fullNode,
  mode: config.dryRun ? 'DRY RUN — nothing will be broadcast' : 'LIVE — funds will move',
  max_fee_bps: config.policy.maxFeeBps,
  min_units: config.policy.minValueUnits,
});

while (running) {
  try {
    await pass();
  } catch (error) {
    log('pass failed, will retry', { error: (error as Error).message });
  }
  if (running) await sleep(config.pollIntervalMs);
}

await closePool();
log('stopped');
