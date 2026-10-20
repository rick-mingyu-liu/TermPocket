import { query } from '../db/connection';
import config = require('../config');

/**
 * Scheduled deletions, owned by the service layer.
 *
 * These used to live on the controllers, and
 * `schedulerService` reached *up* into the controller layer to call them. That
 * inversion is the reason this file exists: a service must not depend on the
 * layer above it. Despite what CLAUDE.md claimed, no
 * HTTP route ever mounted them — the scheduler was the only caller, so the move
 * is a move, not a split.
 *
 * Each function **throws** on a database error rather than logging and
 * returning. Deciding what a failure means is the caller's job: the scheduler
 * wants to log it and stay alive, whereas a future admin endpoint would want to
 * return a 500. Swallowing it here would take that choice away from both, and
 * it is what let the old scheduler report "cleanup completed" for a cleanup
 * that had just failed.
 *
 * Each returns the number of rows deleted, so the caller has something worth
 * logging. Note that they deliberately do not `RETURNING` the deleted rows:
 * the previous version logged every deleted account's email address, which put
 * user email addresses into the server logs on a timer.
 */

/**
 * SQL condition for an unverified account that may be deleted, or replaced by
 * a new registration of the same address. `$<minutesParam>` and
 * `$<maxMinutesParam>` must be bound to `config.dataRetention.unverifiedAccountMinutes`
 * and `unverifiedAccountMaxMinutes`.
 *
 * Age alone is not enough. An unverified user who signs in is offered "Resend
 * verification email", which issues a fresh link but leaves created_at alone;
 * judged on created_at, the account could go minutes after that link was sent.
 * So it must also have no live link, unless it has passed the hard cap, which
 * stops anyone keeping a registration of someone else's address alive by
 * resending forever.
 */
function unverifiedAccountIsStale(minutesParam: number, maxMinutesParam: number): string {
  return (
    'email_verified = FALSE AND (' +
    `(created_at < NOW() - make_interval(mins => $${minutesParam}) ` +
    'AND (email_verification_expires IS NULL OR email_verification_expires < NOW())) ' +
    `OR created_at < NOW() - make_interval(mins => $${maxMinutesParam}))`
  );
}

const staleParams = (): [number, number] => [
  config.dataRetention.unverifiedAccountMinutes,
  config.dataRetention.unverifiedAccountMaxMinutes,
];

/** Deletes unverified accounts that unverifiedAccountIsStale() matches. Returns the row count. */
async function deleteUnverifiedAccounts(): Promise<number | null> {
  const result = await query(`DELETE FROM users WHERE ${unverifiedAccountIsStale(1, 2)}`, staleParams());
  return result.rowCount;
}

/**
 * Deletes the unverified account registered under `email` in any case, if it
 * is stale, so that a new registration can take the address. Returns whether
 * one was deleted. A verified account, or an unverified one still inside its
 * window, is never touched. Case-insensitive like register's lookup, because
 * users.email is unique on lower(email) (migration 021).
 */
async function reclaimStaleUnverifiedAccount(email: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM users WHERE lower(email) = lower($1) AND ${unverifiedAccountIsStale(2, 3)}`,
    [email, ...staleParams()]
  );
  return (result.rowCount ?? 0) > 0;
}

export { deleteUnverifiedAccounts, reclaimStaleUnverifiedAccount, unverifiedAccountIsStale };
