import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { packageRoot } from '../utils/packageRoot';

/**
 * Migrations 018-021: owners required and values checked (018), the
 * transaction list's index (019), TIMESTAMPTZ on the original tables (020)
 * and one account per address whatever its case (021).
 *
 * The pre-018 schema is schema.sql taken back by reverse DDL to what
 * production has: nullable owners, no value CHECKs, 006's index, TIMESTAMP
 * columns, no lower(email) index. Applied twice to it (with rows) and twice to
 * a fresh schema.sql, the four must produce exactly what schema.sql declares.
 * 020 must keep every instant even when the session applying it is not in
 * UTC, and must not rewrite transactions (agent undo compares xmin). 018 and
 * 021 must refuse legacy rows that break their rules, changing nothing.
 *
 * Needs an explicit TEST_DATABASE_URL, never the .env database. All DDL runs in
 * a random schema that is dropped afterwards; every row is fictional.
 */
const TABLES = ['users', 'transactions', 'savings_goals', 'import_batches', 'access_tokens'];
const MIGRATIONS = ['018_owner_and_value_checks.sql', '019_transactions_list_index.sql', '020_timestamptz.sql', '021_unique_email_lowercase.sql'];

const DOWNGRADE = `
  DROP INDEX idx_users_email_lower;
  DROP INDEX idx_transactions_user_date_id;
  CREATE INDEX idx_transactions_user_date ON transactions(user_id, date DESC, created_at DESC);
  ALTER TABLE transactions ALTER COLUMN user_id DROP NOT NULL,
    DROP CONSTRAINT transactions_amount_check, DROP CONSTRAINT transactions_currency_check;
  ALTER TABLE savings_goals ALTER COLUMN user_id DROP NOT NULL,
    DROP CONSTRAINT savings_goals_target_amount_check, DROP CONSTRAINT savings_goals_current_amount_check,
    DROP CONSTRAINT savings_goals_currency_check;
  ALTER TABLE import_batches ALTER COLUMN user_id DROP NOT NULL;
  SET TIME ZONE 'UTC';
  ALTER TABLE users ALTER COLUMN email_verification_expires TYPE TIMESTAMP, ALTER COLUMN created_at TYPE TIMESTAMP,
    ALTER COLUMN updated_at TYPE TIMESTAMP, ALTER COLUMN terms_accepted_at TYPE TIMESTAMP;
  ALTER TABLE transactions ALTER COLUMN created_at TYPE TIMESTAMP, ALTER COLUMN updated_at TYPE TIMESTAMP;
  ALTER TABLE savings_goals ALTER COLUMN created_at TYPE TIMESTAMP, ALTER COLUMN updated_at TYPE TIMESTAMP;
  ALTER TABLE import_batches ALTER COLUMN created_at TYPE TIMESTAMP;
  ALTER TABLE access_tokens ALTER COLUMN created_at TYPE TIMESTAMP, ALTER COLUMN last_used_at TYPE TIMESTAMP,
    ALTER COLUMN revoked_at TYPE TIMESTAMP;
`;

