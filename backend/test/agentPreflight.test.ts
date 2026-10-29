import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { listMigrations } from '../db/migrate';
import {
  classifyDatabase, classifyMigrations, directClientCheck, configChecks, exitCode, formatLine, formatReport, gatherFacts, secretsOf, skippedDatabase,
  type Check, type Db, type DbFacts, type PreflightSettings,
} from '../scripts/agentPreflight';

/**
 * The preflight's pure parts: formatting never leaks a secret, the exit code
 * follows FAIL alone, and migration state is classified from catalog facts.
 * The database client is a stub; no database, provider or network is used.
 */

const FAKE_KEY = 'sk-PREFLIGHT-FAKE-KEY-7f3a9c';
const FAKE_PASSWORD = 'pw-PREFLIGHT-FAKE-1b2c';
const FAKE_HOST = 'ep-fictional-preflight-pooler.example.invalid';
const FAKE_URL = `postgresql://owner:${FAKE_PASSWORD}@${FAKE_HOST}/mindgo?sslmode=require`;

function settings(overrides: { enabled?: boolean; apiKey?: string; model?: string; nodeEnv?: string } = {}): PreflightSettings {
  return {
    nodeEnv: overrides.nodeEnv ?? 'production',
    database: { url: FAKE_URL, password: '', schema: 'public' },
    agent: {
      enabled: overrides.enabled ?? false,
      apiKey: 'apiKey' in overrides ? overrides.apiKey : FAKE_KEY,
      model: overrides.model ?? 'claude-sonnet-5-5',
      timeoutMs: 90_000, maxToolCalls: 8, maxRows: 12, maxOutputTokens: 4000, maxTotalTokens: 64_000,
    },
  };
}

const AGENT_TABLES = ['agent_conversations', 'agent_runs', 'agent_messages', 'agent_drafts', 'agent_receipts', 'agent_admissions'];
const SOURCE_WITH_AGENT = "CHECK (((source)::text = ANY ((ARRAY['manual'::character varying, 'ocr'::character varying, 'ocr_llm'::character varying, 'agent'::character varying])::text[])))";
const SOURCE_WITHOUT_AGENT = "CHECK (((source)::text = ANY ((ARRAY['manual'::character varying, 'ocr'::character varying, 'ocr_llm'::character varying])::text[])))";
const STATUS_WITH_EXPIRED = "CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'confirmed'::character varying, 'cancelled'::character varying, 'superseded'::character varying, 'conflict'::character varying, 'expired'::character varying])::text[])))";
const STATUS_WITHOUT_EXPIRED = "CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'confirmed'::character varying, 'cancelled'::character varying, 'superseded'::character varying, 'conflict'::character varying])::text[])))";

/** A fully migrated database (013, 014 and 015 applied). */
function migrated(): DbFacts {
  return {
    versionNum: 170004, schemas: ['public'],
    tables: new Set(['transactions', ...AGENT_TABLES, 'agent_goal_proposals']),
    constraints: new Map([['transactions_source_check', SOURCE_WITH_AGENT], ['agent_goal_proposals_status_check', STATUS_WITH_EXPIRED]]),
    sourceColumn: true, incompatibleSources: 0, legacyCounts: {}, appliedMigrations: [],
  };
}
/** Production before this release: no agent tables, legacy tables still present. */
function preAgent(): DbFacts {
  return {
    versionNum: 170004, schemas: ['public'],
    tables: new Set(['transactions', 'watchlist', 'ai_plans']),
    constraints: new Map([['transactions_source_check', SOURCE_WITHOUT_AGENT]]),
    sourceColumn: true, incompatibleSources: 0, legacyCounts: { watchlist: 3, ai_plans: 5 }, appliedMigrations: null,
  };
}
const find = (checks: Check[], name: string) => {
  const found = checks.find(c => c.name === name);
  assert.ok(found, `no ${name} check`);
  return found;
};

