import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The startup check exits the process, so it is exercised in a child rather
 * than in-process.
 *
 * dotenv reads .env from the working directory, so each run happens in a temp
 * directory holding an empty one — otherwise the developer's real .env would
 * satisfy every case and these would all pass vacuously.
 */

const VALIDATE = path.join(__dirname, '..', 'config', 'validate.js');
let cwd: string;

before(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mindgo-config-'));
  fs.writeFileSync(path.join(cwd, '.env'), '');
});

after(() => fs.rmSync(cwd, { recursive: true, force: true }));

/**
 * Runs the validator with exactly `env` set, and nothing inherited.
 * spawnSync rather than execFileSync because the warnings go to stderr, which
 * execFileSync discards on a zero exit.
 */
function runWith(env: NodeJS.ProcessEnv): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(VALIDATE)})()`], {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  return { code: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

const GOOD_SECRET = 'x'.repeat(40);

describe('startup configuration check', () => {
  test('exits non-zero when nothing is configured', () => {
    const { code, output } = runWith({});
    assert.equal(code, 1);
    assert.match(output, /JWT_SECRET is not set/);
    assert.match(output, /No database configuration/);
  });

  test('exits when only the database is configured', () => {
    const { code, output } = runWith({ DATABASE_URL: 'postgres://x/y' });
    assert.equal(code, 1);
    assert.match(output, /JWT_SECRET is not set/);
    assert.doesNotMatch(output, /No database configuration/);
  });

  test('exits when only the secret is configured', () => {
    const { code, output } = runWith({ JWT_SECRET: GOOD_SECRET });
    assert.equal(code, 1);
    assert.match(output, /No database configuration/);
    assert.doesNotMatch(output, /JWT_SECRET is not set/);
  });

  test('names which discrete database parts are missing', () => {
    const { code, output } = runWith({ JWT_SECRET: GOOD_SECRET, DB_USER: 'u' });
    assert.equal(code, 1);
    assert.match(output, /missing: DB_HOST, DB_DATABASE/);
  });

  test('accepts a complete set of discrete parts instead of a URL', () => {
    const { code } = runWith({
      JWT_SECRET: GOOD_SECRET,
      DB_USER: 'u',
      DB_HOST: 'h',
      DB_DATABASE: 'd',
    });
    assert.equal(code, 0);
  });

  test('starts, but warns, on a short secret', () => {
    const { code, output } = runWith({ JWT_SECRET: 'short', DATABASE_URL: 'postgres://x/y' });
    assert.equal(code, 0, 'a weak secret is a warning, not a refusal to boot');
    assert.match(output, /JWT_SECRET is only 5 characters/);
  });

  test('warns for each missing optional key, naming what it breaks', () => {
    const { code, output } = runWith({ JWT_SECRET: GOOD_SECRET, DATABASE_URL: 'postgres://x/y' });
    assert.equal(code, 0);
    assert.doesNotMatch(output, /DEEPSEEK/);
    assert.match(output, /MAILBOXLAYER_API_KEY is not set/);
    // The consequence matters more than the name. This one was wrong until
    // round 10: it said registration 500s, which was true and is no longer.
    // A warning that describes a behaviour the code stopped having is worse
    // than no warning, so the wording is pinned rather than left to drift.
    assert.match(output, /disposable list/);
    assert.doesNotMatch(output, /fails outright|500/);
  });

  test('starts, but warns, when the retired AGENT_RUNTIME is still set', () => {
    const { code, output } = runWith({ JWT_SECRET: GOOD_SECRET, DATABASE_URL: 'postgres://x/y', AGENT_RUNTIME: 'direct' });
    assert.equal(code, 0);
    assert.match(output, /AGENT_RUNTIME is ignored/);
  });

  test('refuses to start when ANTHROPIC_CUSTOM_HEADERS is set: the AI client would send them to the provider', () => {
    const { code, output } = runWith({ JWT_SECRET: GOOD_SECRET, DATABASE_URL: 'postgres://x/y', ANTHROPIC_CUSTOM_HEADERS: 'X-Fictional: value' });
    assert.equal(code, 1);
    assert.match(output, /ANTHROPIC_CUSTOM_HEADERS is set/);
    assert.doesNotMatch(output, /X-Fictional|value\b/);
  });

  test('is silent when everything is present', () => {
    const { code, output } = runWith({
      JWT_SECRET: GOOD_SECRET,
      DATABASE_URL: 'postgres://x/y',
      EMAIL_USER: 'u',
      EMAIL_PASS: 'p',
      MAILBOXLAYER_API_KEY: 'k',
    });
    assert.equal(code, 0);
    assert.equal(output.trim(), '');
  });
});
