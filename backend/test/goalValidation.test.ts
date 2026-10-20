import { test, describe, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import express from 'express';
import db = require('../db/connection');

/**
 * POST and PUT /goals accept only the six currencies. The database refuses any
 * other since migration 018 (savings_goals_currency_check), so an unchecked
 * value would come back as a 500; the validator makes it a 400 before any
 * query. Omitting the currency still means CAD.
 */

const authPath = require.resolve('../middleware/auth');
const routerPath = require.resolve('../routes/goals');

interface Query { text: string; params: unknown[] }
let queries: Query[];

describe('goal currency validation through the real router', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    require.cache[authPath] = {
      id: authPath, filename: authPath, loaded: true,
      exports: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { userId: 7 }; next(); },
    } as NodeJS.Module;
    delete require.cache[routerPath];
    const app = express();
    app.use(express.json());
    app.use('/goals', require(routerPath));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a bound TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete require.cache[authPath];
    delete require.cache[routerPath];
  });

  beforeEach(() => {
    queries = [];
    mock.method(console, 'error', () => {});
    mock.method(db, 'query', async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      return { rowCount: 1, rows: [{ id: 1 }] };
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  const send = async (method: string, url: string, body: Record<string, unknown>) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.status;
  };
  const goal = { name: 'Fictional goal', target_amount: 500, target_date: '2027-04-30' };

  for (const currency of ['JPY', 'cad', '', 42]) {
    test(`POST with currency ${JSON.stringify(currency)} is 400 before any query`, async () => {
      assert.equal(await send('POST', '/goals', { ...goal, currency }), 400);
      assert.equal(queries.length, 0);
    });
  }

  test('PUT with another currency is 400 before any query', async () => {
    assert.equal(await send('PUT', '/goals/1', { ...goal, currency: 'JPY' }), 400);
    assert.equal(queries.length, 0);
  });

  test('a listed currency is stored', async () => {
    assert.equal(await send('POST', '/goals', { ...goal, currency: 'USD' }), 201);
    assert.equal(queries[0]!.params[6], 'USD');
  });

  test('no currency still means CAD', async () => {
    assert.equal(await send('POST', '/goals', goal), 201);
    assert.equal(queries[0]!.params[6], 'CAD');
  });
});
