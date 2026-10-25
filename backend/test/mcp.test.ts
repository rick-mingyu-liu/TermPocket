import { test, describe, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import db = require('../db/connection');
import exchangeRateService = require('../services/exchangeRateService');
import { hashToken, revokeToken, resetExpiryProbe } from '../services/accessTokens';
import { currentTerm, previousTerm, boundsOf, labelOf } from '../utils/terms';

/**
 * POST /mcp lets another app read your numbers with a personal access token.
 * What must hold, through the real router with `db.query` stubbed:
 *
 *   - nothing gets in without a valid, unrevoked access token — a login JWT
 *     included, since that token can delete everything;
 *   - every query it runs is a read (the one write is the token's
 *     last_used_at), and none reads a transaction's description or a whole row;
 *   - the tools answer with totals, and bad input comes back as a tool error.
 */

const routerPath = require.resolve('../routes/mcp');
const TOKEN = 'mgo_' + 'a'.repeat(43);

interface Query {
  text: string;
  params: unknown[];
}

let server: Server;
let baseUrl: string;
let queries: Query[];
/** Rows the stub answers per kind of query. */
let totals: Record<string, Array<{ currency: string; type: string; category: string; total: string }>>;
let goals: Array<Record<string, unknown>>;
/** Whether the stubbed token's last_used_at is old enough to be written. */
let lookupStale = true;
/** Whether the stubbed token has passed its expires_at (migration 023). */
let tokenExpired = false;

before(async () => {
  delete require.cache[routerPath];
  const app = express();
  app.use(express.json());
  app.use('/mcp', require(routerPath));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a bound TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete require.cache[routerPath];
});

beforeEach(() => {
  queries = [];
  totals = {};
  goals = [];
  lookupStale = true;
  tokenExpired = false;
  resetExpiryProbe();
  mock.method(db, 'query', async (text: string, params: unknown[]) => {
    // Migration 023's column probe: present, and not recorded, so the
    // assertions below see the same queries before and after it is cached.
    if (text.includes('information_schema.columns')) return { rowCount: 1, rows: [{ present: true }] };
    queries.push({ text, params });
    if (text.includes('FROM access_tokens WHERE token_hash')) {
      const known = params[0] === hashToken(TOKEN) && !(tokenExpired && text.includes('COALESCE(expires_at, created_at + make_interval(days => $2)) > now()') && params[1] === 90);
      return { rowCount: known ? 1 : 0, rows: known ? [{ id: 1, user_id: 7, stale: lookupStale }] : [] };
    }
    if (text.includes('GROUP BY currency')) return { rowCount: 0, rows: totals[`${String(params[1])}|${String(params[2])}`] ?? totals[String(params[1])] ?? [] };
    if (text.includes('COUNT(DISTINCT')) return { rowCount: 1, rows: [{ months: '10' }] };
    if (text.includes('FROM savings_goals')) return { rowCount: goals.length, rows: goals };
    if (text.includes('INSERT INTO access_tokens')) return { rowCount: 1, rows: [{ id: 1 }] };
    if (text.includes('SET revoked_at')) return { rowCount: 1, rows: [] };
    return { rowCount: 0, rows: [] };
  });
});

afterEach(() => mock.restoreAll());

const rpc = (body: unknown, token: string | null = TOKEN) =>
  fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  const text = body.result.content[0]?.text ?? '';
  return { isError: body.result.isError === true, text, json: () => JSON.parse(text) };
}

describe('who gets in', () => {
  test('no token: 401, and the database is never asked', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null);
    assert.equal(res.status, 401);
    assert.equal(queries.length, 0);
  });

  test('a login JWT is refused without a lookup, even a validly signed one', async () => {
    const jwtToken = jwt.sign({ userId: 7, email: 'a@b.c' }, 'secret');
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, jwtToken);
    assert.equal(res.status, 401);
    assert.equal(queries.length, 0);
  });

  test('an unknown or revoked token: 401', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'mgo_' + 'b'.repeat(43));
    assert.equal(res.status, 401);
    assert.match(queries[0]?.text ?? '', /revoked_at IS NULL/);
  });

  test('an expired token: 401, decided by the database\'s clock', async () => {
    tokenExpired = true;
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(res.status, 401);
    assert.match(queries[0]?.text ?? '', /revoked_at IS NULL AND COALESCE\(expires_at, created_at \+ make_interval\(days => \$2\)\) > now\(\)/);
    assert.equal(queries.length, 1, 'an expired token reached a tool or a write');
  });

  test('last_used_at is written only when it is more than five minutes old', async () => {
    await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.match(queries[0]!.text, /^SELECT id, user_id/);
    assert.match(queries[1]?.text ?? '', /^UPDATE access_tokens SET last_used_at = now\(\) WHERE id = \$1$/);
    assert.deepEqual(queries[1]?.params, [1]);
    queries = [];
    lookupStale = false;
    await rpc({ jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.equal(queries.length, 1, 'a fresh token is a read only');
  });

  test('the token is looked up by its hash, never stored or compared in the clear', async () => {
    await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepEqual(queries[0]?.params, [hashToken(TOKEN), 90]);
    assert.ok(!JSON.stringify(queries).includes(TOKEN));
  });
});

