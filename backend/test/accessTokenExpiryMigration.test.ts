import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { packageRoot } from '../utils/packageRoot';

/**
 * Migration 023 adds access_tokens.expires_at. Applied twice to the pre-023
 * schema (with rows in it) and twice to a fresh schema.sql, it must succeed
 * every time and produce exactly the column schema.sql declares; every token
 * active when it first runs expires 90 days later, a revoked one stays NULL,
 * a second run moves no expiry, and no other column or row changes.
 *
 * Needs an explicit TEST_DATABASE_URL, never the .env database. All DDL runs in
 * a random schema that is dropped afterwards.
 */
const ADDED = `    revoked_at TIMESTAMPTZ,
    -- When the token stops opening /mcp (migration 023): creation plus
    -- config.accessTokens.ttlDays. Only a token created by code that had not
    -- yet seen the column can be NULL, and the application then treats it as
    -- expiring ttlDays after created_at, never as "never".
    expires_at TIMESTAMPTZ
);`;
const BEFORE = `    revoked_at TIMESTAMPTZ
);`;

test('migration 023: idempotent on the pre-023 schema and on a fresh one, and matches schema.sql', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  const schema = `token_expiry_migration_${randomUUID().replaceAll('-', '')}`;
  const root = packageRoot(__dirname);
  const desired = readFileSync(path.join(root, 'db/schema.sql'), 'utf8');
  const migration = readFileSync(path.join(root, 'db/migrations/023_access_token_expiry.sql'), 'utf8');

  const shape = async () => (await client.query(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'access_tokens' ORDER BY column_name`, [schema])).rows;
  const reset = async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
  };
  const others = 'SELECT id, user_id, name, token_hash, created_at, last_used_at, revoked_at FROM access_tokens ORDER BY id';

  try {
    // Inside the try, so a failed match still releases the pool.
    assert.equal(desired.split(ADDED).length, 2, 'schema.sql no longer declares the column the way this test expects');
    const previous = desired.replace(ADDED, BEFORE);

    // Fresh: schema.sql already has the column; the migration is a no-op twice.
    await reset();
    await client.query(desired);
    const expectedShape = await shape();
    assert.ok(expectedShape.some((c) => c.column_name === 'expires_at' && c.data_type === 'timestamp with time zone' && c.is_nullable === 'YES' && c.column_default === null));
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual(await shape(), expectedShape);

    // Pre-023, with data.
    await reset();
    await client.query(previous);
    assert.ok(!(await shape()).some((c) => c.column_name === 'expires_at'));
    const userId = (await client.query<{ id: number }>("INSERT INTO users(email,password_hash,first_name,last_name,email_verified) VALUES('fiction@example.invalid','x','Migration','Test',TRUE) RETURNING id")).rows[0]!.id;
    await client.query(
      `INSERT INTO access_tokens(user_id,name,token_hash,created_at,last_used_at,revoked_at) VALUES
       ($1,'Fictional active',repeat('a',64),'2026-01-01 12:00:00+00','2026-10-20 12:00:00+00',NULL),
       ($1,'Fictional revoked',repeat('b',64),'2026-01-01 12:00:00+00',NULL,'2026-02-01 12:00:00+00')`,
      [userId]
    );
    const before = (await client.query(others)).rows;

    await client.query(migration);
    assert.deepEqual(await shape(), expectedShape);
    const first = (await client.query<{ name: string; expires_at: Date | null; days: number | null }>(
      "SELECT name, expires_at, extract(epoch FROM expires_at - now()) / 86400 AS days FROM access_tokens ORDER BY id"
    )).rows;
    // Exactly 90 x 24 hours. This catches a missing SET LOCAL TIME ZONE 'UTC'
    // only when the test server's own zone has daylight saving inside the next
    // 90 days (a UTC server, like CI's, passes either way).
    assert.ok(first[0]!.days !== null && Number(first[0]!.days) > 89.99 && Number(first[0]!.days) <= 90, `active token expires in ${first[0]!.days} days`);
    assert.equal(first[1]!.expires_at, null, 'a revoked token was given an expiry');

    await client.query(migration);
    const second = (await client.query<{ expires_at: Date | null }>('SELECT expires_at FROM access_tokens ORDER BY id')).rows;
    assert.deepEqual(second.map((r) => r.expires_at), first.map((r) => r.expires_at), 'a second run moved an expiry');
    assert.deepEqual((await client.query(others)).rows, before, 'another column was rewritten');
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
});
