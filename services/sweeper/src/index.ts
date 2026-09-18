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
  reportServiceStatus,
} from '@relay/db';
import { TronClient, USDT_TRX_DESCRIPTION, priceFromRound, type ChainPrices } from '@relay/tron';
import { decodeAddress } from '@relay/wallet';

import { loadSweeperSettings, type SweeperConfig } from './config.ts';
import { startControlServer } from './control.ts';
import { KeyHolder } from './keys.ts';
import { describeDecision, sweepPayment, sweepUserAddress } from './sweep.ts';
import { reconcilePayout, sendPayout } from './payouts.ts';
import { reconcileVerdict } from './payout-reconcile.ts';

const config = loadSweeperSettings();
const holder = new KeyHolder(config, config.keySource);
const client = new TronClient({ baseUrl: config.fullNode, apiKey: config.apiKey });

let running = true;

const log = (message: string, extra: Record<string, unknown> = {}): void => {
  const detail = Object.entries(extra)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  console.log(`[sweeper] ${message}${detail === '' ? '' : ` ${detail}`}`);
};

let wake: (() => void) | null = null;
/** Wait for the next pass — or less, if an unlock means there is work to do now. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void { clearTimeout(timer); wake = null; resolve(); }
    wake = done;
  });

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

/**
 * See signed payouts through to done, and send the approved ones — the second
 * part only while the keys are unlocked.
 */
async function payouts(prices: ChainPrices | null, working: SweeperConfig | null): Promise<void> {
  const now = Date.now();

  for (const payout of await findUnfinishedPayouts(config.batchSize)) {
    const outcome = await reconcilePayout(payout, client, now);
    if (outcome.kind !== 'waiting') {
      log(`payout ${outcome.kind}`, { payout: payout.id, ...('reason' in outcome ? { reason: outcome.reason } : {}) });
    }
  }

  const sendable = await findSendablePayouts(config.batchSize);
  if (sendable.length === 0) return;
  if (working === null) {
    remindLocked('approved payouts are');
    return;
  }
  const livePrices = prices ?? (await client.getChainPrices());

  for (const payout of sendable) {
    if (!running) break;
    const outcome = await sendPayout(payout, client, livePrices, working);
    log(outcome.kind === 'signed' ? 'payout signed but NOT broadcast (dry run)' : `payout ${outcome.kind}`, {
      payout: payout.id,
      to: payout.toAddress,
      net: formatAmount(payout.netUnits, 'USDT', { trimTrailingZeros: true }),
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
      ...('txHash' in outcome ? { tx: outcome.txHash.slice(0, 16) } : {}),
    });
  }
}


const priceFeedHex = Buffer.from(decodeAddress(config.priceFeed)).toString('hex');

/**
 * The oracle's TRX price for this pass, or the reason there is none.
 *
 * No price means no sweeps this pass, and nothing else. The price only decides
 * whether a sweep is worth its fee, so waiting for a trustworthy one loses
 * time and never money. Payouts do not use it and are not held up.
 */
async function readTrxPrice(): Promise<{ ok: true; units: bigint } | { ok: false; reason: string }> {
  try {
    const feed = await client.readPriceFeed(priceFeedHex);
    // Checked every pass, not only at startup: a proxy can be repointed.
    if (feed.description !== USDT_TRX_DESCRIPTION) {
      return { ok: false, reason: 'price feed describes itself as "' + feed.description + '", expected "' + USDT_TRX_DESCRIPTION + '"' };
    }
    const verdict = priceFromRound(feed.round, {
      nowSeconds: Math.floor(Date.now() / 1000),
      decimals: feed.decimals,
      maxAgeSeconds: config.maxPriceAgeSeconds,
    });
    return verdict.ok ? { ok: true, units: verdict.trxPriceUnits } : { ok: false, reason: verdict.reason };
  } catch (error) {
    return { ok: false, reason: 'price feed unreadable: ' + (error as Error).message };
  }
}

