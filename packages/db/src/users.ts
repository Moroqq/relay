/**
 * Users of a merchant's platform, and the address each one deposits to.
 */

import { newId } from '@relay/core';
import type { DepositWallet } from '@relay/wallet';

import { getPool, inTransaction, isUniqueViolation } from './pool.ts';
import { findProject } from './projects.ts';

export interface EndUserRecord {
  readonly id: string;
  readonly projectId: string;
  /** The merchant's own identifier for this person. Opaque to us. */
  readonly externalRef: string;
  readonly depositAddress: string;
  readonly status: 'active' | 'blocked';
  readonly createdAt: Date;
  readonly lastDepositAt: Date | null;
}

export const END_USER_COLUMNS = `
  id, project_id, external_ref, deposit_address, status, created_at, last_deposit_at
`;

export function mapEndUser(row: Record<string, unknown>): EndUserRecord {
  return Object.freeze({
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    externalRef: row['external_ref'] as string,
    depositAddress: row['deposit_address'] as string,
    status: row['status'] as EndUserRecord['status'],
    createdAt: row['created_at'] as Date,
    lastDepositAt: (row['last_deposit_at'] as Date | null) ?? null,
  });
}

export class EndUserError extends Error {
  override readonly name = 'EndUserError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function findEndUser(
  projectId: string,
  externalRef: string,
): Promise<EndUserRecord | null> {
  const { rows } = await getPool().query(
    `SELECT ${END_USER_COLUMNS} FROM end_users WHERE project_id = $1 AND external_ref = $2`,
    [projectId, externalRef],
  );
  return rows[0] === undefined ? null : mapEndUser(rows[0]);
}

export async function findEndUserById(id: string): Promise<EndUserRecord | null> {
  const { rows } = await getPool().query(
    `SELECT ${END_USER_COLUMNS} FROM end_users WHERE id = $1`,
    [id],
  );
  return rows[0] === undefined ? null : mapEndUser(rows[0]);
}

export interface EnsureUserResult {
  readonly user: EndUserRecord;
  /** False when an existing user was returned rather than a new one created. */
  readonly created: boolean;
}

/**
 * Get this user's deposit address, assigning one the first time.
 *
 * Idempotent by (project, external_ref), and checked twice for the same
 * reason payment creation is: a read alone loses a race between two
 * simultaneous requests for the same user, and both would be handed a
 * different address. The unique index is what actually decides.
 *
 * An address, once assigned, is never rotated. Users save them, print them
 * into QR codes and set up recurring transfers to them; reassigning one sends
 * somebody's money to a stranger.
 */
export async function ensureEndUser(
  projectId: string,
  externalRef: string,
  wallet: DepositWallet,
): Promise<EnsureUserResult> {
  try {
    return await inTransaction(async (client) => {
      const project = await findProject(projectId, client);
      if (project === null) {
        throw new EndUserError('project_not_found', `Unknown project ${projectId}`);
      }
      if (project.status !== 'active') {
        throw new EndUserError('project_inactive', `Project ${project.id} is ${project.status}`);
      }

      const { rows: existing } = await client.query(
        `SELECT ${END_USER_COLUMNS} FROM end_users WHERE project_id = $1 AND external_ref = $2`,
        [projectId, externalRef],
      );
      if (existing[0] !== undefined) {
        return { user: mapEndUser(existing[0]), created: false };
      }

      // The sequence is what stops two concurrent requests deriving the same
      // index; the address itself is derived on the spot and no key is stored.
      const { rows: seq } = await client.query<{ nextval: string }>(
        "SELECT nextval('deposit_address_index_seq') AS nextval",
      );
      const index = Number(seq[0]!.nextval);
      const derived = wallet.deriveAddress(index);

      await client.query(
        `INSERT INTO deposit_addresses (address, derivation_index, derivation_path, status, assigned_at)
         VALUES ($1, $2, $3, 'assigned', now())`,
        [derived.address, index, derived.path],
      );

      const { rows } = await client.query(
        `INSERT INTO end_users (id, project_id, external_ref, deposit_address)
         VALUES ($1, $2, $3, $4)
         RETURNING ${END_USER_COLUMNS}`,
        [newId('endUser'), projectId, externalRef, derived.address],
      );

      return { user: mapEndUser(rows[0]!), created: true };
    });
  } catch (error) {
    // Lost the race: the other transaction committed first and its address is
    // the canonical one.
    if (isUniqueViolation(error)) {
      const existing = await findEndUser(projectId, externalRef);
      if (existing !== null) return { user: existing, created: false };
    }
    throw error;
  }
}

/** Which user, if any, owns this deposit address. */
export async function findEndUserByAddress(address: string): Promise<EndUserRecord | null> {
  const { rows } = await getPool().query(
    `SELECT ${END_USER_COLUMNS} FROM end_users WHERE deposit_address = $1`,
    [address],
  );
  return rows[0] === undefined ? null : mapEndUser(rows[0]);
}