const catalog = async (client: PoolClient, schema: string) => ({
  columns: (await client.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = ANY($2) ORDER BY table_name, column_name`, [schema, TABLES])).rows,
  constraints: (await client.query(
    `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE connamespace = $1::regnamespace AND conrelid::regclass::text = ANY($2) ORDER BY 1, 2`, [schema, TABLES])).rows,
  indexes: (await client.query(
    `SELECT tablename, indexname, replace(indexdef, $1 || '.', '') AS def FROM pg_indexes
     WHERE schemaname = $1 AND tablename = ANY($2) ORDER BY 1, 2`, [schema, TABLES])).rows,
});

test('migrations 018-021: idempotent on the pre-018 schema and on a fresh one, and match schema.sql', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  const schema = `integrity_migration_${randomUUID().replaceAll('-', '')}`;
  const root = packageRoot(__dirname);
  const desired = readFileSync(path.join(root, 'db/schema.sql'), 'utf8');
  const migrations = MIGRATIONS.map((name) => readFileSync(path.join(root, 'db/migrations', name), 'utf8'));
  const migrate = async () => { for (const sql of migrations) await client.query(sql); };
  const reset = async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
  };
  const previous = async () => {
    await reset();
    await client.query(desired);
    await client.query(DOWNGRADE);
  };
  const addUser = async (email: string) => (await client.query<{ id: number }>(
    "INSERT INTO users(email,password_hash,first_name,last_name,email_verified,created_at) VALUES($1,'x','Migration','Test',TRUE,'2026-10-20 12:00:00') RETURNING id",
    [email])).rows[0]!.id;

  try {
    // Fresh: schema.sql already is the end state; the migrations change nothing, twice.
    await reset();
    await client.query(desired);
    const expected = await catalog(client, schema);
    await migrate();
    await migrate();
    assert.deepEqual(await catalog(client, schema), expected);

    // Pre-018, with data, applied from a session that is not in UTC.
    await previous();
    assert.notDeepEqual(await catalog(client, schema), expected, 'the downgrade did not take the schema back');
    const userId = await addUser('fiction@example.invalid');
    await client.query("INSERT INTO transactions(user_id,amount,description,category,type,date,currency,created_at,updated_at) VALUES($1,12.50,'Fictional','Dining Out','expense','2019-10-14','CAD','2026-10-20 12:00:00.123456','2026-10-20 12:00:00.123456')", [userId]);
    await client.query("INSERT INTO savings_goals(user_id,name,target_amount,current_amount,currency,created_at) VALUES($1,'Fictional goal',500,0,'USD','2026-10-20 12:00:00')", [userId]);
    await client.query("INSERT INTO import_batches(user_id,row_count,edited_count,llm_count,created_at) VALUES($1,1,0,0,'2026-10-20 12:00:00')", [userId]);
    await client.query("INSERT INTO access_tokens(user_id,name,token_hash,created_at,last_used_at) VALUES($1,'Fictional',repeat('a',64),'2026-10-20 12:00:00','2026-10-20 12:00:00')", [userId]);
    const fileBefore = (await client.query("SELECT pg_relation_filenode('transactions') AS f, (SELECT xmin::text FROM transactions) AS x")).rows[0];
    await client.query("SET TIME ZONE 'America/Toronto'");
    await migrate();
    await migrate();
    await client.query("SET TIME ZONE 'UTC'");
    assert.deepEqual(await catalog(client, schema), expected);

    // Every stored wall-clock time meant UTC, and still names the same instant.
    const instants = (await client.query(`
      SELECT (SELECT created_at FROM users) AS u, (SELECT created_at FROM transactions) AS t, (SELECT updated_at FROM transactions) AS tu,
             (SELECT created_at FROM savings_goals) AS g, (SELECT created_at FROM import_batches) AS b,
             (SELECT last_used_at FROM access_tokens) AS a`)).rows[0] as Record<string, Date>;
    for (const [column, value] of Object.entries(instants)) {
      assert.equal(value.toISOString().slice(0, 19), '2026-10-20T12:00:00', `${column} moved`);
    }
    assert.equal((await client.query('SELECT updated_at::text AS t FROM transactions')).rows[0].t, '2026-10-20 12:00:00.123456+00');
    // Not rewritten: same file, same tuple version (what agent undo compares).
    assert.deepEqual((await client.query("SELECT pg_relation_filenode('transactions') AS f, (SELECT xmin::text FROM transactions) AS x")).rows[0], fileBefore);

    // The rules now hold for new rows.
    await assert.rejects(client.query("INSERT INTO transactions(user_id,amount,description,category,type,date,currency) VALUES($1,-1,'x','Other','expense','2026-01-01','CAD')", [userId]), { code: '23514' });
    await assert.rejects(client.query("INSERT INTO transactions(user_id,amount,description,category,type,date,currency) VALUES($1,1,'x','Other','expense','2026-01-01','JPY')", [userId]), { code: '23514' });
    await assert.rejects(client.query("INSERT INTO transactions(amount,description,category,type,date,currency) VALUES(1,'x','Other','expense','2026-01-01','CAD')"), { code: '23502' });
    await assert.rejects(client.query("INSERT INTO savings_goals(user_id,name,target_amount,current_amount) VALUES($1,'x',10,-1)", [userId]), { code: '23514' });
    await assert.rejects(addUser('FICTION@example.invalid'), { code: '23505' });

    // 018 refuses rows that break its rules: counts in the message, nothing changed.
    await previous();
    const owner = await addUser('owner@example.invalid');
    await client.query("INSERT INTO transactions(user_id,amount,description,category,type,date,currency) VALUES(NULL,5,'Orphan','Other','expense','2026-01-01','CAD'),($1,5,'Yen','Other','expense','2026-01-01','JPY'),($1,0,'Zero','Other','expense','2026-01-01','CAD')", [owner]);
    const legacy = await catalog(client, schema);
    await assert.rejects(client.query(migrations[0]!), (error: Error) => {
      assert.match(error.message, /changed nothing/);
      assert.match(error.message, /1 transaction\(s\) without user_id/);
      assert.match(error.message, /1 transaction\(s\) with amount <= 0/);
      assert.match(error.message, /1 transaction\(s\) with another currency/);
      assert.doesNotMatch(error.message, /Orphan|Yen|Zero|owner@/, 'a row value reached the message');
      return true;
    });
    await client.query('ROLLBACK');
    assert.deepEqual(await catalog(client, schema), legacy);

    // 021 refuses addresses that differ only in case: a count, no index.
    await previous();
    await addUser('Jane@example.invalid');
    await addUser('jane@example.invalid');
    await assert.rejects(client.query(migrations[3]!), (error: Error) => {
      assert.match(error.message, /1 address\(es\) are registered more than once/);
      assert.doesNotMatch(error.message, /jane/i);
      return true;
    });
    await client.query('ROLLBACK');
    assert.equal((await client.query("SELECT to_regclass('idx_users_email_lower') AS i")).rows[0].i, null);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
});
