import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import db = require('../db/connection');
import logger = require('../utils/logger');
import bcrypt from 'bcryptjs';
import {
  refreshDemoAccount,
  refreshDemoAccountOnSchedule,
  refreshDemoAccountIfStale,
  demoAccountFreshness,
  resetAbsenceReport,
  DEMO_PASSWORD,
  DEMO_PASSWORD_HASH,
  OWNED_TABLES,
} from '../services/demoAccountService';

/**
 * The demo refresh runs unattended on a timer and deletes every row belonging
 * to its target before rewriting them. Everything here is about what it
 * refuses to do.
 *
 * The hazard it was built around: resolving the demo account by
 * `email = 'john.doe@example.com'` makes the target a guessable string.
 * Nothing reserves that address, so a scheduled job pointed at it would wipe a
 * real person's data every month with nobody watching. Run by hand the
 * exposure is bounded — a human is present. On a timer it is not.
 */

interface Query {
  text: string;
  params?: unknown[];
}

interface FakeClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
  release: () => void;
  released: boolean;
}

let queries: Query[];
let client: FakeClient;
let demoRows: Array<{ id: number }>;

beforeEach(() => {
  queries = [];
  demoRows = [{ id: 42 }];

  client = {
    query: async (text, params) => {
      queries.push({ text: text.replace(/\s+/g, ' ').trim(), params });
      if (/SELECT id FROM users WHERE is_demo/.test(text)) return { rows: demoRows, rowCount: demoRows.length };
      if (/^\s*INSERT INTO users/.test(text)) return { rows: [{ id: 99 }], rowCount: 1 };
      if (/^\s*DELETE FROM/.test(text)) return { rows: [], rowCount: 7 };
      return { rows: [], rowCount: 0 };
    },
    release: () => { client.released = true; },
    released: false,
  };

  mock.method(db, 'getPool', () => ({ connect: async () => client }));
});

afterEach(() => mock.restoreAll());

const sql = () => queries.map((q) => q.text);
const ran = (pattern: RegExp) => sql().some((t) => pattern.test(t));

describe('what it identifies the demo account by', () => {
  test('resolves its target by the is_demo flag, never by an email address', () => {
    return refreshDemoAccount({ create: false }).then(() => {
      assert.ok(ran(/SELECT id FROM users WHERE is_demo = TRUE/),
        'did not look the account up by its flag');
      // The whole point. An email in the lookup would put a guessable string
      // between a timer and a DELETE.
      const lookups = sql().filter((t) => /^SELECT/.test(t));
      for (const q of lookups) {
        assert.doesNotMatch(q, /email/i, `resolved the target by email: ${q}`);
      }
    });
  });

  test('every delete is scoped to the resolved user id', async () => {
    await refreshDemoAccount({ create: false });
    const deletes = queries.filter((q) => /^DELETE FROM/.test(q.text));
    assert.equal(deletes.length, OWNED_TABLES.length);
    for (const d of deletes) {
      assert.match(d.text, /WHERE user_id = \$1/, `unscoped delete: ${d.text}`);
      assert.deepEqual(d.params, [42]);
    }
  });

  test('it is not a database reset — nothing is deleted unscoped', async () => {
    await refreshDemoAccount({ create: true });
    for (const t of sql()) {
      if (/^DELETE/.test(t)) assert.match(t, /WHERE user_id/, `bare DELETE: ${t}`);
      assert.doesNotMatch(t, /TRUNCATE|DROP /i, `destructive statement: ${t}`);
    }
  });
});

test('refresh touches only the tables that still exist (watchlist and ai_plans were dropped by 014)', async () => {
  await refreshDemoAccount({ create: true });
  assert.deepEqual([...OWNED_TABLES], ['transactions', 'savings_goals']);
  assert.equal(ran(/watchlist|ai_plans/), false);
});

