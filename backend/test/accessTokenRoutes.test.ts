import { test, describe, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import type { Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db = require('../db/connection');
import config = require('../config');
import {
  hashToken, looksLikeToken, createToken, listTokens, userForToken, resetExpiryProbe,
  MAX_TOKENS_PER_USER, TokenPasswordError, DemoTokenError,
} from '../services/accessTokens';

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
 *   - every response, a 401 included, is `Cache-Control: no-store`;
 *   - creating needs the account's password (403 when wrong, checked after
 *     the demo refusal), which never reaches a response or a log line;
 *   - creating and revoking are audited with ids only;
 *   - after migration 023 a token carries expires_at, an expired one is
 *     listed as expired, refused, and frees its slot; before 023 everything
 *     works as it did, without the column.
 */

const routerPath = require.resolve('../routes/accessTokens');
const limiterPath = require.resolve('../middleware/rateLimiter');
const SECRET = 'access-token-routes-test-secret';
const USER = 7;
const PASSWORD = 'fictional-token-password';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const DAY = 86_400_000;

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
  expires_at?: Date | null;
  token_hash?: string;
}

let server: Server;
/** Whether the stubbed database has migration 023's column. */
let expiryColumn: boolean;
let baseUrl: string;
let savedSecret: string | undefined;
let savedLimit: number;
let savedPasswordLimit: number;
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
  savedPasswordLimit = config.rateLimit.accessTokenPasswordMax;
  config.jwt.secret = SECRET;
  // The limiters are built at module load; their own tests below load tight ones.
  config.rateLimit.accessTokenMax = 10000;
  config.rateLimit.accessTokenPasswordMax = 10000;
  const app = express();
  app.use(express.json());
  app.use('/access-tokens', loadRouter());
  ({ server, baseUrl } = await listen(app));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  config.jwt.secret = savedSecret;
  config.rateLimit.accessTokenMax = savedLimit;
  config.rateLimit.accessTokenPasswordMax = savedPasswordLimit;
  delete require.cache[limiterPath];
  delete require.cache[routerPath];
});