describe('output never leaks a secret', () => {
  test('secretsOf covers the key, the URL, its password and its host', () => {
    const secrets = secretsOf(settings());
    for (const value of [FAKE_KEY, FAKE_URL, FAKE_PASSWORD, FAKE_HOST]) assert.ok(secrets.includes(value), 'missing a secret');
  });

  test('a detail quoting a secret is redacted, whole URL or any part of it', () => {
    const secrets = secretsOf(settings());
    for (const leak of [FAKE_KEY, FAKE_URL, FAKE_PASSWORD, FAKE_HOST, `connect to ${FAKE_HOST}:5432 failed`]) {
      const line = formatLine({ status: 'FAIL', name: 'db.reachable', detail: leak }, secrets);
      for (const value of [FAKE_KEY, FAKE_PASSWORD, FAKE_HOST, FAKE_URL]) assert.ok(!line.includes(value), `leaked in: ${line}`);
      assert.match(line, /\[redacted\]/);
    }
  });

  test('a full report built from fake settings contains no secret', () => {
    for (const enabled of [true, false]) {
      const s = settings({ enabled });
      const checks = [...configChecks(s), ...classifyDatabase(preAgent(), s), ...classifyDatabase(migrated(), s), ...skippedDatabase('database unreachable')];
      const report = formatReport(checks, secretsOf(s));
      for (const value of [FAKE_KEY, FAKE_PASSWORD, FAKE_HOST, 'owner:']) assert.ok(!report.includes(value), 'report leaked a secret');
      assert.match(report, /config\.claude_key\s+present: yes/);
    }
  });

  test('a model override that is not a plain id is never echoed', () => {
    const odd = 'claude haiku; key=sk-whatever';
    const checks = configChecks(settings({ model: odd }));
    const model = find(checks, 'config.claude_model');
    assert.equal(model.status, 'FAIL');
    assert.ok(!formatReport(checks).includes(odd));
  });

  test('a model that cannot turn thinking off fails; Haiku is only a warning', () => {
    for (const model of ['claude-opus-5-5', 'claude-fable-5-1']) {
      assert.equal(find(configChecks(settings({ model })), 'config.claude_model').status, 'FAIL', model);
    }
    assert.equal(find(configChecks(settings({ model: 'claude-haiku-5-5' })), 'config.claude_model').status, 'WARN');
  });

  test('details stay on one line', () => {
    assert.equal(formatLine({ status: 'WARN', name: 'x', detail: 'a\nb\r\nc' }).split('\n').length, 1);
  });
});

describe('exit code', () => {
  test('0 unless something FAILs', () => {
    assert.equal(exitCode([]), 0);
    assert.equal(exitCode([{ status: 'PASS', name: 'a', detail: '' }, { status: 'WARN', name: 'b', detail: '' }, { status: 'SKIP', name: 'c', detail: '' }]), 0);
    assert.equal(exitCode([{ status: 'PASS', name: 'a', detail: '' }, { status: 'FAIL', name: 'b', detail: '' }]), 1);
  });

  test('the summary line counts each status and names the outcome', () => {
    const report = formatReport([{ status: 'PASS', name: 'a', detail: '' }, { status: 'WARN', name: 'b', detail: '' }, { status: 'FAIL', name: 'c', detail: '' }]);
    assert.match(report, /Preflight FAILED: 1 PASS, 1 WARN, 1 FAIL, 0 SKIP$/);
    assert.match(formatReport([{ status: 'PASS', name: 'a', detail: 'ok' }]), /^PASS {2}a {23} {2}ok\n\nPreflight passed: 1 PASS/);
  });
});

describe('configuration', () => {
  test('flag and key are reported as booleans', () => {
    const on = configChecks(settings({ enabled: true }));
    assert.equal(find(on, 'config.agent_enabled').detail, 'true');
    assert.equal(find(on, 'config.claude_key').status, 'PASS');
    const noKey = configChecks(settings({ enabled: true, apiKey: undefined }));
    assert.equal(find(noKey, 'config.claude_key').status, 'WARN');
    assert.equal(find(configChecks(settings({ apiKey: undefined })), 'config.claude_key').status, 'PASS');
  });

  test('NODE_ENV other than production warns', () => {
    assert.equal(find(configChecks(settings({ nodeEnv: 'development' })), 'config.node_env').status, 'WARN');
    assert.equal(find(configChecks(settings()), 'config.node_env').status, 'PASS');
  });

  test('limits outside the schema constraints fail', () => {
    const s = settings();
    s.agent.maxToolCalls = 9;
    assert.equal(find(configChecks(s), 'config.limits').status, 'FAIL');
    assert.equal(find(configChecks(settings()), 'config.limits').status, 'PASS');
  });
});

