import { test, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import express from 'express';

/**
 * POST /mcp has a per-user budget on top of the per-IP one, so a stolen
 * token cannot spread its requests across addresses. Through the real router
 * with `db.query` stubbed and the budget set to 3:
 *
 *   - a user's tokens share one budget, and the next call is a 429 JSON-RPC
 *     error that runs no tool query;
 *   - another user's budget is separate;
 *   - a request with a bad token is a 401 and spends no one's budget.
 */

// Read when config loads; this file runs in its own process.
process.env.RATE_LIMIT_MCP_MAX = '3';
import db = require('../db/connection');
import { hashToken } from '../services/accessTokens';

const ALICE_A = 'mgo_' + 'a'.repeat(43);
const ALICE_B = 'mgo_' + 'b'.repeat(43);
const BOB = 'mgo_' + 'c'.repeat(43);
const owners = new Map([[hashToken(ALICE_A), 7], [hashToken(ALICE_B), 7], [hashToken(BOB), 8]]);

let server: Server;
let baseUrl: string;
let queries: string[] = [];

before(async () => {
  mock.method(db, 'query', async (text: string, params: unknown[]) => {
    queries.push(text);
    if (text.includes('UPDATE access_tokens')) {
      const userId = owners.get(String(params[0]));
      return { rowCount: userId ? 1 : 0, rows: userId ? [{ id: 1, user_id: userId }] : [] };
    }
    return { rowCount: 0, rows: [] };
  });
  const app = express();
  app.use(express.json());
  app.use('/mcp', require('../routes/mcp'));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a bound TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  mock.restoreAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => { queries = []; });

const call = (token: string) =>
  fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'money_goals' } }),
  });

test('a bad token is refused without spending a budget', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call('mgo_' + 'z'.repeat(43))).status, 401);
});

test("a user's tokens share one budget; past it, a 429 JSON-RPC error and no tool query", async () => {
  for (const token of [ALICE_A, ALICE_B, ALICE_A]) assert.equal((await call(token)).status, 200);
  queries = [];
  const refused = await call(ALICE_B);
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many requests, please wait a few minutes.' } });
  assert.ok(queries.every((text) => text.includes('UPDATE access_tokens')), 'only the token lookup ran');
});

test("another user's budget is separate", async () => {
  assert.equal((await call(BOB)).status, 200);
});