beforeEach(() => {
  queries = [];
  released = 0;
  failInsert = false;
  demo = false;
  printed = [];
  expiryColumn = true;
  resetExpiryProbe();
  const created = new Date('2026-10-01T12:00:00Z');
  const later = new Date(created.getTime() + 90 * DAY);
  stored = [
    { id: 1, user_id: USER, name: 'DearByte', created_at: created, last_used_at: null, revoked_at: null, expires_at: later },
    { id: 2, user_id: USER, name: 'old laptop', created_at: created, last_used_at: created, revoked_at: created, expires_at: null },
    { id: 3, user_id: 9, name: 'someone else', created_at: created, last_used_at: null, revoked_at: null, expires_at: later },
  ];

  // A small model of the table, answering only what the service asks. Rows
  // are filtered by the user id the SQL was given, so a query scoped to the
  // wrong user shows up as the wrong rows, not just a wrong parameter. When
  // the SQL names expires_at the column must exist; the model then answers
  // as the database would, by its own clock.
  // After 023 a NULL expires_at means created_at + ttlDays, never "never".
  const effective = (t: StoredToken) => t.expires_at ?? new Date(t.created_at.getTime() + config.accessTokens.ttlDays * DAY);
  const isExpired = (t: StoredToken) => effective(t).getTime() <= Date.now();
  const summary = (t: StoredToken, withExpiry: boolean) => {
    const { user_id: _owner, token_hash: _hash, expires_at: expiresAt, ...rest } = t;
    return { ...rest, expires_at: withExpiry ? expiresAt ?? effective(t) : null, expired: withExpiry && isExpired(t) };
  };
  const answer = (via: Query['via']) => async (text: string, params: unknown[] = []) => {
    queries.push({ text, params, via });
    if (text.includes('information_schema.columns')) return { rowCount: 1, rows: [{ present: expiryColumn }] };
    const namesExpiry = /expires_at/.test(text.replace('NULL::timestamptz AS expires_at', ''));
    if (namesExpiry && !expiryColumn) throw Object.assign(new Error('column "expires_at" does not exist'), { code: '42703' });
    if (/^SELECT id, name, created_at, last_used_at, revoked_at, .* FROM access_tokens/s.test(text.trim())) {
      return { rowCount: 0, rows: stored.filter((t) => t.user_id === params[0]).map((t) => summary(t, namesExpiry)) };
    }
    if (text.includes('SELECT is_demo, password_hash FROM users')) return { rowCount: 1, rows: [{ is_demo: demo, password_hash: PASSWORD_HASH }] };
    if (text.includes('SET revoked_at')) {
      const hit = stored.find((t) => t.id === params[0] && t.user_id === params[1] && t.revoked_at === null);
      if (hit) hit.revoked_at = new Date();
      return { rowCount: hit ? 1 : 0, rows: [] };
    }
    if (text.includes('COUNT(*)')) {
      const counted = stored.filter((t) => t.user_id === params[0] && t.revoked_at === null && !(namesExpiry && isExpired(t)));
      return { rowCount: 1, rows: [{ n: counted.length }] };
    }
    if (text.includes('INSERT INTO access_tokens')) {
      if (failInsert) throw Object.assign(new Error(`duplicate key: Key (token_hash)=(${String(params[2])}) already exists.`), { code: '23505' });
      const now = new Date();
      const row: StoredToken = {
        id: 10 + stored.length, user_id: params[0] as number, name: params[1] as string, created_at: now, last_used_at: null, revoked_at: null, token_hash: params[2] as string,
        expires_at: namesExpiry ? new Date(now.getTime() + (params[3] as number) * DAY) : null,
      };
      stored.push(row);
      return { rowCount: 1, rows: [summary(row, namesExpiry)] };
    }
    if (text.includes('FROM access_tokens WHERE token_hash')) {
      const hit = stored.find((t) => t.token_hash === params[0] && t.revoked_at === null && !(namesExpiry && isExpired(t)));
      return { rowCount: hit ? 1 : 0, rows: hit ? [{ id: hit.id, user_id: hit.user_id, stale: false }] : [] };
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

/** The [AUDIT] lines printed, each with the JSON logged after it. */
const auditLines = () => {
  const lines: Array<{ message: string; data: unknown }> = [];
  printed.forEach((args, i) => {
    const first = args[0];
    if (typeof first === 'string' && first.startsWith('[AUDIT]')) {
      const next = printed[i + 1]?.[0];
      lines.push({ message: first.replace(/^\[AUDIT\] \S+ - /, ''), data: typeof next === 'string' ? JSON.parse(next) : null });
    }
  });
  return lines;
};

const create = (name: string, password: unknown = PASSWORD) => call('POST', '', { body: { name, password } });

describe('who gets in', () => {
  const endpoints: [string, string, unknown?][] = [
    ['GET', ''],
    ['POST', '', { name: 'agent', password: PASSWORD }],
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

const SUMMARY_KEYS = ['created_at', 'expired', 'expires_at', 'id', 'last_used_at', 'name', 'revoked_at'];

describe('GET /access-tokens', () => {
  test('lists the caller\'s tokens, revoked ones included, with the limit and each expiry', async () => {
    const res = await call('GET', '?user_id=9', { token: login() });
    assert.equal(res.status, 200);
    assert.equal(res.body.limit, MAX_TOKENS_PER_USER);
    assert.deepEqual(res.body.tokens.map((t: { id: number }) => t.id), [1, 2]);
    assert.ok(res.body.tokens[1].revoked_at, 'the revoked token is listed with revoked_at set');
    assert.equal(res.body.tokens[0].expires_at, '2026-12-30T12:00:00.000Z');
    for (const t of res.body.tokens) {
      assert.deepEqual(Object.keys(t).sort(), SUMMARY_KEYS);
    }
  });

  test('an expired token is listed as expired, by the database\'s clock', async () => {
    stored[0]!.expires_at = new Date(Date.now() - 1000);
    const res = await call('GET', '');
    assert.equal(res.body.tokens[0].expired, true);
    assert.match(queries.at(-1)!.text, /\(COALESCE\(expires_at, created_at \+ make_interval\(days => \$2\)\) <= now\(\)\) IS NOT FALSE AS expired/);
    assert.deepEqual(queries.at(-1)!.params, [USER, config.accessTokens.ttlDays]);
  });

  test('is scoped by the JWT\'s user id and never selects the hash', async () => {
    await call('GET', '?user_id=9');
    const listing = queries.filter((q) => !q.text.includes('information_schema'));
    assert.equal(listing.length, 1);
    const { text, params } = listing[0]!;
    assert.deepEqual(params, [USER, config.accessTokens.ttlDays]);
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
    const before = Date.now();
    const res = await call('POST', '', { body: { name: '  DearByte  ', password: PASSWORD, user_id: 9 } });
    assert.equal(res.status, 201);
    assert.ok(looksLikeToken(res.body.secret), 'the secret has the mgo_ format');
    assert.deepEqual(Object.keys(res.body).sort(), ['secret', 'token']);
    assert.deepEqual(Object.keys(res.body.token).sort(), SUMMARY_KEYS);
    assert.equal(res.body.token.name, 'DearByte', 'the name is trimmed');
    assert.equal(res.body.token.last_used_at, null);
    assert.equal(res.body.token.revoked_at, null);
    assert.equal(res.body.token.expired, false);
    const days = (new Date(res.body.token.expires_at).getTime() - before) / DAY;
    assert.ok(days >= 90 && days < 90.01, `expires ${days} days out`);
    assert.doesNotMatch(res.text, /token_hash|user_id/);

    const insert = queries.find((q) => q.text.includes('INSERT INTO access_tokens'));
    assert.deepEqual(insert?.params, [USER, 'DearByte', hashToken(res.body.secret), config.accessTokens.ttlDays]);
    assert.match(insert!.text, /expires_at\) VALUES \(\$1, \$2, \$3, now\(\) \+ make_interval\(days => \$4\)\)/);
    assert.ok(!JSON.stringify(queries).includes(res.body.secret), 'the secret itself reached SQL');
    assert.ok(!JSON.stringify(queries).includes(PASSWORD), 'the password reached SQL');

    const list = await call('GET', '');
    assert.equal(list.body.tokens.length, 1);
    assert.ok(!list.text.includes(res.body.secret), 'the secret was listed');
    assert.ok(!list.text.includes(hashToken(res.body.secret)), 'the hash was listed');
  });

  test('locks the user, checks the password, then counts, then inserts — all on one connection, in one transaction', async () => {
    const res = await create('agent');
    assert.equal(res.status, 201);
    // The pool is not used at all: BEGIN and COMMIT through db.query could
    // land on different connections and the lock would guard nothing.
    assert.ok(queries.every((q) => q.via === 'client'));
    const steps = queries.map((q) => q.text.trim().split(/\s+/).slice(0, 2).join(' '));
    assert.deepEqual(steps, ['BEGIN', 'SELECT is_demo,', 'SELECT EXISTS', 'SELECT COUNT(*)::int', 'INSERT INTO', 'COMMIT']);
    assert.match(queries[1]!.text, /FROM users WHERE id = \$1 FOR NO KEY UPDATE/);
    assert.deepEqual(queries[1]!.params, [USER]);
    assert.match(queries[3]!.text, /user_id = \$1 AND revoked_at IS NULL AND COALESCE\(expires_at, created_at \+ make_interval\(days => \$2\)\) > now\(\)/);
    assert.deepEqual(queries[3]!.params, [USER, config.accessTokens.ttlDays]);
    assert.equal(released, 1);
  });

  test('a wrong password: 403 access_token_password_incorrect, rolled back, nothing inserted, never echoed or logged', async () => {
    const wrong = 'fictional-wrong-password';
    const res = await create('agent', wrong);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'access_token_password_incorrect');
    assert.ok(!res.text.includes(wrong));
    assert.ok(!queries.some((q) => q.text.includes('INSERT') || q.text.includes('COUNT(*)')));
    assert.equal(queries.at(-1)?.text, 'ROLLBACK');
    assert.equal(released, 1);
    assert.ok(!logOutput().includes(wrong), 'the password reached the log');
    assert.deepEqual(auditLines(), []);
  });

  test('the demo account: 403 access_token_demo, checked before the password', async () => {
    demo = true;
    for (const password of [PASSWORD, 'fictional-wrong-password']) {
      queries = [];
      const res = await create('shared', password);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'access_token_demo');
      assert.ok(!queries.some((q) => q.text.includes('INSERT') || q.text.includes('COUNT(*)')));
      assert.equal(queries.at(-1)?.text, 'ROLLBACK');
    }
    assert.equal(released, 2);
  });

  describe('a missing or bad password: 400 before touching the database, never echoed', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['missing', { name: 'agent' }],
      ['empty', { name: 'agent', password: '' }],
      ['not a string', { name: 'agent', password: 12345678 }],
      ['an object', { name: 'agent', password: { $ne: '' } }],
      ['longer than 1024', { name: 'agent', password: 'p'.repeat(1025) }],
      ['with a bad name too', { name: '', password: 'fictional-echo-check' }],
    ];
    for (const [label, body] of cases) {
      test(label, async () => {
        const res = await call('POST', '', { body });
        assert.equal(res.status, 400);
        assert.ok(Array.isArray(res.body.errors));
        for (const e of res.body.errors) assert.deepEqual(Object.keys(e).sort(), ['msg', 'path']);
        if (typeof body.password === 'string' && body.password !== '') assert.ok(!res.text.includes(body.password));
        assert.doesNotMatch(res.text, /12345678|\$ne/);
        assert.equal(queries.length, 0);
      });
    }
  });

  test('creating and revoking are audited with ids only', async () => {
    stored = [];
    const res = await create('Fictional Name');
    assert.equal(res.status, 201);
    const id = res.body.token.id;
    assert.equal((await call('DELETE', `/${id}`)).status, 200);
    // A refused revoke is not audited.
    assert.equal((await call('DELETE', `/${id}`)).status, 404);
    assert.deepEqual(auditLines(), [
      { message: 'Access token created', data: { userId: USER, tokenId: id } },
      { message: 'Access token revoked', data: { userId: USER, tokenId: id } },
    ]);
    const output = logOutput();
    assert.ok(!output.includes('Fictional Name'), 'the name reached the log');
    assert.ok(!output.includes(res.body.secret), 'the token reached the log');
    assert.ok(!output.includes(hashToken(res.body.secret)), 'the hash reached the log');
    assert.ok(!output.includes(PASSWORD), 'the password reached the log');
  });

  test(`at ${MAX_TOKENS_PER_USER} active tokens: 409 token_limit, rolled back, nothing inserted`, async () => {
    stored = Array.from({ length: MAX_TOKENS_PER_USER }, (_, i) => ({
      id: i + 1, user_id: USER, name: `t${i}`, created_at: new Date(), last_used_at: null, revoked_at: null, expires_at: new Date(Date.now() + DAY),
    }));
    const res = await create('one too many');
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
    assert.equal((await create('replacement')).status, 201);
  });

  test('after 023, a NULL expires_at with an old created_at is expired: refused, not counted, listed expired', async () => {
    const old = new Date(Date.now() - (config.accessTokens.ttlDays + 1) * DAY);
    stored = [];
    const { token } = await createToken(USER, 'racing the migration', { operator: true });
    // As if the create had probed before 023 committed and inserted after its backfill.
    Object.assign(stored[0]!, { created_at: old, expires_at: null });
    stored.push(...Array.from({ length: MAX_TOKENS_PER_USER - 1 }, (_, i) => ({
      id: 100 + i, user_id: USER, name: `t${i}`, created_at: new Date(), last_used_at: null, revoked_at: null, expires_at: null,
    })));
    assert.equal(await userForToken(token), null, 'a NULL expiry was treated as never');
    const lookup = queries.filter((q) => q.text.includes('WHERE token_hash')).at(-1)!;
    assert.deepEqual(lookup.params, [hashToken(token), config.accessTokens.ttlDays]);
    // Four live tokens with a NULL expiry (recent created_at) plus the stale one: the limit sees four.
    assert.equal((await create('fifth')).status, 201);
    const listed = (await call('GET', '')).body.tokens.find((t: { name: string }) => t.name === 'racing the migration');
    assert.equal(listed.expired, true);
    assert.equal(listed.expires_at, new Date(old.getTime() + config.accessTokens.ttlDays * DAY).toISOString());
  });

  test('expired tokens do not count towards the limit', async () => {
    stored = Array.from({ length: MAX_TOKENS_PER_USER }, (_, i) => ({
      id: i + 1, user_id: USER, name: `t${i}`, created_at: new Date(), last_used_at: null, revoked_at: null,
      expires_at: new Date(Date.now() + (i === 0 ? -1000 : DAY)),
    }));
    assert.equal((await create('replacement')).status, 201);
  });

  describe('rejects a bad name before touching the database', () => {
    const cases: [string, unknown][] = [
      ['missing', { password: PASSWORD }],
      ['empty', { name: '', password: PASSWORD }],
      ['only spaces', { name: '    ', password: PASSWORD }],
      ['longer than the column', { name: 'x'.repeat(61), password: PASSWORD }],
      ['not a string', { name: 42, password: PASSWORD }],
      ['an object', { name: { $gt: '' }, password: PASSWORD }],
    ];
    for (const [label, body] of cases) {
      test(label, async () => {
        const res = await call('POST', '', { body });
        assert.equal(res.status, 400);
        assert.ok(Array.isArray(res.body.errors));
        assert.ok(!res.text.includes(PASSWORD));
        assert.equal(queries.length, 0);
      });
    }

    test('60 characters is allowed', async () => {
      assert.equal((await create('x'.repeat(60))).status, 201);
    });
  });

  test('nothing logged contains the secret, on success or on a database failure', async () => {
    const ok = await create('agent');
    assert.equal(ok.status, 201);
    assert.ok(!logOutput().includes(ok.body.secret));

    failInsert = true;
    const failed = await create('agent');
    assert.equal(failed.status, 500);
    assert.doesNotMatch(failed.text, /mgo_|token_hash|duplicate key/);
    const output = logOutput();
    // The handler did log the failure — otherwise the checks below prove nothing.
    assert.match(output, /Create access token error/);
    assert.match(output, /23505/);
    assert.doesNotMatch(output, /mgo_|Key \(token_hash\)|[0-9a-f]{64}/, 'a token or its hash reached the log');
    assert.ok(!output.includes(PASSWORD), 'the password reached the log');
    assert.equal(queries.at(-1)?.text, 'ROLLBACK');
    assert.equal(released, 2);
  });
});

describe('before migration 023 (no expires_at column)', () => {
  beforeEach(() => {
    expiryColumn = false;
    resetExpiryProbe();
  });

  test('create inserts without the column and reports no expiry', async () => {
    stored = [];
    const res = await create('agent');
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.token.expires_at, null);
    assert.equal(res.body.token.expired, false);
    const insert = queries.find((q) => q.text.includes('INSERT INTO access_tokens'));
    assert.equal(insert?.params.length, 3);
  });

  test('list reports expires_at null and nothing expired', async () => {
    const res = await call('GET', '');
    assert.equal(res.status, 200, res.text);
    for (const t of res.body.tokens) {
      assert.deepEqual(Object.keys(t).sort(), SUMMARY_KEYS);
      assert.equal(t.expires_at, null);
      assert.equal(t.expired, false);
    }
  });

  test('lookup works without the column, and a negative probe is not cached', async () => {
    stored = [];
    const { token } = await createToken(USER, 'agent', { operator: true });
    assert.equal(await userForToken(token), USER);
    const probes = () => queries.filter((q) => q.text.includes('information_schema')).length;
    const before = probes();
    assert.equal(await userForToken(token), USER);
    assert.equal(probes(), before + 1, 'a negative answer was cached');

    // 023 applied: noticed on the next request, then cached.
    expiryColumn = true;
    stored[0]!.expires_at = new Date(Date.now() - 1000);
    assert.equal(await userForToken(token), null, 'the expired token was accepted');
    const after = probes();
    await listTokens(USER);
    assert.equal(probes(), after, 'a positive answer was not cached');
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
    await assert.rejects(createToken(USER, 'one too many', { operator: true }), RangeError);
  });

  test('the CLI\'s operator authorization needs no password and still returns the id and token it reads', async () => {
    const { id, token, summary } = await createToken(USER, 'DearByte', { operator: true });
    assert.equal(typeof id, 'number');
    assert.ok(looksLikeToken(token));
    assert.ok(summary.expires_at, 'an operator-created token expires too');
    assert.deepEqual(auditLines(), [{ message: 'Access token created', data: { userId: USER, tokenId: id } }]);
  });

  test('the operator authorization still refuses the demo account', async () => {
    demo = true;
    await assert.rejects(createToken(USER, 'shared', { operator: true }), DemoTokenError);
  });

  test('anything but an explicit operator authorization needs a matching password', async () => {
    const forged: unknown[] = [{}, { password: undefined }, { operator: 'yes' }, { operator: false, password: 'wrong' }, { password: 'wrong' }];
    for (const authorization of forged) {
      await assert.rejects(createToken(USER, 'x', authorization as Parameters<typeof createToken>[2]), TokenPasswordError, JSON.stringify(authorization));
    }
    assert.ok(!queries.some((q) => q.text.includes('INSERT')));
    const { token } = await createToken(USER, 'x', { password: PASSWORD });
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
    assert.equal((await send('POST', '', USER, { name: 'a', password: PASSWORD })).status, 201);
    assert.equal((await send('DELETE', '/1', USER)).status, 200);
    const third = await send('POST', '', USER, { name: 'b', password: PASSWORD });
    assert.equal(third.status, 429);
    assert.equal(third.headers.get('cache-control'), 'no-store');
    assert.equal((await send('GET', '', USER)).status, 200);
    // Keyed on the user, so another account is unaffected.
    assert.equal((await send('POST', '', 9, { name: 'c', password: PASSWORD })).status, 201);
  });
});

describe('wrong-password limit', () => {
  let limited: { server: Server; baseUrl: string };

  before(async () => {
    config.rateLimit.accessTokenPasswordMax = 3;
    const app = express();
    app.use(express.json());
    app.use('/access-tokens', loadRouter());
    limited = await listen(app);
    config.rateLimit.accessTokenPasswordMax = 10000;
  });

  after(async () => {
    await new Promise<void>((resolve) => limited.server.close(() => resolve()));
  });

  const send = (userId: number, password: string) => fetch(`${limited.baseUrl}/access-tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${login(userId)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'agent', password }),
  });

  test('only wrong passwords count; past the budget even the right one is refused with 429, before bcrypt', async () => {
    // Successes and other refusals spend nothing.
    for (let i = 0; i < 4; i += 1) assert.equal((await send(USER, PASSWORD)).status, 201);
    demo = true;
    assert.equal((await send(USER, 'fictional-wrong')).status, 403, 'the demo refusal');
    demo = false;
    stored = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await send(USER, 'fictional-wrong');
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { code: string }).code, 'access_token_password_incorrect');
    }
    queries = [];
    const refused = await send(USER, PASSWORD);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('cache-control'), 'no-store');
    const body = await refused.text();
    assert.equal(JSON.parse(body).code, 'access_token_password_rate_limited');
    assert.ok(!body.includes(PASSWORD));
    assert.equal(queries.length, 0, 'a request past the budget reached the database');
    // Keyed on the user, so another account is unaffected.
    assert.equal((await send(9, PASSWORD)).status, 201);
  });
});