describe('database classification', () => {
  test('a migrated database passes every migration check', () => {
    for (const enabled of [true, false]) {
      const checks = classifyDatabase(migrated(), settings({ enabled }));
      assert.deepEqual(checks.filter(c => c.status !== 'PASS'), []);
    }
  });

  test('missing 013 fails only when AGENT_ENABLED=true', () => {
    assert.equal(find(classifyDatabase(preAgent(), settings({ enabled: true })), 'migration.013').status, 'FAIL');
    assert.equal(find(classifyDatabase(preAgent(), settings({ enabled: false })), 'migration.013').status, 'WARN');
    // Tables present but the source check not widened is still incomplete.
    const half = migrated();
    half.constraints.set('transactions_source_check', SOURCE_WITHOUT_AGENT);
    assert.equal(find(classifyDatabase(half, settings({ enabled: true })), 'migration.013').status, 'FAIL');
  });

  test('014: absent tables pass; present tables warn with counts only', () => {
    assert.equal(find(classifyDatabase(migrated(), settings()), 'migration.014').status, 'PASS');
    const warn = find(classifyDatabase(preAgent(), settings()), 'migration.014');
    assert.equal(warn.status, 'WARN');
    assert.match(warn.detail, /watchlist 3 row\(s\), ai_plans 5 row\(s\); apply 014 after deploying the new frontend and backend/);
  });

  test("015: missing warns, a status check without 'expired' warns, complete passes", () => {
    const missing = find(classifyDatabase(preAgent(), settings({ enabled: true })), 'migration.015');
    assert.equal(missing.status, 'WARN');
    assert.match(missing.detail, /goal proposals unavailable until 015/);
    const stale = migrated();
    stale.constraints.set('agent_goal_proposals_status_check', STATUS_WITHOUT_EXPIRED);
    assert.equal(find(classifyDatabase(stale, settings()), 'migration.015').status, 'WARN');
    assert.equal(find(classifyDatabase(migrated(), settings()), 'migration.015').status, 'PASS');
  });

  test('PostgreSQL below 15 fails', () => {
    const old = migrated();
    old.versionNum = 140011;
    const version = find(classifyDatabase(old, settings()), 'db.server_version');
    assert.equal(version.status, 'FAIL');
    assert.match(version.detail, /PostgreSQL 14\.11; migration 013 requires 15/);
  });

  test('incompatible transaction sources fail, and are reported as a count', () => {
    const bad = preAgent();
    bad.incompatibleSources = 2;
    const sources = find(classifyDatabase(bad, settings()), 'db.transaction_sources');
    assert.equal(sources.status, 'FAIL');
    assert.match(sources.detail, /^2 incompatible/);
    const noColumn = preAgent();
    noColumn.sourceColumn = false; noColumn.incompatibleSources = null;
    assert.equal(find(classifyDatabase(noColumn, settings()), 'db.transaction_sources').status, 'FAIL');
  });

  test('a search_path without the schema fails', () => {
    const empty = migrated();
    empty.schemas = [];
    assert.equal(find(classifyDatabase(empty, settings()), 'db.search_path').status, 'FAIL');
  });
});

