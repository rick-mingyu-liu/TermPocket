import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { packageRoot } from '../utils/packageRoot';
import {
  listMigrations, planMigrations, baselineFiles, ensureTable, appliedMigrations,
  recordApplied, applyPending, checksumOf, UntrackedDatabaseError, EmptyDatabaseError,
  parseArgs, refusePooledEndpoint,
} from '../db/migrate';
import type { MigrationFile } from '../db/migrate';

/**
 * db/migrate.ts: which migrations run, and the guard that stops it from
 * re-running old data rewrites on a database that predates the records.
 * The planning is pure and always runs; the flow against PostgreSQL needs an
 * explicit TEST_DATABASE_URL and works in a random schema it drops.
 */

const file = (name: string, sql = `-- ${name}`): MigrationFile => ({ name, number: name.slice(0, 3), sql, checksum: checksumOf(sql) });

describe('planning', () => {
  test('every real migration file is listed, in order, and nothing else', () => {
    const names = listMigrations().map((f) => f.name);
    const onDisk = fs.readdirSync(path.join(packageRoot(__dirname), 'db/migrations')).filter((n) => n.endsWith('.sql')).sort();
    assert.deepEqual(names, onDisk, 'a .sql file in db/migrations does not match NNN_name.sql and would never run');
    assert.ok(names.includes('017_terms_acceptance.sql'));
  });

  test('ignores files that are not NNN_name.sql', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
    for (const name of ['002_b.sql', '001_a.sql', 'README.md', 'draft.sql', '01_short.sql']) fs.writeFileSync(path.join(dir, name), 'SELECT 1;');
    assert.deepEqual(listMigrations(dir).map((f) => f.name), ['001_a.sql', '002_b.sql']);
    fs.rmSync(dir, { recursive: true });
  });

  test('pending, changed and missing', () => {
    const files = [file('001_a.sql'), file('002_b.sql'), file('003_c.sql')];
    const plan = planMigrations(files, [
      { name: '001_a.sql', checksum: files[0]!.checksum },
      { name: '002_b.sql', checksum: 'x'.repeat(64) },
      { name: '000_gone.sql', checksum: 'y'.repeat(64) },
    ]);
    assert.deepEqual(plan.pending.map((f) => f.name), ['003_c.sql']);
    assert.deepEqual(plan.changed.map((f) => f.name), ['002_b.sql']);
    assert.deepEqual(plan.missing, ['000_gone.sql']);
  });

  test('only the documented arguments are accepted', () => {
    assert.deepEqual(parseArgs([]), { status: false, baseline: null });
    assert.deepEqual(parseArgs(['--status']), { status: true, baseline: null });
    assert.deepEqual(parseArgs(['--baseline', '015']), { status: false, baseline: '015' });
    assert.throws(() => parseArgs(['--statsu']), /Unknown argument "--statsu"/);
    assert.throws(() => parseArgs(['--baslein', '015']), /Unknown argument/);
    assert.throws(() => parseArgs(['--status', '--baseline', '015']), /cannot be combined/);
  });

  test('refuses a pooled endpoint', () => {
    assert.throws(() => refusePooledEndpoint('postgresql://u:p@ep-x-123-pooler.us-east-1.aws.neon.tech/db'), /direct endpoint/);
    assert.doesNotThrow(() => refusePooledEndpoint('postgresql://u:p@ep-x-123.us-east-1.aws.neon.tech/db'));
    assert.doesNotThrow(() => refusePooledEndpoint(undefined));
  });

  test('line endings do not change a checksum', () => {
    assert.equal(checksumOf('BEGIN;\r\nSELECT 1;\r\nCOMMIT;\r\n'), checksumOf('BEGIN;\nSELECT 1;\nCOMMIT;\n'));
  });

  test('a baseline covers every file up to and including its number', () => {
    const files = [file('001_a.sql'), file('007_b.sql'), file('010_c.sql'), file('015_d.sql'), file('016_e.sql')];
    assert.deepEqual(baselineFiles(files, '010').map((f) => f.name), ['001_a.sql', '007_b.sql', '010_c.sql']);
    assert.throws(() => baselineFiles(files, '15'), /three-digit/);
    assert.throws(() => baselineFiles(files, '008'), /no migration numbered 008/);
  });
});

test('against PostgreSQL: fresh, untracked, baseline, apply, re-run', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  const schema = `schema_migrations_${randomUUID().replaceAll('-', '')}`;
  const desired = fs.readFileSync(path.join(packageRoot(__dirname), 'db/schema.sql'), 'utf8');
  const files = listMigrations();
  const names = files.map((f) => f.name);
  const reset = async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
  };

  try {
    // Untracked existing database: refuses before running anything.
    await reset();
    await client.query(desired);
    await client.query('DROP TABLE schema_migrations');
    await assert.rejects(applyPending(client, files), UntrackedDatabaseError);
    assert.deepEqual(await appliedMigrations(client), [], 'nothing may be recorded when it refuses');

    // Baseline through 015 (production's state), then apply: every later
    // migration runs, in order, against the full schema.
    assert.equal(await recordApplied(client, baselineFiles(files, '015')), names.filter((n) => n.slice(0, 3) <= '015').length);
    const later = names.filter((n) => n.slice(0, 3) > '015');
    assert.ok(later.includes('016_transaction_retention.sql') && later.includes('017_terms_acceptance.sql'));
    const logged: string[] = [];
    assert.deepEqual(await applyPending(client, files, (line) => logged.push(line)), later);
    assert.deepEqual(logged, later.map((n) => `Applying ${n}`));
    assert.deepEqual((await appliedMigrations(client)).map((m) => m.name), names);
    assert.ok((await appliedMigrations(client)).every((m) => m.checksum === files.find((f) => f.name === m.name)!.checksum));

    // Running again applies nothing; recording again records nothing.
    assert.deepEqual(await applyPending(client, files), []);
    assert.equal(await recordApplied(client, files), 0);

    // A failing migration stops the run and stays unrecorded. One that fails
    // inside its own BEGIN ... COMMIT leaves nothing behind, and the
    // connection is still usable afterwards.
    const broken = [...files,
      file('998_broken.sql', 'BEGIN;\nALTER TABLE users ADD COLUMN zz_half_applied INTEGER;\nSELECT * FROM no_such_table;\nCOMMIT;'),
      file('999_later.sql', 'SELECT 1;')];
    await assert.rejects(applyPending(client, broken), /no_such_table/);
    assert.equal((await client.query('SELECT 1 AS ok')).rows[0].ok, 1, 'the connection was left in an aborted transaction');
    assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'zz_half_applied'")).rows[0].n, 0);
    assert.ok(!(await appliedMigrations(client)).some((m) => m.name >= '998'));

    // An empty database is db:setup's job: nothing runs and nothing is recorded.
    await reset();
    await assert.rejects(applyPending(client, [file('001_noop.sql', 'SELECT 1;')]), EmptyDatabaseError);
    await ensureTable(client);
    assert.deepEqual(await appliedMigrations(client), []);
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
});