describe('when no account is flagged', () => {
  beforeEach(() => { demoRows = []; });

  test('the scheduled form deletes nothing and creates nothing', async () => {
    const result = await refreshDemoAccount({ create: false });
    assert.equal(result.status, 'absent');
    assert.equal(result.deleted, 0);
    assert.ok(!ran(/^DELETE/), 'deleted rows with no demo account resolved');
    assert.ok(!ran(/INSERT INTO users/), 'a scheduled run conjured its own target');
    assert.ok(ran(/^ROLLBACK$/), 'left the transaction open');
  });

  test('the seeder may create it, because a human asked', async () => {
    const result = await refreshDemoAccount({ create: true });
    assert.equal(result.status, 'created');
    assert.ok(ran(/INSERT INTO users/));
    assert.match(sql().find((t) => /INSERT INTO users/.test(t))!, /is_demo/);
  });

  test('the scheduled form says so where production can see it', async () => {
    // logger.warn prints nothing in production, and a refresh that silently
    // does nothing forever is exactly what needs saying out loud.
    const lines: string[] = [];
    mock.method(logger, 'error', (msg: string) => lines.push(msg));
    const deleted = await refreshDemoAccountOnSchedule();
    assert.equal(deleted, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /is_demo/);
    assert.match(lines[0]!, /db:seed/, 'did not say how to fix it');
  });
});

describe('atomicity', () => {
  test('runs on one client, not through the pool', async () => {
    // db.query hands out a different pooled connection per call, so BEGIN and
    // COMMIT issued through it need not land on the same session.
    const poolQuery = mock.method(db, 'query', async () => ({ rows: [], rowCount: 0 }));
    await refreshDemoAccount({ create: false });
    assert.equal(poolQuery.mock.callCount(), 0, 'used the pool instead of a client');
    assert.equal(sql()[0], 'BEGIN');
    assert.equal(sql().at(-1), 'COMMIT');
  });

  test('a failure part-way rolls back and releases the client', async () => {
    const boom = new Error('connection lost');
    client.query = async (text) => {
      queries.push({ text: text.replace(/\s+/g, ' ').trim() });
      if (/SELECT id FROM users/.test(text)) return { rows: [{ id: 42 }] };
      if (/INSERT INTO transactions/.test(text)) throw boom;
      return { rows: [], rowCount: 0 };
    };

    // Throws rather than logging and returning, like cleanupService: the
    // caller decides what a failed refresh means.
    await assert.rejects(refreshDemoAccount({ create: false }), /connection lost/);
    assert.ok(ran(/^ROLLBACK$/), 'left a half-rewritten account committed');
    assert.ok(client.released, 'leaked the client back to nobody');
  });

  test('the client is released on the happy path too', async () => {
    await refreshDemoAccount({ create: false });
    assert.ok(client.released);
  });
});

describe('what the scheduler logs', () => {
  test('returns the deleted count, which is the half worth auditing', async () => {
    // scheduleInterval audits a non-zero return and routes zero to the dev
    // channel — decision D: audit is for destroying user data.
    mock.method(logger, 'info', () => {});
    const deleted = await refreshDemoAccountOnSchedule();
    assert.equal(deleted, OWNED_TABLES.length * 7);
  });
});

