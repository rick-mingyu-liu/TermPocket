import { getPool, query } from '../db/connection';
import { buildDemoData } from '../db/demoData';
import config = require('../config');
import logger = require('../utils/logger');
import type { PoolClient } from 'pg';

/**
 * Writes the demo account.
 *
 * One function serves both callers — `npm run db:seed` and the scheduled
 * refresh — because they must not drift. They differ in exactly one respect,
 * and it is the one that matters:
 *
 *   `create: true`   the seeder. May bring the demo account into existence.
 *   `create: false`  the scheduler. Refreshes an existing demo account and
 *                    creates nothing.
 *
 * ## Why the flag, and not the email address
 *
 * This deletes every transaction and goal belonging to its
 * target before rewriting them. Resolving that target by
 * `email = 'john.doe@example.com'` makes it a guessable string: the address is
 * ordinary, registration does not reserve it, and a scheduled job pointed at
 * it would wipe a real person's data every month with nobody watching. Run by
 * hand the exposure is bounded, because a human is present and would notice.
 * On a timer it is not.
 *
 * So the target is `is_demo = TRUE`, a column registration never sets, and the
 * unique partial index in the schema guarantees there is at most one.
 *
 * Like cleanupService, this **throws** rather than logging and returning: the
 * caller decides what a failed refresh means.
 */

const DEMO_EMAIL = 'john.doe@example.com';
// The credential every surface advertises — the login page, the README and the
// line `db:seed` prints — and the hash it has to verify against. Both are
// exported, and `test/demoAccountService.test.ts` pins them to each other with
// a real bcrypt.compare.
//
// That test exists because the pair silently disagreed for the entire life of
// the repo: the hash below was carried over from the first commit's seed.sql
// labelled "bcrypt hash of 'password123'", but it is bcrypt('password'). Every
// documented demo login was rejected and nothing failed loudly enough to say
// so. A comment cannot be wrong about this any more.
const DEMO_PASSWORD = 'password123';
const DEMO_PASSWORD_HASH = '$2a$10$Cz3uqiIWcKlJ1dCUqe2AkuYXGscpq9wwBNMDuTXqtCSbIzyPDMuQ.';

const OWNED_TABLES = ['transactions', 'savings_goals'];

/**
 * `VALUES ($1,$2,$3),($4,$5,$6),...` for `rows.length` rows of `width` columns.
 * One round trip instead of one per row.
 */
function valuesClause(rows: readonly unknown[], width: number): string {
  return rows
    .map((_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(',')})`)
    .join(',');
}

type RefreshStatus = 'refreshed' | 'created' | 'absent';

interface RefreshOptions {
  create?: boolean;
  now?: Date;
}

interface RefreshResult {
  status: RefreshStatus;
  userId?: number;
  deleted: number;
  inserted: number;
}

/**
 * Rewrites the demo account's data as of `now`.
 *
 * @returns `status` is 'refreshed', 'created', or 'absent' when there is no
 *   demo account and `create` was false.
 */
async function refreshDemoAccount({ create = false, now = new Date() }: RefreshOptions = {}): Promise<RefreshResult> {
  const data = buildDemoData(now);

  // A dedicated client, not db.query: the pool hands out a different
  // connection per call, so BEGIN and COMMIT issued through it need not land
  // on the same session and the rewrite would not be atomic at all.
  //
  // db/connection.ts declares getPool() as returning pg's own Pool, so
  // connect() already hands back a PoolClient and no cast is needed to
  // annotate it here.
  const client: PoolClient = await getPool().connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id FROM users WHERE is_demo = TRUE LIMIT 1'
    );

    let userId: number | undefined = existing.rows[0]?.id;
    let status: RefreshStatus = 'refreshed';

    if (!userId) {
      if (!create) {
        // Never create from a scheduled run: a job that can conjure its own
        // target cannot be reasoned about from the database's current state.
        await client.query('ROLLBACK');
        return { status: 'absent', deleted: 0, inserted: 0 };
      }
      const created = await client.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, email_verified, is_demo)
         VALUES ($1, $2, 'John', 'Doe', TRUE, TRUE)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash,
                                           email_verified = TRUE,
                                           is_demo = TRUE
         RETURNING id`,
        [DEMO_EMAIL, DEMO_PASSWORD_HASH]
      );
      userId = created.rows[0].id;
      status = 'created';
    }

    let deleted = 0;
    for (const table of OWNED_TABLES) {
      const result = await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
      // pg types rowCount as number | null; a DELETE always reports one, and
      // `deleted += null` coerced to a no-op addition in the original JS too.
      deleted += result.rowCount ?? 0;
    }

    const txRows = data.transactions.map((t) =>
      [userId, t.amount, t.description, t.category, t.type, t.date, t.currency]);
    await client.query(
      `INSERT INTO transactions (user_id, amount, description, category, type, date, currency)
       VALUES ${valuesClause(txRows, 7)}`,
      txRows.flat()
    );

    const goalRows = data.goals.map((g) =>
      [userId, g.name, g.target_amount, g.current_amount, g.target_date, g.description]);
    await client.query(
      `INSERT INTO savings_goals (user_id, name, target_amount, current_amount, target_date, description)
       VALUES ${valuesClause(goalRows, 6)}`,
      goalRows.flat()
    );

    await client.query('COMMIT');

    const inserted = txRows.length + goalRows.length;
    return { status, userId, deleted, inserted };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The scheduled form. Returns the number of rows deleted, which is what the
 * maintenance run logs and audits — and the deletion is the half worth
 * auditing, per decision D. The insert detail goes to the dev channel.
 */
