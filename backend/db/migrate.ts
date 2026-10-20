import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from './connection';
import { packageRoot } from '../utils/packageRoot';

/**
 * Applies db/migrations/*.sql in order and records each one in
 * `schema_migrations`, so the database itself says which have run.
 *
 *   npm run db:migrate                     apply every pending migration
 *   npm run db:migrate -- --status         list applied and pending, change nothing
 *   npm run db:migrate -- --baseline 015   record 001..015 as applied without running them
 *
 * Before this table existed, migrations were applied by hand with psql and
 * nothing recorded which had run. An existing database therefore starts
 * untracked, and the runner **refuses to apply anything to an untracked
 * database that already has tables**: the early migrations include one-off
 * data rewrites (002, 005, 010) that must not run again. An empty database is
 * refused too: it is created by `db:setup`, never by replaying 001 onwards. Record what is known
 * to be applied with `--baseline`, then run it. `db:setup` on a fresh database
 * records every migration itself, because schema.sql already contains them.
 *
 * Each migration manages its own transaction (most are BEGIN ... COMMIT), so
 * the record is written after the file succeeds. A failure stops the run with
 * that file unrecorded; every migration from 013 on is idempotent, so fixing
 * the cause and running again is safe.
 *
 * Runs on one dedicated connection under a session advisory lock, so two
 * runners cannot apply the same file twice. Use the direct (non-pooler)
 * endpoint: Neon's pooler does not keep session state such as the lock.
 */

const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;
// Arbitrary, fixed: the advisory lock key every runner takes.
const LOCK_KEY = 4_170_017;

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

interface MigrationFile {
  name: string;
  number: string;
  sql: string;
  checksum: string;
}

interface AppliedMigration {
  name: string;
  checksum: string;
}

interface MigrationPlan {
  pending: MigrationFile[];
  /** Applied, but the file has changed since. */
  changed: MigrationFile[];
  /** Recorded as applied, with no file of that name any more. */
  missing: string[];
}

const checksumOf = (sql: string): string => crypto.createHash('sha256').update(sql).digest('hex');

const migrationsDir = (): string => path.join(packageRoot(__dirname), 'db', 'migrations');

/** Every migration file, in order. Other files in the directory are ignored. */
function listMigrations(dir: string = migrationsDir()): MigrationFile[] {
  return fs.readdirSync(dir)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(dir, name), 'utf8');
      return { name, number: name.slice(0, 3), sql, checksum: checksumOf(sql) };
    });
}

/** What to do, from the files and the records. Pure. */
function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): MigrationPlan {
  const recorded = new Map(applied.map((m) => [m.name, m.checksum]));
  const names = new Set(files.map((f) => f.name));
  return {
    pending: files.filter((f) => !recorded.has(f.name)),
    changed: files.filter((f) => recorded.has(f.name) && recorded.get(f.name) !== f.checksum),
    missing: applied.map((m) => m.name).filter((name) => !names.has(name)),
  };
}

/** The files a `--baseline N` records: every one numbered N or lower. */
function baselineFiles(files: MigrationFile[], through: string): MigrationFile[] {
  if (!/^\d{3}$/.test(through)) throw new Error(`--baseline takes a three-digit migration number, such as 015 (got "${through}")`);
  if (!files.some((f) => f.number === through)) throw new Error(`There is no migration numbered ${through}`);
  return files.filter((f) => f.number <= through);
}

async function ensureTable(client: PoolClient): Promise<void> {
  await client.query(TABLE_SQL);
}

async function appliedMigrations(client: PoolClient): Promise<AppliedMigration[]> {
  return (await client.query<AppliedMigration>('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows;
}

/** Records files as applied without running them. Existing records are kept. */
async function recordApplied(client: PoolClient, files: MigrationFile[]): Promise<number> {
  let recorded = 0;
  for (const file of files) {
    const result = await client.query(
      'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      [file.name, file.checksum]
    );
    recorded += result.rowCount ?? 0;
  }
  return recorded;
}

async function hasAppTables(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ present: boolean }>("SELECT to_regclass('users') IS NOT NULL AS present");
  return result.rows[0]?.present === true;
}

/** True when the database has the app's tables but no migration records. */
async function untrackedExisting(client: PoolClient, applied: AppliedMigration[]): Promise<boolean> {
  return applied.length === 0 && await hasAppTables(client);
}

class EmptyDatabaseError extends Error {
  constructor() {
    super('This database has no tables. Create it with `npm run db:setup`, which applies schema.sql and records every migration; ' +
      'the migrations themselves assume tables that only schema.sql creates.');
    this.name = 'EmptyDatabaseError';
  }
}

class UntrackedDatabaseError extends Error {
  constructor() {
    super('This database has tables but no migration records, so which migrations already ran is unknown. ' +
      'Record the ones known to be applied with `npm run db:migrate -- --baseline <NNN>`, check `--status`, then run it again.');
    this.name = 'UntrackedDatabaseError';
  }
}

/**
 * Applies every pending migration in order and returns the names applied.
 * Throws before running anything on an empty database (db:setup's job) or an
 * untracked existing one, and stops at the first failing file.
 */
async function applyPending(client: PoolClient, files: MigrationFile[], log: (line: string) => void = () => {}): Promise<string[]> {
  await ensureTable(client);
  if (!(await hasAppTables(client))) throw new EmptyDatabaseError();
  const applied = await appliedMigrations(client);
  if (await untrackedExisting(client, applied)) throw new UntrackedDatabaseError();
  const done: string[] = [];
  for (const file of planMigrations(files, applied).pending) {
    log(`Applying ${file.name}`);
    await client.query(file.sql);
    await recordApplied(client, [file]);
    done.push(file.name);
  }
  return done;
}

async function main(args: string[]): Promise<number> {
  const statusOnly = args.includes('--status');
  const baselineAt = args.indexOf('--baseline');
  const files = listMigrations();
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureTable(client);

    if (baselineAt !== -1) {
      const chosen = baselineFiles(files, args[baselineAt + 1] ?? '');
      const recorded = await recordApplied(client, chosen);
      console.log(`Recorded ${recorded} migration(s) as applied without running them (through ${chosen.at(-1)!.name}).`);
      return 0;
    }

    const applied = await appliedMigrations(client);
    const plan = planMigrations(files, applied);
    if (statusOnly) {
      for (const file of files) {
        const state = plan.pending.includes(file) ? 'pending' : plan.changed.includes(file) ? 'applied, file changed since' : 'applied';
        console.log(`${file.name}  ${state}`);
      }
      for (const name of plan.missing) console.log(`${name}  applied, file missing`);
      if (await untrackedExisting(client, applied)) console.log('\nUntracked: tables exist but nothing is recorded. Use --baseline first.');
      return 0;
    }

    for (const file of plan.changed) console.warn(`Warning: ${file.name} changed after it was applied; it is not run again.`);
    const done = await applyPending(client, files, (line) => console.log(line));
    console.log(done.length === 0 ? 'Nothing to apply.' : `Applied ${done.length} migration(s).`);
    return 0;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
    await getPool().end();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  );
}

export {
  listMigrations,
  planMigrations,
  baselineFiles,
  ensureTable,
  appliedMigrations,
  recordApplied,
  applyPending,
  checksumOf,
  UntrackedDatabaseError,
  EmptyDatabaseError,
};
export type { MigrationFile, AppliedMigration, MigrationPlan };
