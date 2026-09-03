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

import {
  closePool,
  findSweepCandidates,
  findUnfinishedSweeps,
  findUserSweepCandidates,
  recordConfirmed,
  recordUserSweepConfirmed,
} from '@relay/db';
import { TronClient } from '@relay/tron';

import { loadSweeperConfig } from './config.ts';
import { describeDecision, sweepPayment, sweepUserAddress } from './sweep.ts';

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

    const feeSun = BigInt(info.fee ?? 0);
    const energyUsed =
      info.receipt?.energy_usage_total === undefined
        ? null
        : BigInt(info.receipt.energy_usage_total);

    // A payment sweep discharges what we owed the merchant; a user sweep
    // moves funds between two accounts we control and leaves the debt
    // standing. Booking one as the other would make the ledger lie.
    if (sweep.paymentId !== null) {
      await recordConfirmed(sweep.id, feeSun, energyUsed);
      log('sweep confirmed', {
        sweep: sweep.id,
        payment: sweep.paymentId,
        tx: sweep.txHash.slice(0, 16),
        fee_sun: info.fee ?? 0,
      });
    } else {
      const result = await recordUserSweepConfirmed(sweep.id, feeSun, energyUsed);
      log('consolidated', {
        sweep: sweep.id,
        address: sweep.fromAddress,
        deposits: result?.depositsSettled ?? 0,
        tx: sweep.txHash.slice(0, 16),
        fee_sun: info.fee ?? 0,
      });
    }
  }
}

async function pass(): Promise<void> {
  await reconcile();

  const payments = await findSweepCandidates(config.batchSize);
  const users = await findUserSweepCandidates(config.batchSize);
  if (payments.length === 0 && users.length === 0) return;

  // Prices are read once per pass rather than per sweep: they are governance
  // parameters that change by vote, not by the minute.
  const prices = await client.getChainPrices();

  const work = [
    ...payments.map((c) => ({ label: c.paymentId, run: () => sweepPayment(c, client, prices, config) })),
    ...users.map((c) => ({
      label: `${c.endUserId} (${c.depositCount} deposits)`,
      run: () => sweepUserAddress(c, client, prices, config),
    })),
  ];

  for (const item of work) {
    if (!running) break;

    const outcome = await item.run();

    switch (outcome.kind) {
      case 'skipped':
        log('skipped', { subject: item.label, reason: outcome.reason });
        break;
      case 'uneconomic':
        log('left in place', {
          subject: item.label,
          verdict: outcome.decision.verdict,
          detail: describeDecision(outcome.decision, 'USDT'),
        });
        break;
      case 'signed':
        log('signed but NOT broadcast (dry run)', {
          subject: item.label,
          tx: outcome.txHash.slice(0, 16),
          detail: describeDecision(outcome.decision, 'USDT'),
        });
        break;
      case 'broadcast':
        log('broadcast', {
          subject: item.label,
          tx: outcome.txHash.slice(0, 16),
          detail: describeDecision(outcome.decision, 'USDT'),
        });
        break;
      case 'failed':
        log('failed', { subject: item.label, reason: outcome.reason });
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
  treasury: config.treasuryAddress,
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
