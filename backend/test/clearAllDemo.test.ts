import { test, describe, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import express from 'express';
import db = require('../db/connection');

/**
 * Settings -> Clear All Data, through the real transactions and goals routers:
 *
 *   DELETE /transactions/clear-all
 *   DELETE /goals/clear-all
 *
 * The demo login is public, so clearing it emptied the app for every visitor
 * until the hourly refresh. Both endpoints now answer 403 `clear_demo` for the
 * `is_demo` account, and the load-bearing assertion is that no DELETE ran.
 */

const authPath = require.resolve('../middleware/auth');
const transactionsPath = require.resolve('../routes/transactions');
const goalsPath = require.resolve('../routes/goals');

interface Query {
  text: string;
  params: unknown[];
}

let server: Server;
let baseUrl: string;
let queries: Query[];
let isDemo: boolean;

before(async () => {
  // The routers apply auth at module load, so it is replaced before the require.
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { userId: 7 }; next(); },
  } as NodeJS.Module;
  delete require.cache[transactionsPath];
  delete require.cache[goalsPath];

  const app = express();
  app.use(express.json());
  app.use('/transactions', require(transactionsPath));
  app.use('/goals', require(goalsPath));

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a bound TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete require.cache[authPath];
  delete require.cache[transactionsPath];
  delete require.cache[goalsPath];
});

beforeEach(() => {
  queries = [];
  isDemo = false;
  mock.method(db, 'query', async (text: string, params: unknown[] = []) => {
    queries.push({ text, params });
    if (text.startsWith('SELECT is_demo FROM users')) return { rowCount: 1, rows: [{ is_demo: isDemo }] };
    if (text.startsWith('DELETE')) return { rowCount: 3, rows: [] };
    throw new Error(`unexpected query: ${text}`);
  });
});

afterEach(() => {
  mock.restoreAll();
});

const endpoints = [
  { path: '/transactions/clear-all', table: 'transactions' },
  { path: '/goals/clear-all', table: 'savings_goals' },
];

for (const { path, table } of endpoints) {
  describe(`DELETE ${path}`, () => {
    test('the demo account is refused with 403 clear_demo and nothing is deleted', async () => {
      isDemo = true;
      const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE' });
      assert.equal(res.status, 403);
      assert.equal((await res.json() as { code: string }).code, 'clear_demo');
      assert.ok(!queries.some((q) => q.text.startsWith('DELETE')), 'no DELETE may run for the demo account');
      assert.deepEqual(queries.map((q) => q.params), [[7]]);
    });

    test('an ordinary account still clears its own rows', async () => {
      const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE' });
      assert.equal(res.status, 200);
      const deletes = queries.filter((q) => q.text.startsWith('DELETE'));
      assert.equal(deletes.length, 1);
      assert.equal(deletes[0]?.text, `DELETE FROM ${table} WHERE user_id = $1`);
      assert.deepEqual(deletes[0]?.params, [7]);
    });

    test('a vanished user is not treated as the demo account', async () => {
      mock.restoreAll();
      mock.method(db, 'query', async (text: string, params: unknown[] = []) => {
        queries.push({ text, params });
        return { rowCount: 0, rows: [] };
      });
      const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE' });
      assert.equal(res.status, 200);
    });
  });
}