describe('how stale the demo account is', () => {
  // The hourly maintenance run asks this before refreshing. One aggregate
  // SELECT through the pool, which decides staleness itself against the
  // database clock (test/demoFreshnessDb.test.ts runs it for real); the
  // refresh's client is used only when stale.
  let checks: Query[];
  let answer: Array<{ id: number; refreshed_at: string | null; stale: boolean }>;

  beforeEach(() => {
    checks = [];
    answer = [{ id: 42, refreshed_at: '2026-10-10T03:00:00Z', stale: false }];
    resetAbsenceReport();
    mock.method(db, 'query', async (text: string, params?: unknown[]) => {
      checks.push({ text: text.replace(/\s+/g, ' ').trim(), params });
      return { rows: answer, rowCount: answer.length };
    });
  });

  test('is one SELECT resolved by is_demo, measuring the last refresh in SQL', async () => {
    await demoAccountFreshness(14);
    assert.equal(checks.length, 1);
    const { text, params } = checks[0]!;
    assert.match(text, /^SELECT /);
    assert.match(text, /is_demo = TRUE/);
    assert.doesNotMatch(text, /email/i);
    // The last refresh, not the newest row: a visitor's rows are always created later.
    assert.match(text, /MIN\(t\.created_at\)/);
    assert.doesNotMatch(text, /MAX\(/);
    // Compared on the database clock, in UTC.
    assert.match(text, /now\(\) AT TIME ZONE 'UTC'/);
    // A new calendar month since the last refresh makes it stale too.
    assert.match(text, /MIN\(t\.created_at\) < date_trunc\('month', now\(\) AT TIME ZONE 'UTC'\)/);
    assert.deepEqual(params, [14]);
  });

  test('reports what the database decided', async () => {
    assert.deepEqual(await demoAccountFreshness(14),
      { state: 'fresh', userId: 42, refreshedAt: '2026-10-10T03:00:00Z' });
    answer = [{ id: 42, refreshed_at: null, stale: true }];
    assert.deepEqual(await demoAccountFreshness(14), { state: 'stale', userId: 42, refreshedAt: null });
    answer = [];
    assert.deepEqual(await demoAccountFreshness(14), { state: 'absent' });
  });

  test('refreshDemoAccountIfStale leaves fresh data alone', async () => {
    assert.equal(await refreshDemoAccountIfStale(), 0);
    assert.deepEqual(queries, [], 'opened a refresh transaction for fresh data');
  });

  test('refreshDemoAccountIfStale refreshes stale data and returns the deleted count', async () => {
    mock.method(logger, 'info', () => {});
    answer = [{ id: 42, refreshed_at: '2020-01-01T00:00:00Z', stale: true }];
    assert.equal(await refreshDemoAccountIfStale(), OWNED_TABLES.length * 7);
    assert.ok(ran(/^COMMIT$/));
  });

  test('with no demo account it writes nothing and says so once', async () => {
    answer = [];
    const lines: string[] = [];
    mock.method(logger, 'error', (msg: string) => lines.push(msg));
    assert.equal(await refreshDemoAccountIfStale(), 0);
    assert.equal(await refreshDemoAccountIfStale(), 0);
    assert.deepEqual(queries, []);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /db:seed/);
  });

  test('a refresh failure propagates to the caller', async () => {
    answer = [{ id: 42, refreshed_at: null, stale: true }];
    mock.method(logger, 'info', () => {});
    client.query = async (text) => {
      if (/INSERT INTO transactions/.test(text)) throw new Error('connection lost');
      return { rows: /SELECT id FROM users/.test(text) ? [{ id: 42 }] : [], rowCount: 0 };
    };
    await assert.rejects(refreshDemoAccountIfStale(), /connection lost/);
  });
});

/**
 * The demo credential is the one piece of this file a user types by hand, and
 * it is advertised in five places — the login page, the README, CLAUDE.md, the
 * line `db:seed` prints, and the comment on the constant itself.
 *
 * All five said `password123`. The hash was bcrypt('password'). The two had
 * disagreed since the first commit, so the demo login on the deployed site had
 * never once worked, and nothing anywhere compared them: a comment is not
 * executable, and no test hashed anything. The check below is the whole fix —
 * everything else was a consequence.
 */
describe('the advertised demo password', () => {
  test('actually verifies against the stored hash', async () => {
    assert.ok(await bcrypt.compare(DEMO_PASSWORD, DEMO_PASSWORD_HASH),
      `DEMO_PASSWORD_HASH is not a hash of ${JSON.stringify(DEMO_PASSWORD)} — ` +
      'the demo login is broken for everyone reading the README or the login page');
  });

  test('is the string the docs and the login page tell people to type', () => {
    // Pinned deliberately. Changing the demo password means changing README.md,
    // CLAUDE.md and frontend/pages/login.tsx in the same commit, and this
    // failing is the reminder.
    assert.equal(DEMO_PASSWORD, 'password123');
  });

  test('is not left as some other common password the hash happens to match', async () => {
    // The original hash was the well-known tutorial hash of 'password'. If it
    // ever comes back, this says so in one line instead of an "Invalid
    // credentials" a user has to debug from the outside.
    assert.ok(!(await bcrypt.compare('password', DEMO_PASSWORD_HASH)),
      "the hash is bcrypt('password') again — this is the original bug");
  });
});
