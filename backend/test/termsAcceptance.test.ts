import { test, describe, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import express from 'express';
import axios from 'axios';
import db = require('../db/connection');
import config = require('../config');
import * as termsService from '../services/termsService';

/**
 * Acceptance of the Terms of Service and Privacy Policy (migration 017):
 *
 *   GET  /auth/terms               { currentVersion, acceptedVersion, required }
 *   POST /auth/terms { version }   records acceptance of the current version
 *   POST /auth/register            stores the version when accept_terms is true
 *
 * `required` is what makes the frontend show the accept card, so the cases
 * that matter are the ones where it must be false: the version already
 * accepted (asked once per version, not at every sign-in), the shared demo
 * account, and a database without 017.
 */

const authPath = require.resolve('../middleware/auth');
const emailServicePath = require.resolve('../services/emailService');
const controllerPath = require.resolve('../controllers/authController');
const routerPath = require.resolve('../routes/auth');

const CURRENT = config.legal.termsVersion;

interface Query {
  text: string;
  params: unknown[];
}

interface TermsBody {
  currentVersion?: string;
  acceptedVersion?: string | null;
  required?: boolean;
  code?: string;
}

let queries: Query[];
let columnPresent: boolean;
let isDemo: boolean;
let stored: string | null;

const stubModule = (path: string, exports: unknown): void => {
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
};

beforeEach(() => {
  queries = [];
  columnPresent = true;
  isDemo = false;
  stored = null;
  termsService.resetTermsProbe();
  mock.method(console, 'log', () => {});
  mock.method(db, 'query', async (text: string, params: unknown[] = []) => {
    queries.push({ text, params });
    if (text.includes('information_schema.columns')) return { rowCount: 1, rows: [{ present: columnPresent }] };
    if (text.startsWith('SELECT terms_version')) return { rowCount: 1, rows: [{ terms_version: stored, is_demo: isDemo }] };
    if (text.startsWith('UPDATE users SET terms_version')) {
      if (isDemo) return { rowCount: 0, rows: [] };
      stored = params[0] as string;
      return { rowCount: 1, rows: [{ terms_version: stored }] };
    }
    if (text.startsWith('SELECT id, email, email_verified')) return { rowCount: 0, rows: [] };
    if (text.startsWith('INSERT INTO users')) {
      return { rowCount: 1, rows: [{ id: 7, email: 'a@example.com', first_name: 'A', last_name: 'B', created_at: null, email_verification_expires: null }] };
    }
    throw new Error(`unexpected query: ${text}`);
  });
});

afterEach(() => {
  mock.restoreAll();
});

describe('GET and POST /auth/terms through the real router', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    stubModule(authPath, (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { userId: 7 }; next(); });
    stubModule(emailServicePath, {
      sendEmailVerification: async () => {},
      sendWeeklyReport: async () => {},
      generateWeeklyReport: async () => ({ text: '', html: '' }),
    });
    delete require.cache[controllerPath];
    delete require.cache[routerPath];

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
    delete require.cache[authPath];
    delete require.cache[emailServicePath];
    delete require.cache[controllerPath];
    delete require.cache[routerPath];
  });

  const get = async () => {
    const response = await fetch(`${baseUrl}/auth/terms`);
    return { status: response.status, cache: response.headers.get('cache-control'), body: (await response.json()) as TermsBody };
  };
  const post = async (body: unknown) => {
    const response = await fetch(`${baseUrl}/auth/terms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as TermsBody };
  };
  const updates = () => queries.filter((q) => q.text.startsWith('UPDATE'));

  test('a user who never accepted is asked', async () => {
    const { status, cache, body } = await get();
    assert.equal(status, 200);
    assert.equal(cache, 'no-store');
    assert.deepEqual(body, { currentVersion: CURRENT, acceptedVersion: null, required: true });
    assert.deepEqual(queries.find((q) => q.text.startsWith('SELECT terms_version'))?.params, [7]);
  });

  test('a user who accepted an older version is asked again', async () => {
    stored = '2000-01-01';
    assert.equal((await get()).body.required, true);
  });

  test('a user who accepted the current version is not asked', async () => {
    stored = CURRENT;
    assert.deepEqual((await get()).body, { currentVersion: CURRENT, acceptedVersion: CURRENT, required: false });
  });

  test('the shared demo account is never asked', async () => {
    isDemo = true;
    assert.equal((await get()).body.required, false);
  });

  test('before migration 017 nobody is asked and users is not read', async () => {
    columnPresent = false;
    assert.equal((await get()).body.required, false);
    assert.equal(queries.some((q) => q.text.startsWith('SELECT terms_version')), false);
  });

  test('accepting the current version stores it for this user', async () => {
    const { status, body } = await post({ version: CURRENT });
    assert.equal(status, 200);
    assert.deepEqual(body, { currentVersion: CURRENT, acceptedVersion: CURRENT, required: false });
    assert.deepEqual(updates().map((q) => q.params), [[CURRENT, 7]]);
    assert.match(updates()[0]!.text, /NOT is_demo/);
    assert.equal((await get()).body.required, false);
  });

  test('a stale version is refused with 409 and stores nothing', async () => {
    const { status, body } = await post({ version: '2000-01-01' });
    assert.equal(status, 409);
    assert.equal(body.code, 'terms_version_mismatch');
    assert.equal(body.currentVersion, CURRENT);
    assert.equal(queries.length, 0);
  });

  for (const bad of [{}, { version: '' }, { version: 42 }, { version: 'x'.repeat(33) }]) {
    test(`a malformed body ${JSON.stringify(bad).slice(0, 30)} is 400 before any query`, async () => {
      const { status, body } = await post(bad);
      assert.equal(status, 400);
      assert.equal(body.code, 'terms_invalid');
      assert.equal(queries.length, 0);
    });
  }

  test('the demo account accepting stores nothing and stays not required', async () => {
    isDemo = true;
    const { status, body } = await post({ version: CURRENT });
    assert.equal(status, 200);
    assert.equal(body.required, false);
    assert.equal(stored, null);
  });

  test('before migration 017 accepting answers 200 and writes nothing', async () => {
    columnPresent = false;
    const { status, body } = await post({ version: CURRENT });
    assert.equal(status, 200);
    assert.equal(body.acceptedVersion, null);
    assert.equal(updates().length, 0);
  });
});

describe('POST /auth/register stores the accepted version', () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = config.apiKeys.mailboxLayer;
    config.apiKeys.mailboxLayer = 'test-key-not-used-the-http-call-is-mocked';
    mock.method(axios, 'get', async () => ({
      data: { format_valid: true, disposable: false, mx_found: true, smtp_check: true },
    }));
    stubModule(emailServicePath, {
      sendEmailVerification: async () => {},
      sendWeeklyReport: async () => {},
      generateWeeklyReport: async () => ({ text: '', html: '' }),
    });
    delete require.cache[controllerPath];
  });

  afterEach(() => {
    config.apiKeys.mailboxLayer = savedKey;
    delete require.cache[emailServicePath];
    delete require.cache[controllerPath];
  });

  const register = async (extra: Record<string, unknown>) => {
    const controller = require(controllerPath);
    const res = {
      statusCode: 200,
      status(code: number) { res.statusCode = code; return res; },
      json() { return res; },
    };
    await controller.register({ body: { email: 'a@example.com', password: 'password123', first_name: 'A', last_name: 'B', ...extra } }, res);
    const insert = queries.find((q) => q.text.startsWith('INSERT INTO users'));
    assert.equal(res.statusCode, 201);
    assert.ok(insert, 'no INSERT');
    return insert;
  };

  test('a ticked box stores the current version and the time', async () => {
    const insert = await register({ accept_terms: true });
    assert.match(insert.text, /terms_version, terms_accepted_at\) VALUES \(.*\$7, NOW\(\)\)/);
    assert.equal(insert.params[6], CURRENT);
  });

  for (const value of [undefined, false, 'true', 1]) {
    test(`accept_terms ${JSON.stringify(value)} stores nothing (asked after sign-in instead)`, async () => {
      const insert = await register(value === undefined ? {} : { accept_terms: value });
      assert.doesNotMatch(insert.text, /terms_version/);
    });
  }

  test('before migration 017 a ticked box stores nothing', async () => {
    columnPresent = false;
    const insert = await register({ accept_terms: true });
    assert.doesNotMatch(insert.text, /terms_version/);
  });
});
