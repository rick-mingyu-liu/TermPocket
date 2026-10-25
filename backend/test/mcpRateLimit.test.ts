import { test, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import express from 'express';

/**
 * POST /mcp has two budgets of its own on top of the per-IP general one.
 * Through the real router with `db.query` stubbed, each set to 3:
 *
 *   - per user: a user's tokens share one budget, so a stolen token cannot
 *     spread its requests across addresses; past it, a 429 JSON-RPC error
 *     that runs no tool query, and another user is unaffected;
 *   - per IP, for 401s only: unknown tokens, each a database lookup, are
 *     refused before the lookup once the address has failed three times.
 */

// Read when config loads; this file runs in its own process.
process.env.RATE_LIMIT_MCP_MAX = '3';
process.env.RATE_LIMIT_MCP_AUTH_FAILURE_MAX = '3';
import db = require('../db/connection');
import { hashToken } from '../services/accessTokens';

const ALICE_A = 'mgo_' + 'a'.repeat(43);
const ALICE_B = 'mgo_' + 'b'.repeat(43);
const BOB = 'mgo_' + 'c'.repeat(43);
const UNKNOWN = 'mgo_' + 'z'.repeat(43);
const owners = new Map([[hashToken(ALICE_A), 7], [hashToken(ALICE_B), 7], [hashToken(BOB), 8]]);

let server: Server;
let baseUrl: string;
let queries: string[] = [];

before(async () => {
  mock.method(db, 'query', async (text: string, params: unknown[]) => {
    queries.push(text);
    if (text.includes('FROM access_tokens WHERE token_hash')) {
      const userId = owners.get(String(params[0]));
      return { rowCount: userId ? 1 : 0, rows: userId ? [{ id: 1, user_id: userId, stale: false }] : [] };
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

const call = (token: string, id: unknown = 1) =>
  fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'money_goals' } }),
  });
const tooMany = (id: unknown) => ({
  jsonrpc: '2.0', id, error: { code: -32000, message: 'Too many requests, please wait a few minutes.', data: { code: 'mcp_rate_limited' } },
});

test("a user's tokens share one budget; past it, a 429 JSON-RPC error with the request's id and no tool query", async () => {
  for (const token of [ALICE_A, ALICE_B, ALICE_A]) assert.equal((await call(token)).status, 200);
  queries = [];
  const refused = await call(ALICE_B, 'req-4');
  assert.equal(refused.status, 429);
  assert.ok(refused.headers.get('ratelimit'), 'standard RateLimit header');
  assert.deepEqual(await refused.json(), tooMany('req-4'));
  assert.ok(queries.every((text) => text.includes('FROM access_tokens')), 'only the token lookup ran');
});

test("another user's budget is separate", async () => {
  assert.equal((await call(BOB)).status, 200);
});

// Last: once the address is over its failure budget, it is refused outright.
test('unknown tokens: three 401s, then refused before any lookup', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await call(UNKNOWN)).status, 401);
  queries = [];
  const refused = await call(UNKNOWN, 9);
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), tooMany(9));
  assert.equal(queries.length, 0);
});