describe('gathering facts from a stubbed client', () => {
  function stub(state: { tables: string[]; constraints: Record<string, string>; sourceColumn: boolean; counts: Record<string, number>; incompatible: number; migrations?: Array<{ name: string; checksum: string }> }) {
    const statements: string[] = [];
    const db: Db = {
      query: async (text: string, params?: unknown[]) => {
        statements.push(text);
        if (text.includes('server_version_num')) return { rows: [{ version_num: 160002, schemas: ['public'] }] };
        if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params?.[1] }] };
        if (text.includes('pg_class')) return { rows: state.tables.map(name => ({ name })) };
        if (text.includes('pg_constraint')) return { rows: Object.entries(state.constraints).map(([name, definition]) => ({ name, definition })) };
        if (text.includes('information_schema.columns')) return { rows: state.sourceColumn ? [{ present: 1 }] : [] };
        if (text.includes('NOT IN')) return { rows: [{ n: state.incompatible }] };
        if (text.includes('schema_migrations')) return { rows: state.migrations ?? [] };
        const table = /\."(\w+)"$/.exec(text)?.[1];
        if (table && table in state.counts) return { rows: [{ n: state.counts[table] }] };
        throw new Error(`unexpected statement: ${text}`);
      },
    };
    return { db, statements };
  }

  test('reads only, and only counts from legacy tables', async () => {
    const { db, statements } = stub({ tables: ['transactions', 'watchlist', 'ai_plans'], constraints: { transactions_source_check: SOURCE_WITHOUT_AGENT }, sourceColumn: true, counts: { watchlist: 4, ai_plans: 0 }, incompatible: 0 });
    const facts = await gatherFacts(db, 'public');
    assert.deepEqual(facts.legacyCounts, { watchlist: 4, ai_plans: 0 });
    assert.equal(facts.versionNum, 160002);
    assert.equal(facts.incompatibleSources, 0);
    for (const sql of statements) {
      assert.match(sql.trim(), /^SELECT /, `not a read: ${sql}`);
      assert.ok(!/SELECT \*/.test(sql), `reads row contents: ${sql}`);
    }
    assert.ok(statements[0]?.includes('set_config'), 'statement_timeout is set before anything else');
    const checks = classifyDatabase(facts, settings({ enabled: true }));
    assert.equal(find(checks, 'migration.013').status, 'FAIL');
    assert.equal(find(checks, 'migration.014').status, 'WARN');
    assert.equal(find(checks, 'migration.015').status, 'WARN');
  });

  test('skips the source count when the column is missing, and legacy counts when the tables are gone', async () => {
    const { db, statements } = stub({ tables: ['transactions', ...AGENT_TABLES, 'agent_goal_proposals'], constraints: {}, sourceColumn: false, counts: {}, incompatible: 0 });
    const facts = await gatherFacts(db, 'public');
    assert.equal(facts.incompatibleSources, null);
    assert.ok(!statements.some(sql => sql.includes('NOT IN') || /count\(\*\)/.test(sql)));
    assert.equal(facts.appliedMigrations, null, 'no schema_migrations table: untracked');
    assert.ok(!statements.some(sql => sql.includes('FROM "public".schema_migrations')));
  });

  test('reads the migration records, names and checksums only, when the table exists', async () => {
    const records = [{ name: '022_agent_memories.sql', checksum: 'a'.repeat(64) }];
    const { db, statements } = stub({ tables: ['transactions', 'schema_migrations'], constraints: {}, sourceColumn: true, counts: {}, incompatible: 0, migrations: records });
    const facts = await gatherFacts(db, 'public');
    assert.deepEqual(facts.appliedMigrations, records);
    const read = statements.find(sql => sql.includes('schema_migrations') && !sql.includes('pg_class'));
    assert.match(read ?? '', /^SELECT name, checksum FROM "public"\.schema_migrations/);
  });
});

describe('migrations recorded by db:migrate', () => {
  const file = (name: string, checksum = 'c'.repeat(64)) => ({ name, number: name.slice(0, 3), sql: '', checksum });
  const files = [file('021_unique_email_lowercase.sql'), file('022_agent_memories.sql'), file('023_access_token_expiry.sql')];
  const record = (f: { name: string; checksum: string }) => ({ name: f.name, checksum: f.checksum });

  test('all applied: PASS with the count and the latest number', () => {
    const c = classifyMigrations(files, files.map(record));
    assert.equal(c.status, 'PASS');
    assert.equal(c.detail, 'all 3 applied (latest 023)');
  });

  test('pending, changed and orphaned records are WARNs that name the numbers, never a FAIL', () => {
    const pending = classifyMigrations(files, files.slice(0, 1).map(record));
    assert.equal(pending.status, 'WARN');
    assert.match(pending.detail, /^2 pending: 022, 023; see npm run db:migrate -- --status$/);
    const changed = classifyMigrations(files, [...files.slice(0, 2).map(record), { name: files[2]!.name, checksum: 'd'.repeat(64) }]);
    assert.match(changed.detail, /1 changed since applied: 023/);
    const orphan = classifyMigrations(files, [...files.map(record), { name: '024_gone.sql', checksum: 'e'.repeat(64) }]);
    assert.match(orphan.detail, /1 recorded with no file: 024/);
    assert.equal(exitCode([pending, changed, orphan]), 0);
  });

  test('an untracked database is a WARN pointing at --baseline', () => {
    const c = classifyMigrations(files, null);
    assert.equal(c.status, 'WARN');
    assert.match(c.detail, /--baseline/);
  });

  test('the real migration files in this build are all listed, 023 included', () => {
    const real = classifyMigrations(listMigrations(), null);
    assert.equal(real.status, 'WARN');
    assert.ok(listMigrations().some(f => f.number === '023'));
  });
});

test('a missing HTTP client fails the preflight: every turn needs it', () => {
  const missing = (): string => { throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' }); };
  assert.equal(directClientCheck(missing).status, 'FAIL');
  assert.equal(directClientCheck(() => '/x/index.js').status, 'PASS');
  // The real install, as Render's npm ci leaves it.
  assert.equal(directClientCheck().status, 'PASS');
});
