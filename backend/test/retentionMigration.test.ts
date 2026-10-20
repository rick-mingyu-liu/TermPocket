import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { packageRoot } from '../utils/packageRoot';

/**
 * Migration 016 adds users.transaction_retention_terms. Applied twice to the
 * pre-016 schema (with rows in it) and twice to a fresh schema.sql, it must
 * succeed every time, produce exactly the column and CHECK schema.sql
 * declares, leave every existing user off (NULL) and touch no other row.
 *
 * Needs an explicit TEST_DATABASE_URL, never the .env database. All DDL runs in
 * a random schema that is dropped afterwards.
 */
// The 016 column with its comment, removed to build the pre-016 schema. Only
// these lines, so a column added after it (017's) does not break the match;
// columns from later migrations are present on both sides of the comparison.
const ADDED = `    -- Automatic deletion (migration 016): keep only the last N terms of
    -- transactions, the current one included. NULL is off, the default for
    -- everyone; the hourly sweep deletes nothing for a NULL row.
    transaction_retention_terms SMALLINT CHECK (transaction_retention_terms BETWEEN 3 AND 12),
`;

test('migration 016: idempotent on the pre-016 schema and on a fresh one, and matches schema.sql', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  const schema = `retention_migration_${randomUUID().replaceAll('-', '')}`;
  const root = packageRoot(__dirname);
  const desired = readFileSync(path.join(root, 'db/schema.sql'), 'utf8');
  const migration = readFileSync(path.join(root, 'db/migrations/016_transaction_retention.sql'), 'utf8');

  const shape = async () => (await client.query(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'users' ORDER BY column_name`, [schema])).rows;
  const constraints = async () => (await client.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = $1 AND t.relname = 'users' ORDER BY 1`, [schema])).rows;
  const reset = async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
  };

  try {
    // Inside the try, so a failed match still releases the pool.
    assert.ok(desired.includes(ADDED), 'schema.sql no longer declares the column the way this test expects');
    const previous = desired.replace(ADDED, '');

    // Fresh: schema.sql already has the column; the migration is a no-op twice.
    await reset();
    await client.query(desired);
    const expectedShape = await shape();
    const expectedConstraints = await constraints();
    assert.ok(expectedShape.some((c) => c.column_name === 'transaction_retention_terms' && c.is_nullable === 'YES' && c.column_default === null));
    assert.ok(expectedConstraints.some((c) => /transaction_retention_terms >= 3/.test(c.def) && /transaction_retention_terms <= 12/.test(c.def)));
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual(await shape(), expectedShape);
    assert.deepEqual(await constraints(), expectedConstraints);

    // Pre-016, with data: the column arrives NULL (off) for everyone, once.
    await reset();
    await client.query(previous);
    assert.ok(!(await shape()).some((c) => c.column_name === 'transaction_retention_terms'));
    const userId = (await client.query<{ id: number }>("INSERT INTO users(email,password_hash,first_name,last_name) VALUES('fiction@example.invalid','x','Migration','Test') RETURNING id")).rows[0]!.id;
    await client.query("INSERT INTO transactions(user_id,amount,description,category,type,date,currency) VALUES($1,12.50,'Fictional','Dining Out','expense','2019-10-14','CAD')", [userId]);
    const before = (await client.query('SELECT id, email, updated_at FROM users')).rows;
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual(await shape(), expectedShape);
    assert.deepEqual(await constraints(), expectedConstraints);
    assert.deepEqual((await client.query('SELECT id, email, updated_at FROM users')).rows, before, 'an existing user row was rewritten');
    assert.equal((await client.query('SELECT transaction_retention_terms FROM users')).rows[0].transaction_retention_terms, null);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM transactions')).rows[0].n, 1);
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
});
