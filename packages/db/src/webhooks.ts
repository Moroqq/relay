/**
 * The webhook delivery queue.
 */

import { MAX_WEBHOOK_ATTEMPTS, retryDelayMs, shouldRetry, type WebhookState } from '@relay/core';

import { getPool } from './pool.ts';

export interface DueDelivery {
  readonly id: string;
  readonly paymentId: string;
  readonly projectId: string;
  readonly event: string;
  readonly endpoint: string;
  readonly payload: unknown;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** The project's signing secret. Null means the merchant never set one. */
  readonly secret: string | null;
}

/**
 * How long a claimed delivery is invisible to other workers.
 *
 * This is a lease, not a lock. If the worker crashes mid-send the row simply
 * becomes due again after it expires, rather than sitting claimed forever —
 * which is what a plain status flag would do, and the failure would be a
 * merchant who never hears about a payment.
 */
const LEASE_SECONDS = 60;

/**
 * Take up to `limit` deliveries that are due.
 *
 * `FOR UPDATE SKIP LOCKED` is what allows several workers to run at once: each
 * takes rows nobody else is holding instead of queueing behind them. Without
 * it, a second worker either blocks or sends the same webhook twice.
 */
export async function claimDueDeliveries(limit: number): Promise<DueDelivery[]> {
  const { rows } = await getPool().query(
    `WITH claimed AS (
       SELECT id FROM webhook_deliveries
        WHERE state IN ('pending', 'retrying')
          AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE webhook_deliveries d
        SET next_attempt_at = now() + make_interval(secs => $2)
       FROM claimed, projects p
      WHERE d.id = claimed.id AND p.id = d.project_id
     RETURNING d.id, d.payment_id, d.project_id, d.event, d.endpoint, d.payload,
               d.attempt, d.max_attempts, p.webhook_secret`,
    [limit, LEASE_SECONDS],
  );

  return rows.map((row) =>
    Object.freeze({
      id: row['id'] as string,
      paymentId: row['payment_id'] as string,
      projectId: row['project_id'] as string,
      event: row['event'] as string,
      endpoint: row['endpoint'] as string,
      payload: row['payload'],
      attempt: row['attempt'] as number,
      maxAttempts: (row['max_attempts'] as number) ?? MAX_WEBHOOK_ATTEMPTS,
      secret: (row['webhook_secret'] as string | null) ?? null,
    }),
  );
}

export interface DeliveryResult {
  readonly httpStatus: number | null;
  readonly latencyMs: number;
  readonly error?: string | undefined;
}

export interface RecordedDelivery {
  readonly state: WebhookState;
  readonly attempt: number;
  readonly nextAttemptAt: Date | null;
}

/**
 * Record what happened and decide what comes next.
 *
 * The decision itself — retry or give up — lives in `@relay/core`, so the
 * worker, the console and any operator tooling all read the same rule.
 */
export async function recordDeliveryResult(
  delivery: DueDelivery,
  result: DeliveryResult,
): Promise<RecordedDelivery> {
  const attempt = delivery.attempt + 1;
  const delivered =
    result.httpStatus !== null && result.httpStatus >= 200 && result.httpStatus < 300;

  let state: WebhookState;
  let nextDelayMs: number | null = null;

  if (delivered) {
    state = 'delivered';
  } else if (shouldRetry(attempt, result.httpStatus)) {
    state = 'retrying';
    nextDelayMs = retryDelayMs(attempt + 1);
  } else {
    // Either the attempts are spent, or the merchant rejected the payload and
    // will reject it identically next time. Both are a human's problem now,
    // which is what the exceptions queue in the console is for.
    state = 'failed';
  }

  const { rows } = await getPool().query(
    `UPDATE webhook_deliveries
        SET state = $2::webhook_state_t,
            attempt = $3,
            http_status = $4,
            latency_ms = $5,
            error = $6,
            -- Cast both uses of $2 explicitly. Postgres deduces a parameter's
            -- type from its first use, and comparing an enum column against a
            -- bare literal here made it text in one place and the enum in the
            -- other.
            delivered_at = CASE WHEN $2::text = 'delivered' THEN now() ELSE delivered_at END,
            next_attempt_at = CASE
              WHEN $7::bigint IS NULL THEN next_attempt_at
              ELSE now() + make_interval(secs => $7::bigint / 1000.0)
            END
      WHERE id = $1
      RETURNING next_attempt_at`,
    [
      delivery.id,
      state,
      attempt,
      result.httpStatus,
      Math.round(result.latencyMs),
      result.error ?? null,
      nextDelayMs,
    ],
  );

  return {
    state,
    attempt,
    nextAttemptAt: state === 'retrying' ? ((rows[0]?.['next_attempt_at'] as Date) ?? null) : null,
  };
}