async function refreshDemoAccountOnSchedule(now: Date = new Date()): Promise<number> {
  const result = await refreshDemoAccount({ create: false, now });

  if (result.status === 'absent') {
    // logger.error rather than warn: warn prints nothing in production, and a
    // refresh that quietly does nothing forever is exactly what needs saying
    // out loud. Reached only when the job is enabled but nothing is flagged.
    logger.error(
      'demoRefresh: no user has is_demo = TRUE, so nothing was refreshed. ' +
      'Run `npm run db:seed` once to create the demo account.'
    );
    return 0;
  }

  logger.info(`demoRefresh: wrote ${result.inserted} row(s) for user ${result.userId}`);
  return result.deleted;
}

type DemoFreshness =
  | { state: 'absent' }
  | { state: 'fresh' | 'stale'; userId: number; refreshedAt: string | null };

/**
 * The staleness check, exported so the database-backed test runs the exact
 * statement. `$1` is the limit in days.
 *
 * It measures the age of the last refresh, not of the newest transaction. The
 * demo login is public, so anything about the data a visitor can add (a row
 * dated today, a row dated next year) would let them postpone the refresh
 * indefinitely. The refresh inserts every row in one statement, so they share
 * a `created_at`; rows a visitor adds afterwards are created later, and an
 * edit does not change `created_at`. So `MIN(created_at)` is the time of the
 * last refresh for as long as any refreshed row survives. A visitor can move
 * it only by deleting every refreshed row, and even then only to the time of
 * their own oldest row, which ages like any other.
 *
 * `created_at` is TIMESTAMPTZ since migration 020 and a zone-less UTC
 * TIMESTAMP before it. Either way it is compared in SQL, on the database's
 * clock, with `now()` taken in UTC: before 020 that is the same kind of
 * value, and after it PostgreSQL reads the zone-less side in the session's
 * zone, which db/connection.ts sets to UTC. No local-time arithmetic anywhere.
 *
 * Resolved by `is_demo`, never by email, like the refresh itself. No row means
 * there is no demo account; a demo account with no transactions is stale.
 */
const DEMO_FRESHNESS_SQL = `
  SELECT u.id,
         to_char(MIN(t.created_at), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS refreshed_at,
         COALESCE(MIN(t.created_at) < (now() AT TIME ZONE 'UTC') - make_interval(days => $1::int), TRUE) AS stale
    FROM users u
    LEFT JOIN transactions t ON t.user_id = u.id
   WHERE u.is_demo = TRUE
   GROUP BY u.id`;

/** How stale the demo account is, in one read. See DEMO_FRESHNESS_SQL. */
async function demoAccountFreshness(staleDays: number = config.demo.staleDays): Promise<DemoFreshness> {
  const result = await query<{ id: number; refreshed_at: string | null; stale: boolean }>(
    DEMO_FRESHNESS_SQL,
    [staleDays]
  );
  const row = result.rows[0];
  if (!row) return { state: 'absent' };
  return { state: row.stale ? 'stale' : 'fresh', userId: row.id, refreshedAt: row.refreshed_at };
}

// Whether the missing-account error has been logged since this process started
// (or since the account was last seen). The check runs hourly; one line per
// process says it, twenty-four a day would bury everything else.
let absenceReported = false;

/**
 * The hourly maintenance form: refreshes the demo account only when its data
 * is stale, and returns the rows deleted (0 when nothing was refreshed).
 *
 * Throws on failure, like the refresh. With no demo account it writes nothing
 * and logs that once per process.
 */
async function refreshDemoAccountIfStale(now: Date = new Date()): Promise<number> {
  const freshness = await demoAccountFreshness();

  if (freshness.state === 'absent') {
    if (!absenceReported) {
      absenceReported = true;
      // error, not warn: warn prints nothing in production.
      logger.error(
        'demoRefresh: no user has is_demo = TRUE, so nothing was refreshed. ' +
        'Run `npm run db:seed` once to create the demo account.'
      );
    }
    return 0;
  }
  absenceReported = false;

  if (freshness.state === 'fresh') return 0;

  logger.info(
    `demoRefresh: last refreshed ${freshness.refreshedAt ?? 'never (no transactions)'}, ` +
    `limit ${config.demo.staleDays} day(s); refreshing`
  );
  return refreshDemoAccountOnSchedule(now);
}

/** Test hook: forget that the missing account was already reported. */
function resetAbsenceReport(): void {
  absenceReported = false;
}

export {
  refreshDemoAccount,
  refreshDemoAccountOnSchedule,
  refreshDemoAccountIfStale,
  demoAccountFreshness,
  resetAbsenceReport,
  DEMO_FRESHNESS_SQL,
  DEMO_EMAIL,
  DEMO_PASSWORD,
  DEMO_PASSWORD_HASH,
  OWNED_TABLES,
};
