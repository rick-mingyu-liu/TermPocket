import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import db = require('../db/connection');
import config = require('../config');

/**
 * Registering an address that has a stale unverified account.
 *
 * Retention deletion runs hourly, so an unverified account whose window has
 * passed can still be sitting in the table. Whether the address can be
 * registered again must not depend on when that sweep last ran: register
 * replaces a stale unverified row itself, under the sweep's own condition. A
 * verified account, or an unverified one still inside its window, keeps
 * answering "User already exists".
 *
 * Runs the real handler with its collaborators stubbed, as registerLogging.test
 * does: the email module is replaced in require.cache before authController
 * loads, because authController destructures it at load time.
 */

const emailServicePath = require.resolve('../services/emailService');
const authControllerPath = require.resolve('../controllers/authController');

function loadController() {
  require.cache[emailServicePath] = {
    id: emailServicePath,
    filename: emailServicePath,
    loaded: true,
    exports: {
      sendEmailVerification: async () => {},
      sendWeeklyReport: async () => {},
      generateWeeklyReport: async () => ({ text: '', html: '' }),
    },
  } as NodeJS.Module;
  delete require.cache[authControllerPath];
  return require(authControllerPath);
}

describe('registering over an existing account', () => {
  const EMAIL = 'pending@example.com';
  let calls: Array<{ sql: string; params: unknown[] }>;
  let savedKey: string | undefined;

  beforeEach(() => {
    calls = [];
    savedKey = config.apiKeys.mailboxLayer;
    config.apiKeys.mailboxLayer = 'test-key-not-used-the-http-call-is-mocked';
    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});
    mock.method(axios, 'get', async () => ({
      data: { format_valid: true, disposable: false, mx_found: true, smtp_check: true },
    }));
  });

  afterEach(() => {
    config.apiKeys.mailboxLayer = savedKey;
    mock.restoreAll();
    delete require.cache[emailServicePath];
    delete require.cache[authControllerPath];
  });

  /** The database: one existing row for EMAIL, and whether the reclaiming DELETE matches it. */
  function existing(verified: boolean, staleDeleteMatches: boolean): void {
    mock.method(db, 'query', async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT')) return { rows: [{ id: 41, email: EMAIL, email_verified: verified }], rowCount: 1 };
      if (sql.startsWith('DELETE')) return { rows: [], rowCount: staleDeleteMatches ? 1 : 0 };
      return {
        rows: [{ id: 42, email: EMAIL, first_name: 'A', last_name: 'B', created_at: new Date(), email_verification_expires: new Date() }],
        rowCount: 1,
      };
    });
  }

  async function register(): Promise<{ status: number | null; body: unknown }> {
    const out = { status: null as number | null, body: null as unknown };
    const res = {
      status(code: number) { out.status = code; return res; },
      json(payload: unknown) { out.body = payload; if (out.status === null) out.status = 200; return res; },
    };
    await loadController().register(
      { body: { email: EMAIL, password: 'password123', first_name: 'A', last_name: 'B' } },
      res
    );
    return out;
  }

  const deletes = () => calls.filter((c) => c.sql.startsWith('DELETE'));
  const inserts = () => calls.filter((c) => c.sql.startsWith('INSERT'));

  test('a stale unverified registration is replaced, without waiting for the sweep', async () => {
    existing(false, true);
    const out = await register();
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(deletes().length, 1);
    assert.match(deletes()[0]!.sql, /WHERE lower\(email\) = lower\(\$1\) AND email_verified = FALSE AND \(/);
    assert.equal(deletes()[0]!.params[0], EMAIL);
    assert.equal(inserts().length, 1);
  });

  test('an unverified registration still inside its window is left alone', async () => {
    existing(false, false);
    const out = await register();
    assert.equal(out.status, 400);
    assert.deepEqual(out.body, { error: 'User already exists' });
    assert.equal(inserts().length, 0);
  });

  test('a verified account is never touched', async () => {
    existing(true, true);
    const out = await register();
    assert.equal(out.status, 400);
    assert.deepEqual(out.body, { error: 'User already exists' });
    assert.equal(deletes().length, 0, 'a DELETE was issued against a verified account');
    assert.equal(inserts().length, 0);
  });

  test('the lookup ignores case and puts a verified match first', async () => {
    existing(true, false);
    await register();
    const lookup = calls.find((c) => c.sql.startsWith('SELECT'))!;
    assert.match(lookup.sql, /WHERE lower\(email\) = lower\(\$1\) ORDER BY email_verified DESC NULLS LAST LIMIT 1/);
    assert.deepEqual(lookup.params, [EMAIL]);
  });

  test('losing a race to the unique index answers "User already exists", not a 500', async () => {
    mock.method(db, 'query', async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT')) return { rows: [], rowCount: 0 };
      throw Object.assign(new Error('duplicate key value violates unique constraint "idx_users_email_lower"'), { code: '23505' });
    });
    const logged: unknown[][] = [];
    mock.method(console, 'log', (...args: unknown[]) => { logged.push(args); });
    const out = await register();
    assert.equal(out.status, 400);
    assert.deepEqual(out.body, { error: 'User already exists' });
    assert.equal(inserts().length, 1);
    assert.ok(!JSON.stringify(logged).includes(EMAIL), 'the address reached the log');
  });

  test('any other database error is still a 500', async () => {
    mock.method(db, 'query', async (sql: string) => {
      if (sql.startsWith('SELECT')) return { rows: [], rowCount: 0 };
      throw Object.assign(new Error('connection lost'), { code: '08006' });
    });
    const out = await register();
    assert.equal(out.status, 500);
  });
});
