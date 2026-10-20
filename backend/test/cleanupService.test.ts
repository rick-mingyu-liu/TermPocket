import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import db = require('../db/connection');
import config = require('../config');
import { deleteUnverifiedAccounts, reclaimStaleUnverifiedAccount } from '../services/cleanupService';

/**
 * Unit tests for the scheduled deletions. No database: db.query is mocked.
 *
 * These statements delete user accounts on a timer, or on a re-registration,
 * with nobody watching. The properties worth pinning down are therefore less about
 * the happy path than about the shape of the SQL and what happens when it
 * fails.
 */

function queryReturning(rowCount: number) {
  return mock.method(db, 'query', async (_text: string, _params?: unknown[]) => ({ rowCount, rows: [] }));
}

describe('deleteUnverifiedAccounts', () => {
  beforeEach(() => mock.restoreAll());

  test('returns the number of rows deleted', async () => {
    queryReturning(3);
    assert.equal(await deleteUnverifiedAccounts(), 3);
  });

  test('only ever deletes accounts that are unverified and past their window', async () => {
    // Losing a predicate deletes real users' accounts on a timer. Worth
    // asserting rather than assuming.
    const query = queryReturning(0);

    await deleteUnverifiedAccounts();

    const [sql, params] = query.mock.calls[0]!.arguments;
    assert.match(sql, /^DELETE FROM users WHERE email_verified = FALSE AND \(/);
    assert.match(sql, /created_at < NOW\(\) - make_interval\(mins => \$1\)/);
    assert.deepEqual(params, [
      config.dataRetention.unverifiedAccountMinutes,
      config.dataRetention.unverifiedAccountMaxMinutes,
    ]);
  });

  test('spares an account whose resent verification link is still valid', async () => {
    // Resending issues a fresh link but keeps created_at. Judged on age alone,
    // the next sweep could delete the account with that link still live.
    const query = queryReturning(0);

    await deleteUnverifiedAccounts();

    const [sql] = query.mock.calls[0]!.arguments;
    assert.match(sql, /AND \(email_verification_expires IS NULL OR email_verification_expires < NOW\(\)\)/);
  });

  test('but not forever: past the hard cap it goes whatever its link says', async () => {
    // Resend is unauthenticated, so without a cap anyone could keep someone
    // else's unverified registration of an address alive indefinitely.
    const query = queryReturning(0);

    await deleteUnverifiedAccounts();

    const [sql] = query.mock.calls[0]!.arguments;
    assert.match(sql, /OR created_at < NOW\(\) - make_interval\(mins => \$2\)\)$/);
    assert.ok(config.dataRetention.unverifiedAccountMaxMinutes > config.dataRetention.unverifiedAccountMinutes);
  });

  test('does not RETURNING the deleted rows', async () => {
    // It used to, and then logged every deleted account's email address —
    // putting user emails into the server log on every sweep. The row count
    // is all the caller needs.
    const query = queryReturning(0);

    await deleteUnverifiedAccounts();

    assert.doesNotMatch(query.mock.calls[0]!.arguments[0], /RETURNING/i);
  });

  test('propagates a database error instead of swallowing it', async () => {
    mock.method(db, 'query', async () => {
      throw new Error('connection terminated');
    });

    await assert.rejects(() => deleteUnverifiedAccounts(), /connection terminated/);
  });
});

describe('reclaimStaleUnverifiedAccount', () => {
  beforeEach(() => mock.restoreAll());

  test('deletes only that address, and only under the sweep\'s own condition', async () => {
    const query = queryReturning(1);

    assert.equal(await reclaimStaleUnverifiedAccount('a@example.com'), true);

    const [sql, params] = query.mock.calls[0]!.arguments;
    assert.match(sql, /^DELETE FROM users WHERE lower\(email\) = lower\(\$1\) AND email_verified = FALSE AND \(/);
    assert.match(sql, /email_verification_expires < NOW\(\)/);
    assert.deepEqual(params, [
      'a@example.com',
      config.dataRetention.unverifiedAccountMinutes,
      config.dataRetention.unverifiedAccountMaxMinutes,
    ]);
  });

  test('reports false when there was nothing stale to replace', async () => {
    queryReturning(0);
    assert.equal(await reclaimStaleUnverifiedAccount('a@example.com'), false);
  });
});