describe('the protocol', () => {
  test('initialize, a notification, and tools/list', async () => {
    const init = (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json()) as {
      result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string; title: string } };
    };
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    // `name` is what agent configs key on and survived the TermPocket rename;
    // only the display `title` carries the brand.
    assert.equal(init.result.serverInfo.name, 'mindgo');
    assert.equal(init.result.serverInfo.title, 'TermPocket');

    const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(note.status, 202);

    const list = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(list.result.tools.map((t) => t.name), ['money_term_summary', 'money_baseline', 'money_goals']);
  });

  test('an unknown method and a batch are JSON-RPC errors', async () => {
    const unknown = (await (await rpc({ jsonrpc: '2.0', id: 3, method: 'transactions/delete' })).json()) as { error: { code: number } };
    assert.equal(unknown.error.code, -32601);
    const batch = (await (await rpc([{ jsonrpc: '2.0', id: 4, method: 'tools/list' }])).json()) as { error: { code: number } };
    assert.equal(batch.error.code, -32600);
  });

  test('an id that is not a string or a number, or a string id over 200 characters, is an invalid request', async () => {
    for (const id of [{ a: 1 }, [1], true, 'x'.repeat(201)]) {
      const body = await (await rpc({ jsonrpc: '2.0', id, method: 'ping' })).json();
      assert.deepEqual(body, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    }
  });

  test('GET is refused', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 405);
  });
});

