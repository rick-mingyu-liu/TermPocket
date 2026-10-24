import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { getPool } from '../db/connection';

/**
 * Settings -> Danger zone -> Delete account (`DELETE /auth/account`).
 *
 * Deletes the user row and every row that belongs to it, in one transaction on
 * a dedicated client (BEGIN and COMMIT through db.query could land on
 * different pooled connections).
 *
 * Every per-user table already cascades from `users` in schema.sql, directly
 * or through `agent_conversations`. The rows are still deleted explicitly,
 * children before parents, so that what is removed does not depend on the
 * foreign-key actions a long-lived database actually has, and so the audit
 * line can say how many rows went from each table. The DELETE of the user row
 * comes last and would cascade anything a future table adds before it is
 * listed here.
 *
 * `agent_admissions` goes too. It deliberately survives *history* deletion, so
 * clearing conversations cannot reset the hourly and daily turn budgets; but
 * those budgets bound one account's use, and a deleted account has none left
 * to use. Registering the address again creates a new user id and has to
 * verify the address again. The trade-off: the all-users daily count loses
 * the deleted account's turns. The per-user deletion limiter, email
 * verification and the provider-side spending limit bound that.
 *
 * The retention setting (`users.transaction_retention_terms`, migration 016)
 * is a column of the user row and goes with it.
 *
 * The demo account is refused: it is shared by every visitor and its password
 * is public.
 */

/** Per-user tables, children before parents. Constants, never user input. */
const OWNED_TABLES = [
  'agent_memory_proposals',
  'agent_memories',
  'agent_goal_proposals',
  'agent_messages',
  'agent_drafts',
  'agent_receipts',
  'agent_runs',
  'agent_admissions',
  'agent_conversations',
  'access_tokens',
  'import_batches',
  'savings_goals',
  'transactions',
] as const;

type OwnedTable = (typeof OWNED_TABLES)[number];

class AccountDemoError extends Error {
  code = 'account_demo';
  constructor() {
    super('The demo account cannot be deleted');
    this.name = 'AccountDemoError';
  }
}

class AccountPasswordError extends Error {
  code = 'account_password_incorrect';
  constructor() {
    super('The password is incorrect');
    this.name = 'AccountPasswordError';
  }
}

class AccountNotFoundError extends Error {
  code = 'account_not_found';
  constructor() {
    super('The account no longer exists');
    this.name = 'AccountNotFoundError';
  }
}

/** Rows deleted per table, plus the user row itself. */
type DeletedCounts = Partial<Record<OwnedTable, number>> & { users: number };

/**
 * Deletes the account after checking `password` against its hash. Throws
 * AccountNotFoundError, AccountDemoError or AccountPasswordError and deletes
 * nothing in those cases; a database error rolls everything back and is
 * rethrown.
 */
async function deleteAccount(userId: number, password: string): Promise<DeletedCounts> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE, not NO KEY UPDATE: the row is about to be deleted. It waits
    // for, and then blocks, the owner lock every agent transaction and token
    // creation takes, so none of them can add a row halfway through; once
    // this commits they find no user and stop.
    const found = await client.query<{ password_hash: string; is_demo: boolean }>(
      'SELECT password_hash, is_demo FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    const user = found.rows[0];
    if (!user) throw new AccountNotFoundError();
    if (user.is_demo) throw new AccountDemoError();
    if (!(await bcrypt.compare(password, user.password_hash))) throw new AccountPasswordError();

    // The agent tables exist only after migration 013, goal proposals only
    // after 015, and memories after 022; absent tables have nothing to delete.
    const present = await client.query<{ name: OwnedTable }>(
      'SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NOT NULL',
      [OWNED_TABLES]
    );
    const existing = new Set(present.rows.map((row) => row.name));

    const counts: Partial<Record<OwnedTable, number>> = {};
    for (const table of OWNED_TABLES) {
      if (!existing.has(table)) continue;
      const result = await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
      counts[table] = result.rowCount ?? 0;
    }
    const deletedUser = await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
    return { ...counts, users: deletedUser.rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/*
 * A running Pocky turn belongs to routes/agent.ts, which registers here to
 * abort that user's turns in this process once the deletion commits. Without
 * it the turn would still fail at its next tool call or at finishTurn (its run
 * row is gone), but only after spending model tokens until then.
 */
type AccountDeletedListener = (userId: number) => void;
const listeners = new Set<AccountDeletedListener>();

function onAccountDeleted(listener: AccountDeletedListener): void {
  listeners.add(listener);
}

function accountDeleted(userId: number): void {
  for (const listener of listeners) {
    try { listener(userId); } catch { /* aborting is best effort; the deletion has committed */ }
  }
}

export {
  OWNED_TABLES,
  AccountDemoError,
  AccountPasswordError,
  AccountNotFoundError,
  deleteAccount,
  onAccountDeleted,
  accountDeleted,
};
export type { DeletedCounts };
