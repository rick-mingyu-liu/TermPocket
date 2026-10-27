import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import db = require('../db/connection');
import store = require('../services/agent/store');

/**
 * Settings -> Clear All Data first calls Forget all and DELETE
 * /agent/conversations. On the shared demo account both would wipe every
 * visitor's history and cancel their running replies, so the store refuses
 * them with 403 clear_demo before any write. The pool is faked; no database.
 */

let isDemo: boolean;
let statements: string[];

beforeEach(() => {
  isDemo = false; statements = [];
  const client = {
    query: async (text: string) => {
      statements.push(text);
      if (text.startsWith('SELECT is_demo FROM users')) return { rowCount: 1, rows: [{ is_demo: isDemo }] };
      if (text.includes('FROM users')) return { rowCount: 1, rows: [{ id: 7 }] };
      if (text.includes('information_schema') || text.includes('to_regclass')) return { rowCount: 1, rows: [{ present: true }] };
      return { rowCount: 0, rows: [] };
    },
    release: () => {},
  };
  mock.method(db, 'getPool', () => ({ connect: async () => client }));
});
afterEach(() => mock.restoreAll());

// Writes other than the per-call lease expiry every owned() transaction runs first.
const writes = () => statements.filter(s => /^(DELETE|UPDATE|INSERT|WITH)/.test(s.trim()) && !s.includes("error_code='agent_timeout'"));

test('the demo account cannot delete its conversations', async () => {
  isDemo = true;
  await assert.rejects(store.deleteConversations(7), { code: 'clear_demo', status: 403 });
  assert.deepEqual(writes(), []);
  assert.ok(statements.includes('ROLLBACK'));
});

test('the demo account cannot Forget all', async () => {
  isDemo = true;
  await assert.rejects(store.forgetMemories(7, 'all'), { code: 'clear_demo', status: 403 });
  assert.deepEqual(writes(), []);
});

test('an ordinary account still deletes its conversations', async () => {
  await store.deleteConversations(7);
  assert.ok(statements.includes('DELETE FROM agent_conversations WHERE user_id=$1'));
  assert.ok(statements.includes('COMMIT'));
});

test('an ordinary account still runs Forget all', async () => {
  await store.forgetMemories(7, 'all');
  assert.ok(writes().length > 0, 'Forget all wrote nothing');
  assert.ok(statements.includes('COMMIT'));
});
