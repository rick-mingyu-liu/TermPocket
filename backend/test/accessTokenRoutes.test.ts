import { test, describe, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import type { Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import db = require('../db/connection');
import config = require('../config');
import { hashToken, looksLikeToken, createToken, MAX_TOKENS_PER_USER } from '../services/accessTokens';

/**
 * /access-tokens lets a signed-in user manage the tokens that open POST /mcp.
 * What must hold, through the real router and the real JWT middleware, with
 * the database stubbed:
 *
 *   - nothing is answered without a login, and the owner is always the JWT's
 *     user — a user_id in the query string or body changes nothing;
 *   - a token's hash never leaves the server, and the token itself appears in
 *     exactly one response (the 201 that creates it) and in no log line;
 *   - the five-token limit is checked after the user's row is locked, inside
 *     one transaction on one connection, so two creations cannot both pass it;
 *   - every response, a 401 included, is `Cache-Control: no-store`.
 */

const routerPath = require.resolve('../routes/accessTokens');
const limiterPath = require.resolve('../middleware/rateLimiter');
const SECRET = 'access-token-routes-test-secret';
const USER = 7;

interface Query {
  text: string;
  params: unknown[];
  via: 'pool' | 'client';
}

interface StoredToken {
  id: number;
  user_id: number;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

let server: Server;
let baseUrl: string;
let savedSecret: string | undefined;
let savedLimit: number;
let queries: Query[];
let stored: StoredToken[];
let released: number;
/** Makes the client's INSERT throw, with the bound values in the message as pg's own errors can have. */
let failInsert: boolean;
let demo = false;
let printed: unknown[][];

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const s = app.listen(0);
  await new Promise<void>((resolve) => s.once('listening', () => resolve()));
  const address = s.address();
  if (address === null || typeof address === 'string') throw new Error('expected a bound TCP address');
  return { server: s, baseUrl: `http://127.0.0.1:${address.port}` };
}

function loadRouter(): express.Router {
  delete require.cache[limiterPath];
  delete require.cache[routerPath];
  return require(routerPath);
}

before(async () => {
  savedSecret = config.jwt.secret;
  savedLimit = config.rateLimit.accessTokenMax;
  config.jwt.secret = SECRET;
  // The limiter is built at module load; its own test below loads a tight one.
  config.rateLimit.accessTokenMax = 10000;
  const app = express();
  app.use(express.json());
  app.use('/access-tokens', loadRouter());
  ({ server, baseUrl } = await listen(app));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  config.jwt.secret = savedSecret;
  config.rateLimit.accessTokenMax = savedLimit;
  delete require.cache[limiterPath];
  delete require.cache[routerPath];
});

beforeEach(() => {
  queries = [];
  released = 0;
  failInsert = false;
  demo = false;
  printed = [];
  const created = new Date('2026-10-01T12:00:00Z');
  stored = [
    { id: 1, user_id: USER, name: 'DearByte', created_at: created, last_used_at: null, revoked_at: null },
    { id: 2, user_id: USER, name: 'old laptop', created_at: created, last_used_at: created, revoked_at: created },
    { id: 3, user_id: 9, name: 'someone else', created_at: created, last_used_at: null, revoked_at: null },
  ];

  // A small model of the table, answering only what the service asks. Rows
  // are filtered by the user id the SQL was given, so a query scoped to the
  // wrong user shows up as the wrong rows, not just a wrong parameter.
  const answer = (via: Query['via']) => async (text: string, params: unknown[] = []) => {
    queries.push({ text, params, via });
    if (/^SELECT id, name, created_at, last_used_at, revoked_at FROM access_tokens/.test(text.trim())) {
      return { rowCount: 0, rows: stored.filter((t) => t.user_id === params[0]).map(({ user_id: _owner, ...rest }) => rest) };
    }
    if (text.includes('SELECT is_demo FROM users')) return { rowCount: 1, rows: [{ is_demo: demo }] };
    if (text.includes('SET revoked_at')) {
      const hit = stored.find((t) => t.id === params[0] && t.user_id === params[1] && t.revoked_at === null);
      if (hit) hit.revoked_at = new Date();
      return { rowCount: hit ? 1 : 0, rows: [] };
    }
    if (text.includes('COUNT(*)')) {
      return { rowCount: 1, rows: [{ n: stored.filter((t) => t.user_id === params[0] && t.revoked_at === null).length }] };
    }
    if (text.includes('INSERT INTO access_tokens')) {
      if (failInsert) throw Object.assign(new Error(`duplicate key: Key (token_hash)=(${String(params[2])}) already exists.`), { code: '23505' });
      const row: StoredToken = { id: 10 + stored.length, user_id: params[0] as number, name: params[1] as string, created_at: new Date(), last_used_at: null, revoked_at: null };
      stored.push(row);
      const { user_id: _owner, ...rest } = row;
      return { rowCount: 1, rows: [rest] };
    }
    return { rowCount: 0, rows: [] };
  };

  mock.method(db, 'query', answer('pool'));
  const client = { query: answer('client'), release: () => { released += 1; } };
  mock.method(db, 'getPool', () => ({ connect: async () => client }));

  for (const level of ['log', 'error', 'warn', 'info', 'debug'] as const) {
    mock.method(console, level, (...args: unknown[]) => printed.push(args));
  }
});

afterEach(() => mock.restoreAll());

const login = (userId = USER) => jwt.sign({ userId, email: 'a@example.com' }, SECRET);

/** Every response from this router must be no-store, so every call checks it. */
async function call(method: string, path: string, { body, token = login() }: { body?: unknown; token?: string | null } = {}) {
  const res = await fetch(`${baseUrl}/access-tokens${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(res.headers.get('cache-control'), 'no-store', `${method} ${path} -> ${res.status} was cacheable`);
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

const render = (arg: unknown): string => (typeof arg === 'string' ? arg : util.inspect(arg, { depth: 6 }));
const logOutput = () => printed.map((a) => a.map(render).join(' ')).join('\n');

describe('who gets in', () => {
  const endpoints: [string, string, unknown?][] = [
    ['GET', ''],
    ['POST', '', { name: 'agent' }],
    ['DELETE', '/1'],
  ];
  for (const [method, path, body] of endpoints) {
    test(`${method} without a login: 401, and the database is never asked`, async () => {
      const res = await call(method, path, { body, token: null });
      assert.equal(res.status, 401);
      assert.equal(queries.length, 0);
    });

    test(`${method} with a token signed by someone else: 401`, async () => {
      const forged = jwt.sign({ userId: USER, email: 'a@example.com' }, 'not-the-secret');
      const res = await call(method, path, { body, token: forged });
      assert.equal(res.status, 401);
      assert.equal(queries.length, 0);
    });
  }

  test('an access token does not open this router — only a login does', async () => {
    const res = await call('GET', '', { token: 'mgo_' + 'a'.repeat(43) });
    assert.equal(res.status, 401);
    assert.equal(queries.length, 0);
  });
});

describe('GET /access-tokens', () => {
  test('lists the caller\'s tokens, revoked ones included, with the limit', async () => {
    const res = await call('GET', '?user_id=9', { token: login() });
    assert.equal(res.status, 200);
    assert.equal(res.body.limit, MAX_TOKENS_PER_USER);
    assert.deepEqual(res.body.tokens.map((t: { id: number }) => t.id), [1, 2]);
    assert.ok(res.body.tokens[1].revoked_at, 'the revoked token is listed with revoked_at set');
    for (const t of res.body.tokens) {
      assert.deepEqual(Object.keys(t).sort(), ['created_at', 'id', 'last_used_at', 'name', 'revoked_at']);
    }
  });

  test('is scoped by the JWT\'s user id and never selects the hash', async () => {
    await call('GET', '?user_id=9');
    assert.equal(queries.length, 1);
    const { text, params } = queries[0]!;
    assert.deepEqual(params, [USER]);
    assert.match(text, /WHERE user_id = \$1/);
    assert.doesNotMatch(text, /token_hash|\*/);
  });

  test('another user sees only their own', async () => {
    const res = await call('GET', '', { token: login(9) });
    assert.deepEqual(res.body.tokens.map((t: { id: number }) => t.id), [3]);
  });
});

describe('POST /access-tokens', () => {
  test('creates a token for the JWT\'s user and shows the secret once', async () => {
    stored = [];
    const res = await call('POST', '', { body: { name: '  DearByte  ', user_id: 9 } });
    assert.equal(res.status, 201);
    assert.ok(looksLikeToken(res.body.secret), 'the secret has the mgo_ format');
    assert.deepEqual(Object.keys(res.body).sort(), ['secret', 'token']);
    assert.deepEqual(Object.keys(res.body.token).sort(), ['created_at', 'id', 'last_used_at', 'name', 'revoked_at']);
    assert.equal(res.body.token.name, 'DearByte', 'the name is trimmed');
    assert.equal(res.body.token.last_used_at, null);
    assert.equal(res.body.token.revoked_at, null);
    assert.doesNotMatch(res.text, /token_hash|user_id/);

    const insert = queries.find((q) => q.text.includes('INSERT INTO access_tokens'));
    assert.deepEqual(insert?.params, [USER, 'DearByte', hashToken(res.body.secret)]);
    assert.ok(!JSON.stringify(queries).includes(res.body.secret), 'the secret itself reached SQL');

    const list = await call('GET', '');
    assert.equal(list.body.tokens.length, 1);
    assert.ok(!list.text.includes(res.body.secret), 'the secret was listed');
    assert.ok(!list.text.includes(hashToken(res.body.secret)), 'the hash was listed');
  });

  test('locks the user, then counts, then inserts — all on one connection, in one transaction', async () => {
    const res = await call('POST', '', { body: { name: 'agent' } });
    assert.equal(res.status, 201);
    // The pool is not used at all: BEGIN and COMMIT through db.query could
    // land on different connections and the lock would guard nothing.
    assert.deepEqual(queries.map((q) => q.via), ['client', 'client', 'client', 'client', 'client']);
    const steps = queries.map((q) => q.text.trim().split(/\s+/).slice(0, 2).join(' '));
    assert.deepEqual(steps, ['BEGIN', 'SELECT is_demo', 'SELECT COUNT(*)::int', 'INSERT INTO', 'COMMIT']);
    assert.match(queries[1]!.text, /FROM users WHERE id = \$1 FOR NO KEY UPDATE/);
    assert.deepEqual(queries[1]!.params, [USER]);
    assert.match(queries[2]!.text, /user_id = \$1 AND revoked_at IS NULL/);
    assert.equal(released, 1);
  });

  test('the demo account: 403 access_token_demo, rolled back, nothing inserted', async () => {
    demo = true;
    const res = await call('POST', '', { body: { name: 'shared' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'access_token_demo');
    assert.ok(!queries.some((q) => q.text.includes('INSERT') || q.text.includes('COUNT(*)')));
    assert.equal(queries.at(-1)?.text, 'ROLLBACK');
    assert.equal(released, 1);
  });

  test(`at ${MAX_TOKENS_PER_USER} active tokens: 409 token_limit, rolled back, nothing inserted`, async () => {
    stored = Array.from({ length: MAX_TOKENS_PER_USER }, (_, i) => ({
      id: i + 1, user_id: USER, name: `t${i}`, created_at: new Date(), last_used_at: null, revoked_at: null,
    }));
    const res = await call('POST', '', { body: { name: 'one too many' } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'token_limit');
    assert.ok(!queries.some((q) => q.text.includes('INSERT')));
    assert.equal(queries.at(-1)?.text, 'ROLLBACK');
    assert.equal(released, 1);
  });

  test('revoked tokens do not count towards the limit', async () => {
    stored = Array.from({ length: MAX_TOKENS_PER_USER }, (_, i) => ({
      id: i + 1, user_id: USER, name: `t${i}`, created_at: new Date(), last_used_at: null, revoked_at: i === 0 ? new Date() : null,
    }));
    assert.equal((await call('POST', '', { body: { name: 'replacement' } })).status, 201);
  });

  describe('rejects a bad name before touching the database', () => {
    const cases: [string, unknown][] = [
      ['missing', {}],
      ['empty', { name: '' }],
      ['only spaces', { name: '    ' }],
      ['longer than the column', { name: 'x'.repeat(61) }],
      ['not a string', { name: 42 }],
      ['an object', { name: { $gt: '' } }],
    ];
    for (const [label, body] of cases) {
      test(label, async () => {
        const res = await call('POST', '', { body });
        assert.equal(res.status, 400);
        assert.ok(Array.isArray(res.body.errors));
        assert.equal(queries.length, 0);
      });
    }

    test('60 characters is allowed', async () => {
      assert.equal((await call('POST', '', { body: { name: 'x'.repeat(60) } })).status, 201);
    });
  });

  test('nothing logged contains the secret, on success or on a database failure', async () => {
    const ok = await call('POST', '', { body: { name: 'agent' } });
    assert.equal(ok.status, 201);
    assert.ok(!logOutput().includes(ok.body.secret));

    failInsert = true;
    const failed = await call('POST', '', { body: { name: 'agent' } });
    assert.equal(failed.status, 500);
    assert.doesNotMatch(failed.text, /mgo_|token_hash|duplicate key/);
    const output = logOutput();
    // The handler did log the failure — otherwise the checks below prove nothing.
    assert.match(output, /Create access token error/);
    assert.match(output, /23505/);
    assert.doesNotMatch(output, /mgo_|Key \(token_hash\)|[0-9a-f]{64}/, 'a token or its hash reached the log');
    assert.equal(queries.at(-1)?.text, 'ROLLBACK');
    assert.equal(released, 2);
  });
});

describe('DELETE /access-tokens/:id', () => {
  test('revokes the caller\'s token, scoped by the JWT\'s user id', async () => {
    const res = await call('DELETE', '/1', { body: { user_id: 9 } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { revoked: true });
    assert.deepEqual(queries[0]?.params, [1, USER]);
    assert.match(queries[0]?.text ?? '', /WHERE id = \$1 AND user_id = \$2 AND revoked_at IS NULL/);
  });

  test('unknown, already revoked and someone else\'s all answer the same 404', async () => {
    const answers = [];
    for (const id of [999, 2, 3]) {
      const res = await call('DELETE', `/${id}`);
      answers.push([res.status, res.text]);
    }
    assert.deepEqual(answers[0], [404, JSON.stringify({ error: 'Token not found' })]);
    assert.deepEqual(answers[1], answers[0]);
    assert.deepEqual(answers[2], answers[0]);
    assert.equal(stored.find((t) => t.id === 3)?.revoked_at, null, 'another user\'s token was revoked');
  });

  for (const id of ['abc', '0', '-1', '1.5', '99999999999']) {
    test(`rejects id ${id} without touching the database`, async () => {
      const res = await call('DELETE', `/${id}`);
      assert.equal(res.status, 400);
      assert.equal(queries.length, 0);
    });
  }
});

describe('the token service', () => {
  test('past the limit, createToken throws a RangeError, which the CLI prints', async () => {
    stored = Array.from({ length: MAX_TOKENS_PER_USER }, (_, i) => ({
      id: i + 1, user_id: USER, name: `t${i}`, created_at: new Date(), last_used_at: null, revoked_at: null,
    }));
    await assert.rejects(createToken(USER, 'one too many'), RangeError);
  });

  test('still returns the id and token the CLI reads', async () => {
    const { id, token } = await createToken(USER, 'DearByte');
    assert.equal(typeof id, 'number');
    assert.ok(looksLikeToken(token));
  });
});

describe('rate limit', () => {
  let limited: { server: Server; baseUrl: string };

  before(async () => {
    config.rateLimit.accessTokenMax = 2;
    const app = express();
    app.use(express.json());
    app.use('/access-tokens', loadRouter());
    limited = await listen(app);
    config.rateLimit.accessTokenMax = 10000;
  });

  after(async () => {
    await new Promise<void>((resolve) => limited.server.close(() => resolve()));
  });

  test('creating and revoking share a per-user budget; listing is not limited by it', async () => {
    const send = (method: string, path: string, userId: number, body?: unknown) => fetch(`${limited.baseUrl}/access-tokens${path}`, {
      method,
      headers: { authorization: `Bearer ${login(userId)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal((await send('POST', '', USER, { name: 'a' })).status, 201);
    assert.equal((await send('DELETE', '/1', USER)).status, 200);
    const third = await send('POST', '', USER, { name: 'b' });
    assert.equal(third.status, 429);
    assert.equal(third.headers.get('cache-control'), 'no-store');
    assert.equal((await send('GET', '', USER)).status, 200);
    // Keyed on the user, so another account is unaffected.
    assert.equal((await send('POST', '', 9, { name: 'c' })).status, 201);
  });
});