describe('the tools', () => {
  test('term summary: totals, top spending and pace against last term', async () => {
    const now = new Date();
    const current = boundsOf(currentTerm(now));
    const previous = boundsOf(previousTerm(currentTerm(now)));
    totals[current.start] = [
      { currency: 'CAD', type: 'income', category: 'Salary', total: '5000' },
      { currency: 'CAD', type: 'expense', category: 'Rent', total: '1500' },
      { currency: 'CAD', type: 'expense', category: 'Food', total: '500' },
    ];
    // Last term front-loaded its spending: 4000 by this point, whatever it spent later.
    totals[previous.start] = [{ currency: 'CAD', type: 'expense', category: 'Tuition', total: '4000' }];

    const out = (await callTool('money_term_summary')).json();
    const paceQuery = queries.filter((q) => q.text.includes('GROUP BY currency')).at(-1);
    const cutoff = new Date(Date.parse(previous.start) + out.days_elapsed * 86_400_000).toISOString().slice(0, 10);
    assert.deepEqual(paceQuery?.params, [7, previous.start, cutoff < previous.end ? cutoff : previous.end]);
    assert.equal(out.term, currentTerm(now));
    assert.equal(out.income, 5000);
    assert.equal(out.expenses, 2000);
    assert.equal(out.net, 3000);
    assert.equal(out.savings_rate, 0.6);
    assert.deepEqual(out.top_spending, [{ category: 'Rent', amount: 1500 }, { category: 'Food', amount: 500 }]);
    assert.equal(out.pace.last_term_same_point, 4000);
    assert.equal(out.pace.ratio, 0.5);
    assert.equal(out.pace.compared_with, labelOf(previousTerm(currentTerm(now))));
  });

  test('previous term has no pace, and a bad term is a tool error', async () => {
    assert.equal((await callTool('money_term_summary', { term: 'previous' })).json().pace, null);
    const bad = await callTool('money_term_summary', { term: '2020-fall; DROP TABLE' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /current or previous/);
  });

  test('baseline divides by the months that have data', async () => {
    const now = new Date();
    const start = `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    totals[start] = [
      { currency: 'CAD', type: 'income', category: 'Salary', total: '30000' },
      { currency: 'CAD', type: 'expense', category: 'Rent', total: '20000' },
    ];
    const out = (await callTool('money_baseline')).json();
    assert.equal(out.months_with_data, 10);
    assert.equal(out.monthly_income, 3000);
    assert.equal(out.monthly_spending, 2000);
    assert.equal(out.monthly_saving, 1000);
  });

  test('goals: percent, status and what each needs per month', async () => {
    const inAYear = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    goals = [
      { name: 'Emergency fund', target_amount: '6000.00', current_amount: '1200.00', target_date: inAYear, currency: 'CAD' },
      { name: 'Laptop', target_amount: '2000.00', current_amount: '2000.00', target_date: null, currency: 'CAD' },
      { name: 'Trip', target_amount: '1000.00', current_amount: '100.00', target_date: '2020-01-01', currency: 'USD' },
      { name: 'Almost', target_amount: '1000.00', current_amount: '996.00', target_date: inAYear, currency: 'CAD' },
    ];
    const out = (await callTool('money_goals')).json().goals;
    assert.equal(out[0].percent, 20);
    assert.equal(out[0].status, 'in progress');
    assert.ok(out[0].needed_per_month > 390 && out[0].needed_per_month < 410);
    assert.equal(out[1].status, 'reached');
    assert.equal(out[1].needed_per_month, null);
    assert.equal(out[2].status, 'overdue');
    assert.equal(out[2].currency, 'USD');
    assert.equal(out[2].needed_per_month, null, 'an overdue goal has no monthly plan');
    assert.equal(out[3].percent, 99, '99.6% is not reported as done');
  });

  test('a RangeError from inside a tool is a fault: a generic answer, logged by name only', async () => {
    mock.method(db, 'query', async (text: string) => {
      if (text.includes('FROM access_tokens WHERE token_hash')) return { rowCount: 1, rows: [{ id: 1, user_id: 7, stale: false }] };
      if (text.includes('FROM savings_goals')) throw new RangeError('Invalid time value: internal detail');
      return { rowCount: 0, rows: [] };
    });
    const logged: unknown[][] = [];
    mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
    const out = await callTool('money_goals');
    assert.equal(out.isError, true);
    assert.equal(out.text, 'TermPocket could not read that right now.');
    assert.equal(logged.length, 1);
    assert.ok(!JSON.stringify(logged).includes('internal detail'));
  });

  test('an unknown tool is a protocol error, -32602', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'delete_everything' } });
    const body = (await res.json()) as { error: { code: number } };
    assert.equal(body.error.code, -32602);
    const none = (await (await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: null })).json()) as { error: { code: number } };
    assert.equal(none.error.code, -32602);
  });

  test('amounts in other currencies are converted to CAD', async () => {
    mock.method(exchangeRateService, 'getExchangeRate', async (from: string, to: string) => {
      assert.equal(to, 'CAD');
      return from === 'USD' ? 1.4 : 0.2;
    });
    const now = new Date();
    totals[boundsOf(currentTerm(now)).start] = [
      { currency: 'USD', type: 'income', category: 'Salary', total: '1000' },
      { currency: 'CNY', type: 'expense', category: 'Food', total: '500' },
      { currency: 'CAD', type: 'expense', category: 'Food', total: '50' },
    ];
    const out = (await callTool('money_term_summary')).json();
    assert.equal(out.income, 1400);
    assert.equal(out.expenses, 150);
    assert.deepEqual(out.top_spending, [{ category: 'Food', amount: 150 }]);
  });

  test('every query is a read of the token owner\'s rows, and none reads descriptions or whole rows', async () => {
    await callTool('money_term_summary');
    await callTool('money_baseline');
    await callTool('money_goals');
    // The token lookup is checked under "who gets in"; the rest are the tools'.
    const reads = queries.filter((q) => !q.text.includes('access_tokens'));
    assert.ok(reads.length >= 5);
    for (const q of reads) {
      const sql = q.text.trim();
      assert.match(sql, /^SELECT /, sql);
      assert.doesNotMatch(sql, /SELECT \*|description/i, sql);
      // The user comes from the token row (user_id 7 in the stub), never the request.
      assert.match(sql, /user_id = \$1/, sql);
      assert.equal(q.params[0], 7, sql);
    }
  });

  test('answers are marked no-store, and a posted-back response gets 202', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const back = await rpc({ jsonrpc: '2.0', id: 5, result: {} });
    assert.equal(back.status, 202);
  });
});

describe('the token service', () => {
  // createToken runs on a dedicated pooled client so the limit holds under
  // concurrency; it is covered in accessTokenRoutes.test.ts.

  test('revoking is scoped to the owner', async () => {
    await revokeToken(7, 3);
    const update = queries.find((q) => q.text.includes('SET revoked_at'));
    assert.match(update?.text ?? '', /WHERE id = \$1 AND user_id = \$2 AND revoked_at IS NULL/);
    assert.deepEqual(update?.params, [3, 7]);
  });
});
