import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) { process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; process.env.NODE_ENV = 'test'; }

/**
 * The demo staleness check against real PostgreSQL. The demo login is public,
 * so what matters is that nothing a visitor can do to the rows postpones a
 * refresh that is due. Every case runs inside a transaction that is rolled
 * back, so the database's real demo account (if any) is never touched; the
 * unique is_demo index allows one, so any existing one is unflagged inside the
 * transaction first.
 */
describe('demo staleness against the database', { skip: !enabled }, () => {
  let db: typeof import('../db/connection');
  let sql: string;
  let client: PoolClient;

  before(async () => {
    db = require('../db/connection');
    sql = (require('../services/demoAccountService') as typeof import('../services/demoAccountService')).DEMO_FRESHNESS_SQL;
    client = await db.getPool().connect();
  });
  after(async () => { if (db) { client.release(); await db.getPool().end(); } });

  /** A fresh demo user inside a transaction; `body` returns the check's answer for `limit` days. */
  async function scenario(body: (userId: number) => Promise<void>, limit = 14): Promise<{ stale: boolean; refreshed_at: string | null }> {
    await client.query('BEGIN');
    try {
      await client.query('UPDATE users SET is_demo = FALSE WHERE is_demo = TRUE');
      const userId = (await client.query<{ id: number }>(
        "INSERT INTO users(email,password_hash,first_name,last_name,is_demo) VALUES($1,'x','Demo','Freshness',TRUE) RETURNING id",
        [`demo-freshness-${randomUUID()}@example.invalid`],
      )).rows[0]!.id;
      await body(userId);
      const rows = (await client.query<{ id: number; stale: boolean; refreshed_at: string | null }>(sql, [limit])).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.id, userId);
      return rows[0]!;
    } finally {
      await client.query('ROLLBACK');
    }
  }

  // created_at is a zone-less UTC timestamp; build it the same way.
  const daysAgo = (n: number): string => `(now() AT TIME ZONE 'UTC') - make_interval(days => ${n})`;
  // n days ago, but never before this month began, so the month rule stays out of the way.
  const daysAgoThisMonth = (n: number): string => `GREATEST(${daysAgo(n)}, date_trunc('month', now() AT TIME ZONE 'UTC'))`;
  const insertRow = (userId: number, created: number | string | null, date = 'CURRENT_DATE'): Promise<unknown> => client.query(
    `INSERT INTO transactions(user_id,amount,description,category,type,date,currency${created === null ? '' : ',created_at'})
     VALUES($1,'1.00','Fictional','Groceries','expense',${date},'CAD'${created === null ? '' : `,${typeof created === 'number' ? daysAgo(created) : created}`})`,
    [userId],
  );

  test('a fresh rewrite is fresh', async () => {
    const answer = await scenario(async (id) => { for (let i = 0; i < 3; i++) await insertRow(id, null); });
    assert.equal(answer.stale, false);
    assert.match(answer.refreshed_at!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test('no transactions is stale', async () => {
    const answer = await scenario(async () => {});
    assert.deepEqual(answer, { ...answer, stale: true, refreshed_at: null });
  });

  test('a refresh older than the limit is stale, one inside it is not', async () => {
    assert.equal((await scenario(async (id) => { await insertRow(id, 15); })).stale, true);
    assert.equal((await scenario(async (id) => { await insertRow(id, daysAgoThisMonth(13)); })).stale, false);
    assert.equal((await scenario(async (id) => { await insertRow(id, 8); }, 7)).stale, true);
  });

  test('a refresh in an earlier calendar month is stale, however recent', async () => {
    // An hour before this month began: inside any limit, but last month.
    const lastMonth = `date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 hour'`;
    assert.equal((await scenario(async (id) => { await insertRow(id, lastMonth); })).stale, true);
    // A visitor row added this month does not make it fresh again.
    assert.equal((await scenario(async (id) => { await insertRow(id, lastMonth); await insertRow(id, null); })).stale, true);
  });

  test('a visitor row added today does not postpone a refresh that is due', async () => {
    const answer = await scenario(async (id) => {
      await insertRow(id, 15);
      await insertRow(id, 15);
      await insertRow(id, null); // dated and created today
      await insertRow(id, null, "CURRENT_DATE + 365"); // dated next year
    });
    assert.equal(answer.stale, true);
  });

  test('editing a refreshed row does not postpone it either', async () => {
    const answer = await scenario(async (id) => {
      await insertRow(id, 15);
      await client.query("UPDATE transactions SET amount = '2.00', date = CURRENT_DATE WHERE user_id = $1", [id]);
    });
    assert.equal(answer.stale, true);
  });

  test('without a flagged user there is no row', async () => {
    await client.query('BEGIN');
    try {
      await client.query('UPDATE users SET is_demo = FALSE WHERE is_demo = TRUE');
      assert.deepEqual((await client.query(sql, [14])).rows, []);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
