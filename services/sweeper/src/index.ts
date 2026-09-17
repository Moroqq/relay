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

import { formatAmount } from '@relay/core';
import {
  closePool,
  expireSweep,
  findSendablePayouts,
  findSweepCandidates,
  findUnfinishedPayouts,
  findUnfinishedSweeps,
  findUserSweepCandidates,
  recordConfirmed,
  recordUserSweepConfirmed,
} from '@relay/db';
import { TronClient, type ChainPrices } from '@relay/tron';

import { loadSweeperConfig } from './config.ts';
import { describeDecision, sweepPayment, sweepUserAddress } from './sweep.ts';
import { reconcilePayout, sendPayout } from './payouts.ts';
import { reconcileVerdict } from './payout-reconcile.ts';

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

/**
 * Check whether sweeps already sent have landed, and book or release them.
 *
 * Uses the same verdict as payouts. The first version booked a sweep the
 * moment the ordinary node reported it — before its block was irreversible —
 * and left a sweep that reverted on chain in place forever, which kept its
 * address from ever being swept again.
 */
async function reconcile(): Promise<void> {
  const now = Date.now();

  for (const sweep of await findUnfinishedSweeps(config.batchSize)) {
    if (sweep.txHash === null) continue;

    const [solidified, seen] = await Promise.all([
      client.getTransactionInfo(sweep.txHash, { solidified: true }),
      client.getTransactionInfo(sweep.txHash),
    ]);
    const verdict = reconcileVerdict({ solidified, seen }, sweep.signedTx, sweep.attempt, now);

    if (verdict.kind === 'wait') continue;

    if (verdict.kind !== 'complete') {
      // Reverted, expired, or out of attempts: nothing moved, so the address
      // is released and the funds are swept afresh on a later pass.
      const reason = verdict.kind === 'rebuild' ? 'expired without landing' : verdict.reason;
      await expireSweep(sweep.id, reason);
      log('sweep released', { sweep: sweep.id, address: sweep.fromAddress, reason });
      continue;
    }

    const energyUsed =
      solidified?.receipt?.energy_usage_total === undefined
        ? null
        : BigInt(solidified.receipt.energy_usage_total);

    // A payment sweep discharges what we owed the merchant; a user sweep
    // moves funds between two accounts we control and leaves the debt
    // standing. Booking one as the other would make the ledger lie.
    if (sweep.paymentId !== null) {
      await recordConfirmed(sweep.id, verdict.feeSun, energyUsed);
      log('sweep confirmed', { sweep: sweep.id, payment: sweep.paymentId, fee_sun: verdict.feeSun });
    } else {
      const result = await recordUserSweepConfirmed(sweep.id, verdict.feeSun, energyUsed);
      log('consolidated', {
        sweep: sweep.id,
        address: sweep.fromAddress,
        deposits: result?.depositsSettled ?? 0,
        fee_sun: verdict.feeSun,
      });
    }
  }
}

/** See signed payouts through to done, and send the approved ones. */
async function payouts(prices: ChainPrices | null): Promise<void> {
  const now = Date.now();

  for (const payout of await findUnfinishedPayouts(config.batchSize)) {
    const outcome = await reconcilePayout(payout, client, now);
    if (outcome.kind !== 'waiting') {
      log(`payout ${outcome.kind}`, { payout: payout.id, ...('reason' in outcome ? { reason: outcome.reason } : {}) });
    }
  }

  const sendable = await findSendablePayouts(config.batchSize);
  if (sendable.length === 0) return;
  const livePrices = prices ?? (await client.getChainPrices());

  for (const payout of sendable) {
    if (!running) break;
    const outcome = await sendPayout(payout, client, livePrices, config);
    log(outcome.kind === 'signed' ? 'payout signed but NOT broadcast (dry run)' : `payout ${outcome.kind}`, {
      payout: payout.id,
      to: payout.toAddress,
      net: formatAmount(payout.netUnits, 'USDT', { trimTrailingZeros: true }),
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
      ...('txHash' in outcome ? { tx: outcome.txHash.slice(0, 16) } : {}),
    });
  }
}

async function pass(): Promise<void> {
  await reconcile();
  await payouts(null);

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
  hot_wallet: config.hotWallet.address,
  payouts: config.payoutsDryRun ? 'DRY RUN' : 'LIVE — payouts will be sent',
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
