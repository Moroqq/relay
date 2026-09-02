/**
 * Payments, and the deposit addresses they are issued against.
 */

import type { PoolClient } from 'pg';
import type { Asset, PaymentState } from '@relay/core';
import { newId } from '@relay/core';
import type { DepositWallet } from '@relay/wallet';

import { getPool, inTransaction, toBigInt, toBigIntOrNull, isUniqueViolation } from './pool.ts';
import { findProject, type ProjectRecord } from './projects.ts';

export interface PaymentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly externalRef: string | null;
  readonly asset: Asset;
  readonly expectedUnits: bigint;
  readonly receivedUnits: bigint;
  readonly state: PaymentState;
  readonly depositAddress: string;
  readonly confirmations: number;
  readonly requiredConfirmations: number;
  readonly feeRateBps: bigint;
  readonly feeFlatUnits: bigint;
  readonly feeUnits: bigint | null;
  readonly netUnits: bigint | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly settledAt: Date | null;
}

export const PAYMENT_COLUMNS = `
  id, project_id, external_ref, asset, expected_units, received_units, state,
  deposit_address, confirmations, required_confirmations,
  fee_rate_bps, fee_flat_units, fee_units, net_units,
  created_at, expires_at, settled_at
`;

export function mapPayment(row: Record<string, unknown>): PaymentRecord {
  return Object.freeze({
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    externalRef: (row['external_ref'] as string | null) ?? null,
    asset: row['asset'] as Asset,
    expectedUnits: toBigInt(row['expected_units']),
    receivedUnits: toBigInt(row['received_units']),
    state: row['state'] as PaymentState,
    depositAddress: row['deposit_address'] as string,
    confirmations: row['confirmations'] as number,
    requiredConfirmations: row['required_confirmations'] as number,
    feeRateBps: toBigInt(row['fee_rate_bps']),
    feeFlatUnits: toBigInt(row['fee_flat_units']),
    feeUnits: toBigIntOrNull(row['fee_units']),
    netUnits: toBigIntOrNull(row['net_units']),
    createdAt: row['created_at'] as Date,
    expiresAt: row['expires_at'] as Date,
    settledAt: (row['settled_at'] as Date | null) ?? null,
  });
}

export class PaymentError extends Error {
  override readonly name = 'PaymentError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Take the next deposit address.
 *
 * The index comes from a sequence, so two concurrent requests can never be
 * handed the same one. The address is derived from the master mnemonic on the
 * spot; no private key is written anywhere.
 */
async function allocateAddress(
  client: PoolClient,
  wallet: DepositWallet,
): Promise<{ address: string; index: number; path: string }> {
  const { rows } = await client.query<{ nextval: string }>(
    "SELECT nextval('deposit_address_index_seq') AS nextval",
  );
  const index = Number(rows[0]!.nextval);
  const derived = wallet.deriveAddress(index);

  await client.query(
    `INSERT INTO deposit_addresses (address, derivation_index, derivation_path, status, assigned_at)
     VALUES ($1, $2, $3, 'assigned', now())`,
    [derived.address, index, derived.path],
  );

  return { address: derived.address, index, path: derived.path };
}

export interface CreatePaymentInput {
  readonly projectId: string;
  readonly externalRef: string | null;
  readonly asset: Asset;
  readonly expectedUnits: bigint;
  readonly ttlMinutes: number;
  readonly requiredConfirmations: number;
}

export interface CreatePaymentResult {
  readonly payment: PaymentRecord;
  /** False when an existing payment was returned for a repeated external_ref. */
  readonly created: boolean;
}

async function findByExternalRef(
  client: PoolClient,
  projectId: string,
  externalRef: string,
): Promise<PaymentRecord | null> {
  const { rows } = await client.query(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE project_id = $1 AND external_ref = $2`,
    [projectId, externalRef],
  );
  return rows[0] === undefined ? null : mapPayment(rows[0]);
}

/**
 * Create a payment, or return the existing one for a repeated order reference.
 *
 * Idempotency is checked twice on purpose: once by reading, and once by
 * catching the unique violation. The read alone loses a race between two
 * simultaneous retries — both would find nothing, and both would insert. The
 * database is the only thing that can arbitrate that, so the second check is
 * the one that actually guarantees it.
 */
export async function createPayment(
  input: CreatePaymentInput,
  wallet: DepositWallet,
): Promise<CreatePaymentResult> {
  try {
    return await inTransaction(async (client) => {
      const project: ProjectRecord | null = await findProject(input.projectId, client);
      if (project === null) {
        throw new PaymentError('project_not_found', `Unknown project ${input.projectId}`);
      }
      if (project.status !== 'active') {
        throw new PaymentError('project_inactive', `Project ${project.id} is ${project.status}`);
      }

      if (input.externalRef !== null) {
        const existing = await findByExternalRef(client, project.id, input.externalRef);
        if (existing !== null) return { payment: existing, created: false };
      }

      const { address } = await allocateAddress(client, wallet);

      const { rows } = await client.query(
        `INSERT INTO payments (
           id, project_id, external_ref, asset, expected_units, deposit_address,
           required_confirmations, fee_rate_bps, fee_flat_units,
           tolerance_under_bps, tolerance_under_floor,
           tolerance_over_bps, tolerance_over_floor,
           expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   now() + make_interval(mins => $14))
         RETURNING ${PAYMENT_COLUMNS}`,
        [
          newId('payment'),
          project.id,
          input.externalRef,
          input.asset,
          input.expectedUnits.toString(),
          address,
          input.requiredConfirmations,
          project.feeRateBps.toString(),
          project.feeFlatUnits.toString(),
          project.toleranceUnderBps.toString(),
          project.toleranceUnderFloor.toString(),
          project.toleranceOverBps.toString(),
          project.toleranceOverFloor.toString(),
          input.ttlMinutes,
        ],
      );

      return { payment: mapPayment(rows[0]!), created: true };
    });
  } catch (error) {
    // Lost the race against a simultaneous retry of the same order: the other
    // transaction committed first and its payment is the canonical one.
    if (input.externalRef !== null && isUniqueViolation(error)) {
      const existing = await findPaymentByExternalRef(input.projectId, input.externalRef);
      if (existing !== null) return { payment: existing, created: false };
    }
    throw error;
  }
}

export async function findPayment(id: string): Promise<PaymentRecord | null> {
  const { rows } = await getPool().query(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1`,
    [id],
  );
  return rows[0] === undefined ? null : mapPayment(rows[0]);
}

export async function findPaymentByExternalRef(
  projectId: string,
  externalRef: string,
): Promise<PaymentRecord | null> {
  const { rows } = await getPool().query(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE project_id = $1 AND external_ref = $2`,
    [projectId, externalRef],
  );
  return rows[0] === undefined ? null : mapPayment(rows[0]);
}

export async function listPayments(
  projectId: string,
  options: { limit?: number } = {},
): Promise<PaymentRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const { rows } = await getPool().query(
    `SELECT ${PAYMENT_COLUMNS} FROM payments
      WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [projectId, limit],
  );
  return rows.map(mapPayment);
}
