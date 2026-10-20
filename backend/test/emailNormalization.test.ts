import { test, describe, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db = require('../db/connection');
import config = require('../config');

/**
 * Registration stores the address through normalizeEmail(): lowercased, and
 * for Gmail without dots or a +tag. Login and resend-verification used to look
 * the address up exactly as typed, so "John.Doe@Gmail.com", registered and
 * stored as "johndoe@gmail.com", could never sign in with what they typed.
 *
 * Through the real auth router with db.query answering from an in-memory
 * users table that applies the controllers' own lookup rule:
 * `WHERE email IN ($1, $2) ORDER BY email = $1 DESC` (resend adds LIMIT 1).
 */

const emailServicePath = require.resolve('../services/emailService');
const controllerPath = require.resolve('../controllers/authController');
const limiterPath = require.resolve('../middleware/rateLimiter');
const routerPath = require.resolve('../routes/auth');

interface StoredUser {
  id: number;
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  email_verified: boolean;
  email_verification_token: string | null;
  email_verification_expires: Date | null;
}

let users: StoredUser[];
let lookups: unknown[][];
let mailedTo: string[];
let server: Server;
let baseUrl: string;
let savedAuthMax: number;
let savedSecret: string | undefined;
const HASH = bcrypt.hashSync('password123', 4);

const user = (id: number, email: string, verified = true): StoredUser => ({
  id, email, password_hash: HASH, first_name: 'Fiction', last_name: 'User', email_verified: verified,
  email_verification_token: null, email_verification_expires: null,
});

before(async () => {
  // The limiter allows 5 auth requests per 15 minutes per IP, read at load.
  savedAuthMax = config.rateLimit.authMax;
  config.rateLimit.authMax = 1000;
  savedSecret = config.jwt.secret;
  config.jwt.secret = 'test-secret-not-a-real-one';
  require.cache[emailServicePath] = {
    id: emailServicePath, filename: emailServicePath, loaded: true,
    exports: {
      sendEmailVerification: async (to: string) => { mailedTo.push(to); },
      sendWeeklyReport: async () => {},
      generateWeeklyReport: async () => ({ text: '', html: '' }),
    },
  } as NodeJS.Module;
  for (const path of [controllerPath, limiterPath, routerPath]) delete require.cache[path];

  const app = express();
  app.use(express.json());
  app.use('/auth', require(routerPath));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a bound TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  config.rateLimit.authMax = savedAuthMax;
  config.jwt.secret = savedSecret;
  for (const path of [emailServicePath, controllerPath, limiterPath, routerPath]) delete require.cache[path];
});

beforeEach(() => {
  users = [];
  lookups = [];
  mailedTo = [];
  mock.method(console, 'log', () => {});
  mock.method(db, 'query', async (text: string, params: unknown[] = []) => {
    if (/FROM users WHERE email IN \(\$1, \$2\) ORDER BY email = \$1 DESC/.test(text)) {
      lookups.push(params);
      const [normalized, typed] = params as [string, string];
      const rows = [...users.filter((u) => u.email === normalized), ...users.filter((u) => u.email === typed && u.email !== normalized)];
      const limited = text.includes('LIMIT 1') ? rows.slice(0, 1) : rows;
      return { rowCount: limited.length, rows: limited };
    }
    if (text.startsWith('UPDATE users SET email_verification_token')) return { rowCount: 1, rows: [] };
    throw new Error(`unexpected query: ${text}`);
  });
});

afterEach(() => {
  mock.restoreAll();
});

const post = async (path: string, body: unknown) => {
  const response = await fetch(`${baseUrl}/auth${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { token?: string; error?: string; user?: { email: string } } };
};

describe('POST /auth/login', () => {
  for (const typed of ['John.Doe@Gmail.com', 'john.doe@gmail.com', 'JOHNDOE@GMAIL.COM', 'johndoe+uni@gmail.com', '  johndoe@gmail.com ']) {
    test(`"${typed}" signs in to the account registered as johndoe@gmail.com`, async () => {
      users = [user(7, 'johndoe@gmail.com')];
      const { status, body } = await post('/login', { email: typed, password: 'password123' });
      assert.equal(status, 200, body.error);
      assert.equal(body.user?.email, 'johndoe@gmail.com');
    });
  }

  test('a non-Gmail address keeps its dots and is matched in any case', async () => {
    users = [user(8, 'rick.liu@uwaterloo.ca')];
    assert.equal((await post('/login', { email: 'Rick.Liu@UWaterloo.ca', password: 'password123' })).status, 200);
    assert.deepEqual(lookups[0], ['rick.liu@uwaterloo.ca', 'Rick.Liu@UWaterloo.ca']);
  });

  test('an account stored as typed (before normalization existed) still signs in, and the token carries the stored address', async () => {
    users = [user(9, 'Early.User@Gmail.com')];
    const { status, body } = await post('/login', { email: 'Early.User@Gmail.com', password: 'password123' });
    assert.equal(status, 200);
    assert.equal((jwt.decode(body.token!) as { email: string }).email, 'Early.User@Gmail.com');
  });

  test('when both spellings of one mailbox exist, each owner signs in to their own account', async () => {
    users = [{ ...user(10, 'Two.Rows@Gmail.com'), password_hash: bcrypt.hashSync('legacy-pass', 4) }, user(11, 'tworows@gmail.com')];
    const legacy = await post('/login', { email: 'Two.Rows@Gmail.com', password: 'legacy-pass' });
    assert.equal((jwt.decode(legacy.body.token!) as { userId: number }).userId, 10);
    const normalized = await post('/login', { email: 'Two.Rows@Gmail.com', password: 'password123' });
    assert.equal((jwt.decode(normalized.body.token!) as { userId: number }).userId, 11);
    assert.equal((await post('/login', { email: 'Two.Rows@Gmail.com', password: 'neither' })).status, 400);
  });

  test('a wrong password is still refused', async () => {
    users = [user(7, 'johndoe@gmail.com')];
    const { status, body } = await post('/login', { email: 'John.Doe@Gmail.com', password: 'wrong-password' });
    assert.equal(status, 400);
    assert.equal(body.error, 'Invalid credentials');
  });

  test('an unknown address is still refused', async () => {
    assert.equal((await post('/login', { email: 'nobody@example.com', password: 'password123' })).status, 400);
  });
});

describe('POST /auth/resend-verification', () => {
  test('finds the account however the address is typed, and mails the stored address', async () => {
    users = [user(12, 'janedoe@gmail.com', false)];
    const { status } = await post('/resend-verification', { email: 'Jane.Doe@Gmail.com' });
    assert.equal(status, 200);
    assert.deepEqual(mailedTo, ['janedoe@gmail.com']);
  });
});