/** Tell the console where signing stands. A failed report never stops a pass. */
async function report(): Promise<void> {
  try {
    await reportServiceStatus('sweeper', holder.state, {
      payouts: config.payoutsDryRun ? 'dry_run' : 'live',
      sweeps: config.dryRun ? 'dry_run' : 'live',
      key_source: config.keySource.kind,
      hot_wallet: config.hotWalletAddress,
      poll_ms: config.pollIntervalMs,
    });
  } catch (error) {
    log('could not report status', { error: (error as Error).message });
  }
}

let lastReminder = 0;
/** Say that work is waiting on an unlock — every few minutes, not every pass. */
function remindLocked(what: string): void {
  if (Date.now() - lastReminder < 5 * 60_000) return;
  lastReminder = Date.now();
  log('LOCKED: ' + what + ' waiting. Unlock with: npm run keys:unlock');
}

async function pass(): Promise<void> {
  await report();
  await reconcile();

  // Read once: a lock arriving mid-pass takes effect from the next one.
  const keys = holder.keys;
  const working: SweeperConfig | null = keys === null ? null : { ...config, ...keys };
  await payouts(null, working);

  const payments = await findSweepCandidates(config.batchSize);
  const users = await findUserSweepCandidates(config.batchSize);
  if (payments.length === 0 && users.length === 0) return;
  if (working === null) {
    remindLocked('deposits to sweep are');
    return;
  }

  const price = await readTrxPrice();
  if (!price.ok) {
    log('sweeps waiting for a usable TRX price', { reason: price.reason, addresses: payments.length + users.length });
    return;
  }

  // Resource prices are read once per pass rather than per sweep: they are
  // governance parameters that change by vote, not by the minute.
  const prices = await client.getChainPrices();

  const work = [
    ...payments.map((c) => ({ label: c.paymentId, run: () => sweepPayment(c, client, prices, price.units, working) })),
    ...users.map((c) => ({
      label: `${c.endUserId} (${c.depositCount} deposits)`,
      run: () => sweepUserAddress(c, client, prices, price.units, working),
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

const initialPrice = await readTrxPrice();
if (!initialPrice.ok && /describes itself|unreadable/.test(initialPrice.reason)) {
  // A feed that is the wrong contract is a configuration error, not a transient
  // one. Stale is different: sweeps wait, the service runs.
  log('refusing to start', { reason: initialPrice.reason, feed: config.priceFeed });
  process.exit(1);
}

log('started', {
  price_feed: config.priceFeed,
  trx_price: initialPrice.ok ? (Number(initialPrice.units) / 1e6).toFixed(6) + ' USDT' : 'unusable: ' + initialPrice.reason,
  node: config.fullNode,
  treasury: config.treasuryAddress,
  hot_wallet: config.hotWalletAddress,
  keys: config.keySource.kind === 'keystore' ? 'LOCKED until unlocked (npm run keys:unlock)' : 'from WALLET_MNEMONIC (development)',
  payouts: config.payoutsDryRun ? 'DRY RUN' : 'LIVE — payouts will be sent',
  mode: config.dryRun ? 'DRY RUN — nothing will be broadcast' : 'LIVE — funds will move',
  max_fee_bps: config.policy.maxFeeBps,
  min_units: config.policy.minValueUnits,
});

const control = config.keySource.kind === 'keystore'
  ? await startControlServer(config.keySource.controlSocket, holder, {
      log,
      onChange: (state, how) => {
        log('keys ' + how, { state });
        void report();
        if (state === 'unlocked') wake?.();
      },
    })
  : null;
if (control !== null && config.keySource.kind === 'keystore') {
  log('waiting to be unlocked', { socket: config.keySource.controlSocket });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => wake?.());
}

while (running) {
  try {
    await pass();
  } catch (error) {
    log('pass failed, will retry', { error: (error as Error).message });
  }
  if (running) await sleep(config.pollIntervalMs);
}

control?.close();
holder.lock();
await closePool();
log('stopped');
