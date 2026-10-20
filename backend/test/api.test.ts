/**
 * Integration test over the path that matters: log in, create transactions,
 * read the summary back, and confirm one user cannot touch another's rows.
 *
 * It exercises auth, request validation, ownership scoping and the summary
 * arithmetic in one pass — the same ground that was covered by hand-written
 * curl commands, twice, during the region migration.
 *
 * ── Running it ───────────────────────────────────────────────────────────────
 * Needs a database, and deliberately will not borrow the one in .env:
 *
 *     TEST_DATABASE_URL=postgres://... npm test
 *
 * Without that variable the suite skips rather than failing, so `npm test`
 * stays useful on a machine with no Postgres. Requiring a separate variable is
 * the guard: pointing these tests at production has to be a deliberate act, and
 * they create and delete users.
 *
 * The database must already have the schema (`npm run db:setup`).
 *
 * No network: every transaction here is in one currency, so the summary does no
 * conversion and never calls the exchange-rate API. Conversion itself is
 * covered by exchangeRateService.test.ts.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Test, Response } from 'supertest';
import { hashVerificationToken } from '../utils/verificationToken';

const HAVE_DB = Boolean(process.env.TEST_DATABASE_URL);

if (HAVE_DB) {
  // Must be set before app.ts -> config -> db/connection is required.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
  process.env.NODE_ENV = 'test';
  // authLimiter counts /register, /login, /resend-verification and /test-email
  // together against one IP, and the whole suite shares an IP. At the default
  // of 5 the tests start 429ing partway through. Raised here rather than
  // branched on NODE_ENV in the middleware.
  process.env.RATE_LIMIT_AUTH_MAX = '10000';
  process.env.RATE_LIMIT_API_MAX = '10000';
  process.env.RATE_LIMIT_ACCESS_TOKEN_MAX = '10000';
}

describe('API integration', { skip: HAVE_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let request: typeof import('supertest');
  let db: typeof import('../db/connection');
  let bcrypt: typeof import('bcryptjs');
  let app: typeof import('../app');
  const PASSWORD = 'test-password-123';
  const users: number[] = [];

  interface SeededUser {
    id: number;
    email: string;
  }

  let alice: SeededUser;
  let bob: SeededUser;
  let aliceToken: string;
  let bobToken: string;

  /** Creates a verified user directly, bypassing registration's email round-trip. */
  async function seedUser(): Promise<SeededUser> {
    const email = `it-${crypto.randomUUID()}@example.invalid`;
    const hash = await bcrypt.hash(PASSWORD, 10);
    const r = await db.query<SeededUser>(
      `INSERT INTO users (email, password_hash, first_name, last_name, email_verified)
       VALUES ($1, $2, 'Integration', 'Test', TRUE) RETURNING id, email`,
      [email, hash]
    );
    users.push(r.rows[0]!.id);
    return r.rows[0]!;
  }

  async function login(email: string, password: string = PASSWORD) {
    return request(app).post('/auth/login').send({ email, password });
  }

  before(async () => {
    request = require('supertest');
    app = require('../app');
    db = require('../db/connection');
    bcrypt = require('bcryptjs');

    alice = await seedUser();
    bob = await seedUser();

    // authLimiter allows 5 attempts per 15 minutes per IP, and the whole suite
    // shares one. Log in once per user here and reuse the tokens; a test that
    // logs in on demand trips the limiter and fails with a 429.
    const assignments: [SeededUser, (t: string) => void][] = [
      [alice, (t) => { aliceToken = t; }],
      [bob, (t) => { bobToken = t; }],
    ];
    for (const [user, assign] of assignments) {
      const res = await login(user.email);
      assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.body)}`);
      assign(res.body.token);
    }
  });

  after(async () => {
    // ON DELETE CASCADE clears the transactions with them.
    if (users.length) {
      await db.query('DELETE FROM users WHERE id = ANY($1)', [users]);
    }
    const pool = db.getPool();
    if (pool) await pool.end();
  });

  const auth = (req: Test): Test => req.set('Authorization', `Bearer ${aliceToken}`);

  describe('authentication', () => {
    test('rejects a wrong password without saying which field was wrong', async () => {
      const res = await login(alice.email, 'not-the-password');
      assert.equal(res.status, 400);
      assert.match(res.body.error, /Invalid credentials/);
    });

    test('rejects an unauthenticated read', async () => {
      const res = await request(app).get('/transactions');
      assert.equal(res.status, 401);
    });

    test('rejects a forged token', async () => {
      const res = await request(app)
        .get('/transactions')
        .set('Authorization', 'Bearer not.a.real.token');
      assert.equal(res.status, 401);
    });

    test('leaves /health open, so platform health checks are never blocked', async () => {
      const res = await request(app).get('/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'OK');
    });
  });

  describe('registration validation', () => {
    // These assert the 400 path only. Registration proper calls MailboxLayer,
    // which needs a key and a network, so the happy path is out of scope here.
    const valid = {
      email: 'someone@example.invalid',
      password: 'long-enough-password',
      first_name: 'A',
      last_name: 'B',
    };
    const post = (body: Record<string, unknown>): Test => request(app).post('/auth/register').send({ ...valid, ...body });
    const messages = (res: Response): string => res.body.errors.map((e: { msg: string }) => e.msg).join(' ');

    test('rejects a password shorter than the configured minimum', async () => {
      const res = await post({ password: 'short' });
      assert.equal(res.status, 400);
      assert.match(messages(res), /at least 8 characters/);
    });

    test('rejects a name longer than the column allows', async () => {
      const res = await post({ first_name: 'x'.repeat(101) });
      assert.equal(res.status, 400);
      assert.match(messages(res), /at most 100 characters/);
    });

    test('rejects a malformed email', async () => {
      const res = await post({ email: 'not-an-email' });
      assert.equal(res.status, 400);
    });
  });

  describe('transactions', () => {
    const MONTH = { year: 2020, month: 6 }; // fixed, so the summary query is deterministic
    const made: number[] = [];

    const create = (body: Record<string, unknown>): Test =>
      auth(request(app).post('/transactions')).send({
        date: '2020-06-15',
        currency: 'CAD',
        ...body,
      });

    test('rejects an invalid payload', async () => {
      const res = await create({ amount: -5, description: '', category: '', type: 'sideways' });
      assert.equal(res.status, 400);
      assert.ok(res.body.errors.length >= 3, 'each bad field should be reported');
    });

    test('rejects a currency outside the allowed set', async () => {
      const res = await create({
        amount: 10, description: 'x', category: 'Food', type: 'expense', currency: 'XYZ',
      });
      assert.equal(res.status, 400);
    });

    test('creates income and expenses', async () => {
      const rows = [
        { amount: 5000, description: 'Salary', category: 'Salary', type: 'income' },
        { amount: 200.5, description: 'Groceries', category: 'Food', type: 'expense' },
        { amount: 99.5, description: 'Bus pass', category: 'Transport', type: 'expense' },
      ];
      for (const row of rows) {
        const res = await create(row);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        made.push(res.body.transaction ? res.body.transaction.id : res.body.id);
      }
      assert.equal(made.filter(Boolean).length, 3, 'every create should return an id');
    });

    test('summary totals match what was created', async () => {
      const res = await auth(
        request(app).get(`/summary/monthly?year=${MONTH.year}&month=${MONTH.month}&targetCurrency=CAD`)
      );
      assert.equal(res.status, 200);

      const s = res.body.summary || res.body;
      assert.equal(Number(s.totalIncome), 5000);
      assert.equal(Number(s.totalExpenses), 300);
      // The interesting one: net is the subtraction, and a sign error here
      // still looks like a number.
      assert.equal(Number(s.netIncome), 4700);
    });

    test('summary keeps categories separate', async () => {
      const res = await auth(
        request(app).get(`/summary/monthly?year=${MONTH.year}&month=${MONTH.month}&targetCurrency=CAD`)
      );
      const categories = (res.body.summary || res.body).categories || {};
      assert.equal(Number(categories.Food.expenses), 200.5);
      assert.equal(Number(categories.Transport.expenses), 99.5);
    });

    test('a different month is empty, so the date filter is real', async () => {
      const res = await auth(
        request(app).get(`/summary/monthly?year=${MONTH.year}&month=7&targetCurrency=CAD`)
      );
      assert.equal(res.status, 200);
      assert.equal(Number((res.body.summary || res.body).totalIncome), 0);
    });

    test('one user cannot read another user\'s transactions', async () => {
      const bobsView = await request(app)
        .get('/transactions')
        .set('Authorization', `Bearer ${bobToken}`);
      assert.equal(bobsView.status, 200);

      const rows = bobsView.body.transactions || bobsView.body;
      const ids = (Array.isArray(rows) ? rows : []).map((t: { id: number }) => t.id);
      for (const id of made) {
        assert.ok(!ids.includes(id), `Bob can see Alice's transaction ${id}`);
      }
    });

    test('deleting removes the row and the summary follows', async () => {
      const res = await auth(request(app).delete(`/transactions/${made[0]}`));
      assert.equal(res.status, 200);

      const after = await auth(
        request(app).get(`/summary/monthly?year=${MONTH.year}&month=${MONTH.month}&targetCurrency=CAD`)
      );
      assert.equal(Number((after.body.summary || after.body).totalIncome), 0);
    });

    test('deleting a row that is not yours does not delete it', async () => {
      const attempt = await request(app)
        .delete(`/transactions/${made[1]}`)
        .set('Authorization', `Bearer ${bobToken}`);
      assert.notEqual(attempt.status, 200);

      // And it is still Alice's. There is no GET /transactions/:id, so this
      // checks the list.
      const mine = await auth(request(app).get('/transactions'));
      const rows = mine.body.transactions || mine.body;
      assert.ok(
        rows.some((t: { id: number }) => t.id === made[1]),
        "Bob's delete removed Alice's row"
      );
    });
  });

  describe('screenshot import', () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
      date: '2021-03-10',
      amount: '12.34',
      description: 'Imported row',
      category: 'Groceries',
      type: 'expense',
      currency: 'CAD',
      source: 'ocr',
      edited: false,
      ...overrides,
    });
    const importRows = (rows: Record<string, unknown>[], token = aliceToken): Test =>
      request(app).post('/transactions/import').set('Authorization', `Bearer ${token}`).send({ rows });
    const countImported = async (userId: number): Promise<number> => Number((await db.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM transactions WHERE user_id = $1 AND date = '2021-03-10'", [userId]
    )).rows[0]!.n);

    test('saves the rows with their source, and one batch record', async () => {
      const res = await importRows([row(), row({ amount: '1.00', source: 'ocr_llm', edited: true })]);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.ids.length, 2);

      const saved = await db.query(
        'SELECT amount, source FROM transactions WHERE id = ANY($1) ORDER BY amount', [res.body.ids]
      );
      assert.deepEqual(saved.rows, [
        { amount: '1.00', source: 'ocr_llm' },
        { amount: '12.34', source: 'ocr' },
      ]);

      const batches = await db.query(
        'SELECT row_count, edited_count, llm_count FROM import_batches WHERE user_id = $1', [alice.id]
      );
      assert.deepEqual(batches.rows, [{ row_count: 2, edited_count: 1, llm_count: 1 }]);
    });

    test('a rejected import saves nothing', async () => {
      const before = await countImported(bob.id);
      const res = await importRows([row(), row({ amount: 'abc' })], bobToken);
      assert.equal(res.status, 400);
      assert.equal(await countImported(bob.id), before);
    });

    test('a manual entry is recorded as manual', async () => {
      const res = await auth(request(app).post('/transactions')).send({
        date: '2021-03-11', currency: 'CAD', amount: 3, description: 'Typed', category: 'Groceries', type: 'expense',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.transaction.source, 'manual');
    });

    test('parse finds the duplicate of a row just imported', async () => {
      const res = await auth(request(app).post('/import/parse')).send({
        today: '2021-03-20',
        model: 'test',
        image: { width: 800, height: 600 },
        lines: [
          { text: 'Mar 10', conf: 0.99, box: { x: 0, y: 0, width: 100, height: 40 } },
          { text: 'Imported row', conf: 0.99, box: { x: 0, y: 60, width: 200, height: 40 } },
          { text: '-$12.34', conf: 0.99, box: { x: 600, y: 60, width: 100, height: 40 } },
        ],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.rows.map((r: { date: string; amount: string; flags: string[] }) => [r.date, r.amount, r.flags]), [
        ['2021-03-10', '12.34', ['possible_duplicate']],
      ]);
    });
  });

  describe('removed stock and AI plan storage (migration 014)', () => {
    test('the dropped watchlist and ai_plans storage is gone, and so are its routes', async () => {
      const tables = await db.query<{ t: string | null }>(
        "SELECT to_regclass('watchlist')::text AS t UNION ALL SELECT to_regclass('ai_plans')::text"
      );
      assert.deepEqual(tables.rows.map((r) => r.t), [null, null]);
      for (const path of ['/ai/plans', '/investments/watchlist']) {
        assert.equal((await auth(request(app).get(path))).status, 404, path);
      }
    });
  });

  describe('expiry is enforced on read, whatever the hourly sweep has done', () => {
    // The retention sweep runs hourly, so expired rows can still exist. These
    // run the real filters against Postgres: an expired row must behave as
    // gone while it is physically still there.
    const minutesAgo = (m: number): string => `NOW() - make_interval(mins => ${m})`;

    test('an expired verification link is refused while the account still exists', async () => {
      const token = crypto.randomUUID().replace(/-/g, '');
      const r = await db.query<{ id: number }>(
        `INSERT INTO users (email, password_hash, first_name, last_name, email_verified,
                            email_verification_token, email_verification_expires, created_at)
         VALUES ($1, 'x', 'Unverified', 'Test', FALSE, $2, ${minutesAgo(1)}, ${minutesAgo(31)}) RETURNING id`,
        [`it-${crypto.randomUUID()}@example.invalid`, hashVerificationToken(token)]
      );
      users.push(r.rows[0]!.id);

      const res = await request(app).get(`/auth/verify-email/${token}`);
      assert.equal(res.status, 400);
      const after = await db.query<{ email_verified: boolean }>('SELECT email_verified FROM users WHERE id = $1', [r.rows[0]!.id]);
      assert.equal(after.rows[0]!.email_verified, false);
    });

    test('a live link verifies; the stored value is only its hash and does not work as a link', async () => {
      const token = crypto.randomBytes(32).toString('hex');
      const r = await db.query<{ id: number }>(
        `INSERT INTO users (email, password_hash, first_name, last_name, email_verified,
                            email_verification_token, email_verification_expires, created_at)
         VALUES ($1, 'x', 'Unverified', 'Test', FALSE, $2, NOW() + make_interval(mins => 20), ${minutesAgo(10)}) RETURNING id`,
        [`it-${crypto.randomUUID()}@example.invalid`, hashVerificationToken(token)]
      );
      users.push(r.rows[0]!.id);

      assert.equal((await request(app).get(`/auth/verify-email/${hashVerificationToken(token)}`)).status, 400);
      assert.equal((await request(app).get(`/auth/verify-email/${token}`)).status, 200);
      const after = await db.query<{ email_verified: boolean; email_verification_token: string | null }>(
        'SELECT email_verified, email_verification_token FROM users WHERE id = $1', [r.rows[0]!.id]);
      assert.deepEqual(after.rows[0], { email_verified: true, email_verification_token: null });
    });

    async function insertUnverified(createdAgo: string, expires: string, email = `it-${crypto.randomUUID()}@example.invalid`): Promise<number> {
      const r = await db.query<{ id: number }>(
        `INSERT INTO users (email, password_hash, first_name, last_name, email_verified,
                            email_verification_token, email_verification_expires, created_at)
         VALUES ($1, 'x', 'Unverified', 'Test', FALSE, $2, ${expires}, ${createdAgo}) RETURNING id`,
        [email, crypto.randomUUID()]
      );
      users.push(r.rows[0]!.id);
      return r.rows[0]!.id;
    }
    const inMinutes = (m: number): string => `NOW() + make_interval(mins => ${m})`;

    test('the sweep deletes stale unverified accounts and spares one with a live resent link', async () => {
      // Note: this runs the real sweep, so it also deletes any other stale
      // unverified account in the test database. That is why TEST_DATABASE_URL
      // must be a throwaway; the assertion only looks at this test's rows.
      const cleanup: typeof import('../services/cleanupService') = require('../services/cleanupService');
      const expired = await insertUnverified(minutesAgo(45), minutesAgo(15));
      const resent = await insertUnverified(minutesAgo(45), inMinutes(20));
      const pastCap = await insertUnverified(minutesAgo(25 * 60), inMinutes(20));

      await cleanup.deleteUnverifiedAccounts();

      const left = await db.query<{ id: number }>('SELECT id FROM users WHERE id = ANY($1)', [[expired, resent, pastCap]]);
      assert.deepEqual(left.rows.map((row) => row.id), [resent]);
    });

    test('register can reclaim exactly the accounts the sweep would delete', async () => {
      const cleanup: typeof import('../services/cleanupService') = require('../services/cleanupService');
      const address = () => `it-${crypto.randomUUID()}@example.invalid`;
      const stale = address();
      const live = address();
      await insertUnverified(minutesAgo(45), minutesAgo(15), stale);
      await insertUnverified(minutesAgo(45), inMinutes(20), live);

      assert.equal(await cleanup.reclaimStaleUnverifiedAccount(stale), true);
      assert.equal(await cleanup.reclaimStaleUnverifiedAccount(live), false);
      // A verified account is never reclaimable, however old.
      assert.equal(await cleanup.reclaimStaleUnverifiedAccount(alice.email), false);

      const left = await db.query<{ email: string }>('SELECT email FROM users WHERE email = ANY($1)', [[stale, live, alice.email]]);
      assert.deepEqual(left.rows.map((row) => row.email).sort(), [live, alice.email].sort());
    });
  });

  describe('MCP access tokens, managed from the web', () => {
    const asUser = (req: Test, token: string): Test => req.set('Authorization', `Bearer ${token}`);
    const create = (token: string, name = 'agent'): Test => asUser(request(app).post('/access-tokens'), token).send({ name });
    const mcp = (secret: string, body: object): Test =>
      request(app).post('/mcp').set('Authorization', `Bearer ${secret}`).send(body);

    test('a token created through the API opens /mcp, and revoking it closes it', async () => {
      const created = await create(aliceToken, 'DearByte');
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.headers['cache-control'], 'no-store');
      const { token, secret } = created.body as { token: { id: number; name: string }; secret: string };
      assert.match(secret, /^mgo_/);
      assert.equal(token.name, 'DearByte');

      const init = await mcp(secret, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      assert.equal(init.status, 200, JSON.stringify(init.body));
      assert.ok(init.body.result.serverInfo);
      const tools = await mcp(secret, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.equal(tools.status, 200);
      assert.ok(tools.body.result.tools.length > 0);

      const list = await asUser(request(app).get('/access-tokens'), aliceToken);
      assert.equal(list.status, 200);
      const listed = list.body.tokens.find((t: { id: number }) => t.id === token.id);
      assert.ok(listed.last_used_at, 'using the token did not mark it used');
      assert.ok(!JSON.stringify(list.body).includes(secret));
      assert.ok(!JSON.stringify(list.body).includes('token_hash'));

      const revoked = await asUser(request(app).delete(`/access-tokens/${token.id}`), aliceToken);
      assert.equal(revoked.status, 200);
      assert.deepEqual(revoked.body, { revoked: true });
      assert.equal((await mcp(secret, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).status, 401);

      const again = await asUser(request(app).delete(`/access-tokens/${token.id}`), aliceToken);
      assert.equal(again.status, 404);
    });

    test('one user cannot list or revoke another user\'s token', async () => {
      const created = await create(aliceToken);
      assert.equal(created.status, 201);
      const { token, secret } = created.body as { token: { id: number }; secret: string };

      const bobList = await asUser(request(app).get('/access-tokens'), bobToken);
      assert.equal(bobList.status, 200);
      assert.ok(!bobList.body.tokens.some((t: { id: number }) => t.id === token.id));

      const bobRevoke = await asUser(request(app).delete(`/access-tokens/${token.id}`), bobToken);
      assert.equal(bobRevoke.status, 404);
      // Still alive for its owner.
      assert.equal((await mcp(secret, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200);
      await asUser(request(app).delete(`/access-tokens/${token.id}`), aliceToken);
    });

    test('ten creations at once leave exactly the limit, and the rest are refused', async () => {
      const carol = await seedUser();
      const res = await login(carol.email);
      assert.equal(res.status, 200);
      const carolToken: string = res.body.token;

      const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => create(carolToken, `parallel ${i}`)));
      const statuses = answers.map((a) => a.status).sort();
      assert.equal(statuses.filter((s) => s === 201).length, 5, statuses.join(','));
      assert.equal(statuses.filter((s) => s === 409).length, 5, statuses.join(','));
      for (const a of answers.filter((x) => x.status === 409)) assert.equal(a.body.code, 'token_limit');

      const active = await db.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM access_tokens WHERE user_id = $1 AND revoked_at IS NULL', [carol.id]
      );
      assert.equal(active.rows[0]!.n, 5);
    });

    test('the service itself holds the limit when called in parallel, as the CLI calls it', async () => {
      const service: typeof import('../services/accessTokens') = require('../services/accessTokens');
      const dave = await seedUser();
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => service.createToken(dave.id, `direct ${i}`)));
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      assert.equal(fulfilled.length, service.MAX_TOKENS_PER_USER);
      assert.equal(rejected.length, 10 - service.MAX_TOKENS_PER_USER);
      for (const r of rejected) assert.ok(r.reason instanceof RangeError, String(r.reason));

      const active = await db.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM access_tokens WHERE user_id = $1 AND revoked_at IS NULL', [dave.id]
      );
      assert.equal(active.rows[0]!.n, service.MAX_TOKENS_PER_USER);
    });
  });
});
