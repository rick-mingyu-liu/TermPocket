import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import axios from 'axios';
import db = require('../db/connection');
import config = require('../config');
import { hashVerificationToken } from '../utils/verificationToken';

/**
 * A regression guard for item 16: registration must not write the
 * email-verification token to the log.
 *
 * The token verifies an account on its own, so anyone who could read the logs
 * could verify an account they did not own for the 30 minutes it stayed valid.
 * Reading the code proves it is gone today; this proves it stays gone.
 *
 * Runs the real `register` handler with its collaborators stubbed — no
 * database, no network, no SMTP — and inspects everything it printed.
 *
 * `sendEmailVerification` is destructured at module load in authController, so
 * mocking the exports object would not reach the local binding. The module is
 * replaced in `require.cache` before authController is first required instead.
 */

const emailServicePath = require.resolve('../services/emailService');
const authControllerPath = require.resolve('../controllers/authController');

// The token the stubbed email would have carried: the credential itself.
let mailedToken: string | null = null;

function loadControllerWithStubbedEmail() {
  // A stub Module: only `exports` (the three functions authController
  // destructures out of emailService at module load) is ever read back out of
  // the cache here, so the rest of NodeJS.Module's shape is unused.
  require.cache[emailServicePath] = {
    id: emailServicePath,
    filename: emailServicePath,
    loaded: true,
    exports: {
      sendEmailVerification: async (_to: string, _name: string, token: string) => { mailedToken = token; },
      sendWeeklyReport: async () => {},
      generateWeeklyReport: async () => ({ text: '', html: '' }),
    },
  } as NodeJS.Module;
  delete require.cache[authControllerPath];
  return require(authControllerPath);
}

interface FakeRes {
  statusCode: number | null;
  body: unknown;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

describe('POST /auth/register logging', () => {
  const EMAIL = 'john.doe@example.com';
  let printed: unknown[][];
  let insertedToken: string | null;
  let savedKey: string | undefined;

  beforeEach(() => {
    printed = [];
    insertedToken = null;
    mailedToken = null;

    // A key is set so these tests always take the mocked MailboxLayer path and
    // do not depend on the environment. They used to *need* one: validation
    // threw without it and `register` 500'd before reaching the code under
    // test, so the suite passed locally on a developer .env and went red in CI.
    // Round 10 fixed that -- registration now falls back to the domain list --
    // and the test at the bottom of this file holds it fixed.
    savedKey = config.apiKeys.mailboxLayer;
    config.apiKeys.mailboxLayer = 'test-key-not-used-the-http-call-is-mocked';

    mock.method(console, 'log', (...args: unknown[]) => printed.push(args));
    mock.method(console, 'error', (...args: unknown[]) => printed.push(args));

    // MailboxLayer says the address is fine.
    mock.method(axios, 'get', async () => ({
      data: { format_valid: true, disposable: false, mx_found: true, smtp_check: true },
    }));

    mock.method(db, 'query', async (sql: string, params: unknown[]) => {
      if (/^SELECT/i.test(sql.trim())) return { rows: [] };          // no existing user
      // params[4] is the verification token authController.register generates
      // via crypto.randomBytes(32).toString('hex') and binds fifth in the
      // INSERT — always a string on this branch; db.query's mocked signature
      // only knows params as unknown[].
      insertedToken = params[4] as string;                             // the token's hash, as stored
      return {
        rows: [{
          id: 7,
          email: EMAIL,
          first_name: 'John',
          last_name: 'Doe',
          created_at: new Date('2026-01-01T00:00:00Z'),
          email_verification_expires: new Date('2026-01-01T00:30:00Z'),
        }],
      };
    });
  });

  afterEach(() => {
    config.apiKeys.mailboxLayer = savedKey;
    mock.restoreAll();
    delete require.cache[emailServicePath];
    delete require.cache[authControllerPath];
  });

  async function register() {
    const authController = loadControllerWithStubbedEmail();
    const res = fakeRes();
    await authController.register(
      { body: { email: EMAIL, password: 'password123', first_name: 'John', last_name: 'Doe' } },
      res
    );
    // inspect(), not String(). console.log('...', { email }) renders an object
    // argument as "[object Object]" under String(), so an address logged inside
    // an object would pass every assertion below while sitting in the log. A
    // mutation that did exactly that went undetected until this was fixed.
    const render = (arg: unknown): string => (typeof arg === 'string' ? arg : util.inspect(arg, { depth: 6 }));
    return { res, output: printed.map((a) => a.map(render).join(' ')).join('\n') };
  }

  test('the handler still succeeds with these stubs', async () => {
    // If this fails the other assertions prove nothing — they would be
    // inspecting the log of a request that never got as far as a token.
    const { res } = await register();
    assert.equal(res.statusCode, 201);
    assert.ok(insertedToken, 'no token reached the INSERT');
  });

  test('does not log the verification token', async () => {
    const { output } = await register();
    assert.ok(mailedToken, 'no token reached the email');
    assert.ok(!output.includes(mailedToken!), 'the verification token was written to the log');
    assert.ok(!output.includes(insertedToken!), 'the stored hash was written to the log');
  });

  test('stores only the hash of the token it emails', async () => {
    await register();
    assert.equal(insertedToken, hashVerificationToken(mailedToken!));
    assert.notEqual(insertedToken, mailedToken);
  });

  test('does not log any 64-character hex string', async () => {
    // Belt and braces: catches a token logged after being reformatted, and any
    // other credential of the same shape that gets added later.
    const { output } = await register();
    assert.doesNotMatch(output, /\b[0-9a-f]{64}\b/);
  });

  test('does not log the raw email address', async () => {
    const { output } = await register();
    assert.ok(!output.includes(EMAIL), 'the raw address was written to the log');
  });

  test('logs the masked address and the user id instead', async () => {
    // The point is not silence — a registration still has to be traceable.
    const { output } = await register();
    assert.match(output, /j\*\*\*@example\.com/);
    assert.match(output, /user 7/);
  });

  test('registers successfully with no MailboxLayer key at all', async () => {
    // Decision C, from the register handler's side rather than the validator's:
    // the missing key must degrade to the domain list, not 500. This is the
    // regression that made the suite environment-dependent, so it is asserted
    // here as well as in emailValidation.test.ts.
    config.apiKeys.mailboxLayer = undefined;

    const { res } = await register();

    assert.equal(res.statusCode, 201);
    assert.ok(insertedToken, 'no token reached the INSERT');
  });

  test('still logs no token or raw address when the key is missing', async () => {
    // The fallback path prints different lines from the MailboxLayer path, so
    // it needs its own check rather than inheriting the ones above.
    config.apiKeys.mailboxLayer = undefined;

    const { output } = await register();

    assert.ok(!output.includes(mailedToken!), 'the verification token was written to the log');
    assert.ok(!output.includes(insertedToken!), 'the stored hash was written to the log');
    assert.ok(!output.includes(EMAIL), 'the raw address was written to the log');
    assert.match(output, /user 7/);
  });
});
