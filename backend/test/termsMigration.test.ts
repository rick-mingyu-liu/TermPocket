import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { packageRoot } from '../utils/packageRoot';

/**
 * Migration 017 adds users.terms_version and users.terms_accepted_at. Applied
 * twice to the pre-017 schema (with rows in it) and twice to a fresh
 * schema.sql, it must succeed every time, produce exactly the columns
 * schema.sql declares, leave every existing user NULL (never accepted, so
 * asked once after signing in) and touch no other row.
 *
 * Needs an explicit TEST_DATABASE_URL, never the .env database. All DDL runs in
 * a random schema that is dropped afterwards.
 */
const ADDED = `,
    -- Which version of the Terms of Service and Privacy Policy the user
    -- accepted, and when (migration 017). NULL means never: the app asks once
    -- after sign-in. config.legal.termsVersion is the current version.
    terms_version VARCHAR(32),
    terms_accepted_at TIMESTAMPTZ
);`;
const BEFORE = `
);`;

test('migration 017: idempotent on the pre-017 schema and on a fresh one, and matches schema.sql', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  const schema = `terms_migration_${randomUUID().replaceAll('-', '')}`;
  const root = packageRoot(__dirname);
  const desired = readFileSync(path.join(root, 'db/schema.sql'), 'utf8');
  const migration = readFileSync(path.join(root, 'db/migrations/017_terms_acceptance.sql'), 'utf8');
  // 017 adds terms_accepted_at as TIMESTAMP; 020 later made every timestamp
  // in users TIMESTAMPTZ, so the upgrade path matches schema.sql after both.
  const timestamptz = readFileSync(path.join(root, 'db/migrations/020_timestamptz.sql'), 'utf8');

  const shape = async () => (await client.query(
    `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'users' ORDER BY column_name`, [schema])).rows;
  const reset = async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
  };
  const isTermsColumn = (c: { column_name: string }) => c.column_name === 'terms_version' || c.column_name === 'terms_accepted_at';

  try {
    assert.ok(desired.includes(ADDED), 'schema.sql no longer declares the columns the way this test expects');
    const previous = desired.replace(ADDED, BEFORE);

    // Fresh: schema.sql already has the columns; the migration is a no-op twice.
    await reset();
    await client.query(desired);
    const expectedShape = await shape();
    assert.equal(expectedShape.filter((c) => isTermsColumn(c) && c.is_nullable === 'YES' && c.column_default === null).length, 2);
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual(await shape(), expectedShape);

    // Pre-017, with data: the columns arrive NULL (never accepted) for everyone.
    await reset();
    await client.query(previous);
    assert.ok(!(await shape()).some(isTermsColumn));
    const userId = (await client.query<{ id: number }>("INSERT INTO users(email,password_hash,first_name,last_name,email_verified) VALUES('fiction@example.invalid','x','Migration','Test',TRUE) RETURNING id")).rows[0]!.id;
    await client.query("INSERT INTO transactions(user_id,amount,description,category,type,date,currency) VALUES($1,12.50,'Fictional','Dining Out','expense','2019-10-14','CAD')", [userId]);
    const before = (await client.query('SELECT id, email, email_verified, updated_at FROM users')).rows;
    await client.query(migration);
    await client.query(migration);
    assert.equal((await shape()).find((c) => c.column_name === 'terms_accepted_at')?.data_type, 'timestamp without time zone');
    assert.deepEqual((await client.query('SELECT id, email, email_verified, updated_at FROM users')).rows, before, 'an existing user row was rewritten');
    await client.query(timestamptz);
    assert.deepEqual(await shape(), expectedShape);
    assert.deepEqual((await client.query('SELECT terms_version, terms_accepted_at FROM users')).rows, [{ terms_version: null, terms_accepted_at: null }]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM transactions')).rows[0].n, 1);
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
});
