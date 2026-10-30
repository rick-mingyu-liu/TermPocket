import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) { process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; process.env.NODE_ENV = 'test'; }

/**
 * The stats queries against real PostgreSQL: they must parse on the shipped
 * schema, count an ordinary account's new rows and ignore the demo account's.
 * Everything runs inside one transaction that is rolled back.
 */
describe('stats against the database', { skip: !enabled }, () => {
  let db: typeof import('../db/connection');
  let stats: typeof import('../scripts/stats');
  let client: PoolClient;

  before(async () => {
    db = require('../db/connection');
    stats = require('../scripts/stats');
    client = await db.getPool().connect();
  });
  after(async () => { if (db) { client.release(); await db.getPool().end(); } });

  test('counts an ordinary account, never the demo account', async () => {
    // One snapshot, so rows other test files commit meanwhile cannot move the counts.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      const schema = String((await client.query('SELECT current_schema() AS s')).rows[0]!.s);
      const before = await stats.gatherStats(client, schema);
      const user = async (demo: boolean) => (await client.query<{ id: number }>(
        "INSERT INTO users(email,password_hash,first_name,last_name,email_verified,is_demo) VALUES($1,'x','Stats','Fictional',TRUE,$2) RETURNING id",
        [`stats-${randomUUID()}@example.invalid`, demo],
      )).rows[0]!.id;
      // At most one demo account exists: reuse it rather than unflag it, which would make its rows count.
      const existingDemo = (await client.query<{ id: number }>('SELECT id FROM users WHERE is_demo')).rows[0];
      const demoId = existingDemo ? existingDemo.id : await user(true);
      for (const id of [await user(false), demoId]) {
        await client.query("INSERT INTO transactions(user_id,amount,type,category,description,date,currency,source) VALUES($1,12.5,'expense','Dining Out','Fictional lunch',current_date,'CAD','agent')", [id]);
        await client.query("INSERT INTO savings_goals(user_id,name,target_amount,current_amount,target_date,currency) VALUES($1,'Fictional goal',500,0,current_date + 30,'CAD')", [id]);
      }
      const after = await stats.gatherStats(client, schema);
      const plusOne = (b: number | null, a: number | null) => assert.equal(a, (b ?? 0) + 1);
      plusOne(before.signups.d7, after.signups.d7);
      plusOne(before.verified.all, after.verified.all);
      plusOne(before.activeAccounts.d7, after.activeAccounts.d7);
      plusOne(before.transactions.d7, after.transactions.d7);
      plusOne(before.bySource.pocky.d30, after.bySource.pocky.d30);
      assert.equal(after.bySource.manual.d7, before.bySource.manual.d7);
      plusOne(before.goals.all, after.goals.all);
      assert.equal(after.pocky === null, before.pocky === null);
      assert.match(stats.formatStats(after, '2026-11-12'), /transactions added/);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
