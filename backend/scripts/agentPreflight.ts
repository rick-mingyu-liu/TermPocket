import config = require('../config');
import type { PoolClient } from 'pg';
import { getPool } from '../db/connection';
import { errorSummary } from '../utils/errorSummary';
import { runAgent } from '../services/agent/runtime';
import { AgentError, type AgentRecords } from '../services/agent/types';

/**
 * Production preflight for Pocky (conversation recording), run in Render's shell
 * before and after applying migrations 013–015 and setting the agent env vars:
 *
 *   npm run agent:preflight            # config, database, host and network
 *   npm run agent:preflight -- --live  # plus one fictional model turn
 *
 * Prints one line per check, `PASS|FAIL|WARN|SKIP  <check>  <detail>`, and
 * exits non-zero only when something FAILs. It never prints a secret, a
 * connection string, a hostname, a row or an env value beyond booleans,
 * counts and versions. Every database statement runs inside one READ ONLY
 * transaction with a short statement_timeout, and is rolled back.
 */

export type Status = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
export interface Check { status: Status; name: string; detail: string }

/** The slice of `config` the checks read; tests pass a fake one. */
export interface PreflightSettings {
  nodeEnv: string;
  database: { url?: string; host?: string; password?: string; schema: string };
  agent: Pick<typeof config.agent, 'enabled' | 'apiKey' | 'model' | 'timeoutMs' | 'maxToolCalls' | 'maxRows' | 'maxOutputTokens' | 'maxTotalTokens'>;
}

const DEFAULT_MODEL = 'deepseek-flash';
const AGENT_TABLES = ['agent_conversations', 'agent_runs', 'agent_messages', 'agent_drafts', 'agent_receipts', 'agent_admissions'] as const;
const LEGACY_TABLES = ['watchlist', 'ai_plans'] as const;
const PROPOSALS_TABLE = 'agent_goal_proposals';
const SOURCE_CHECK = 'transactions_source_check';
const PROPOSAL_STATUS_CHECK = 'agent_goal_proposals_status_check';
const STATEMENT_TIMEOUT = '5s';
const CONNECT_TIMEOUT_MS = 10_000;
const NETWORK_TIMEOUT_MS = 5_000;
const LIVE_BUDGET_MS = 90_000;
const PROVIDER_URL = 'https://api.deepseek.com/anthropic';

const check = (status: Status, name: string, detail: string): Check => ({ status, name, detail });
/** Model turns need both the flag and the key; host problems only block them then. */
const modelTurnsExpected = (s: PreflightSettings) => s.agent.enabled && Boolean(s.agent.apiKey);
const hostProblem = (s: PreflightSettings): Status => (modelTurnsExpected(s) ? 'FAIL' : 'WARN');
const describeError = (e: unknown) => {
  const { error, code } = errorSummary(e);
  return code ? `${error} ${code}` : error;
};

// ---------------------------------------------------------------------------
// Output

/** Every value that must never reach the output, whatever a detail string contains. */
export function secretsOf(s: PreflightSettings): string[] {
  const values = [s.agent.apiKey, s.database.url, s.database.password, s.database.host];
  if (s.database.url) {
    try {
      const url = new URL(s.database.url);
      values.push(decodeURIComponent(url.password), url.hostname, url.host);
    } catch { /* An unparseable URL is still redacted whole above. */ }
  }
  return values.filter((v): v is string => typeof v === 'string' && v.length >= 4);
}

export function formatLine(c: Check, secrets: string[] = []): string {
  let detail = c.detail.replace(/[\r\n\t]+/g, ' ');
  // Longest first, so a password inside a URL cannot leave half the URL behind.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) detail = detail.split(secret).join('[redacted]');
  return `${c.status}  ${c.name.padEnd(24)}  ${detail}`.trimEnd();
}

export function exitCode(checks: Check[]): number {
  return checks.some(c => c.status === 'FAIL') ? 1 : 0;
}

export function formatReport(checks: Check[], secrets: string[] = []): string {
  const tally = (status: Status) => checks.filter(c => c.status === status).length;
  const lines = checks.map(c => formatLine(c, secrets));
  const summary = `${tally('PASS')} PASS, ${tally('WARN')} WARN, ${tally('FAIL')} FAIL, ${tally('SKIP')} SKIP`;
  lines.push('', exitCode(checks) === 0 ? `Preflight passed: ${summary}` : `Preflight FAILED: ${summary}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Configuration

export function configChecks(s: PreflightSettings): Check[] {
  const checks: Check[] = [];
  checks.push(s.nodeEnv === 'production'
    ? check('PASS', 'config.node_env', 'production')
    : check('WARN', 'config.node_env', 'not production (database SSL is off; expected only off Render)'));
  checks.push(check('PASS', 'config.agent_enabled', s.agent.enabled ? 'true' : 'false (agent routes and maintenance off)'));
  const hasKey = Boolean(s.agent.apiKey);
  if (hasKey) checks.push(check('PASS', 'config.deepseek_key', 'present: yes'));
  else if (s.agent.enabled) checks.push(check('WARN', 'config.deepseek_key', 'present: no (history, edits, confirm and undo work; new turns unavailable)'));
  else checks.push(check('PASS', 'config.deepseek_key', 'present: no (not needed while disabled)'));
  // The model id is printed only when it is a plain identifier, never raw env text.
  const model = s.agent.model;
  if (model === DEFAULT_MODEL) checks.push(check('PASS', 'config.deepseek_model', `default (${DEFAULT_MODEL})`));
  else if (/^[A-Za-z0-9._:-]{1,64}$/.test(model)) checks.push(check('WARN', 'config.deepseek_model', `override: ${model} (only ${DEFAULT_MODEL} has acceptance coverage)`));
  else checks.push(check('FAIL', 'config.deepseek_model', 'override set but not a plain model id'));
  const a = s.agent;
  // tool_calls and draft rows are bounded by CHECK constraints in migration 013.
  const problems = [
    a.timeoutMs >= 10_000 && a.timeoutMs <= 120_000 ? null : 'timeout outside 10-120 s',
    a.maxToolCalls >= 1 && a.maxToolCalls <= 8 ? null : 'tool calls outside 1-8 (agent_runs check)',
    a.maxRows >= 1 && a.maxRows <= 12 ? null : 'draft rows outside 1-12 (agent_drafts check)',
    a.maxOutputTokens > 0 && a.maxOutputTokens <= a.maxTotalTokens ? null : 'output tokens exceed total budget',
  ].filter((p): p is string => p !== null);
  checks.push(problems.length === 0
    ? check('PASS', 'config.limits', `run ${a.timeoutMs / 1000} s, ${a.maxToolCalls} tool calls, ${a.maxRows} rows, ${a.maxTotalTokens} tokens (request timeout must exceed ${a.timeoutMs / 1000} s)`)
    : check('FAIL', 'config.limits', problems.join('; ')));
  return checks;
}

// ---------------------------------------------------------------------------
// Database

export interface Db { query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }

/** What the catalog says, gathered read-only; `classifyDatabase` turns it into checks. */
export interface DbFacts {
  versionNum: number;
  schemas: string[];
  tables: Set<string>;
  constraints: Map<string, string>;
  sourceColumn: boolean;
  incompatibleSources: number | null;
  legacyCounts: Partial<Record<(typeof LEGACY_TABLES)[number], number>>;
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Runs inside the caller's READ ONLY transaction. Only catalog reads and counts. */
export async function gatherFacts(db: Db, schema: string): Promise<DbFacts> {
  await db.query('SELECT set_config($1, $2, true)', ['statement_timeout', STATEMENT_TIMEOUT]);
  const server = await db.query("SELECT current_setting('server_version_num')::int AS version_num, current_schemas(false)::text[] AS schemas");
  const versionNum = Number(server.rows[0]?.version_num);
  const schemas = Array.isArray(server.rows[0]?.schemas) ? (server.rows[0]?.schemas as unknown[]).map(String) : [];
  // Everything below names the schema explicitly; this only pins it for the transaction.
  await db.query('SELECT set_config($1, $2, true)', ['search_path', quoteIdent(schema)]);
  const tableRows = await db.query(
    `SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname = ANY($2::text[])`,
    [schema, ['transactions', ...AGENT_TABLES, PROPOSALS_TABLE, ...LEGACY_TABLES]]
  );
  const tables = new Set(tableRows.rows.map(r => String(r.name)));
  const constraintRows = await db.query(
    `SELECT con.conname AS name, pg_catalog.pg_get_constraintdef(con.oid) AS definition
     FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
     WHERE n.nspname = $1 AND con.conname = ANY($2::text[])`,
    [schema, [SOURCE_CHECK, PROPOSAL_STATUS_CHECK]]
  );
  const constraints = new Map(constraintRows.rows.map(r => [String(r.name), String(r.definition)]));
  const column = await db.query(
    `SELECT 1 AS present FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'transactions' AND column_name = 'source'`,
    [schema]
  );
  const sourceColumn = column.rows.length > 0;
  let incompatibleSources: number | null = null;
  if (sourceColumn) {
    const result = await db.query(
      `SELECT count(*)::int AS n FROM ${quoteIdent(schema)}.transactions WHERE source IS NULL OR source NOT IN ('manual', 'ocr', 'ocr_llm', 'agent')`
    );
    incompatibleSources = Number(result.rows[0]?.n);
  }
  const legacyCounts: DbFacts['legacyCounts'] = {};
  for (const table of LEGACY_TABLES) {
    if (!tables.has(table)) continue;
    const result = await db.query(`SELECT count(*)::int AS n FROM ${quoteIdent(schema)}.${quoteIdent(table)}`);
    legacyCounts[table] = Number(result.rows[0]?.n);
  }
  return { versionNum, schemas, tables, constraints, sourceColumn, incompatibleSources, legacyCounts };
}

export function classifyDatabase(f: DbFacts, s: PreflightSettings): Check[] {
  const checks: Check[] = [];
  const major = Math.floor(f.versionNum / 10000);
  const minor = f.versionNum % 10000;
  checks.push(f.versionNum >= 150000
    ? check('PASS', 'db.server_version', `PostgreSQL ${major}.${minor}`)
    : check('FAIL', 'db.server_version', `PostgreSQL ${major}.${minor}; migration 013 requires 15 or later`));
  checks.push(f.schemas.includes(s.database.schema)
    ? check('PASS', 'db.search_path', `includes ${s.database.schema} (${f.schemas.length} schema(s))`)
    : check('FAIL', 'db.search_path', `does not include ${s.database.schema}; unqualified queries will fail`));

  // Migration 013.
  const present = AGENT_TABLES.filter(t => f.tables.has(t)).length;
  const sourceDef = f.constraints.get(SOURCE_CHECK);
  const allowsAgent = sourceDef !== undefined && sourceDef.includes("'agent'");
  if (present === AGENT_TABLES.length && allowsAgent) {
    checks.push(check('PASS', 'migration.013', `${present}/${AGENT_TABLES.length} agent tables; source check allows 'agent'`));
  } else {
    const detail = `${present}/${AGENT_TABLES.length} agent tables; source check allows 'agent': ${allowsAgent ? 'yes' : 'no'}; apply 013`;
    checks.push(check(s.agent.enabled ? 'FAIL' : 'WARN', 'migration.013', s.agent.enabled ? `${detail} before AGENT_ENABLED=true` : detail));
  }
  if (!f.tables.has('transactions')) checks.push(check('FAIL', 'db.transaction_sources', 'transactions table missing; run db:setup first'));
  else if (!f.sourceColumn || f.incompatibleSources === null) checks.push(check('FAIL', 'db.transaction_sources', 'transactions.source missing; apply migration 011 first'));
  else if (f.incompatibleSources === 0) checks.push(check('PASS', 'db.transaction_sources', '0 incompatible source values'));
  else checks.push(check('FAIL', 'db.transaction_sources', `${f.incompatibleSources} incompatible source value(s); 013 will abort, review before rewriting`));

  // Migration 014.
  const legacy = LEGACY_TABLES.filter(t => f.tables.has(t));
  if (legacy.length === 0) checks.push(check('PASS', 'migration.014', 'watchlist and ai_plans dropped'));
  else {
    const counts = legacy.map(t => `${t} ${f.legacyCounts[t] ?? '?'} row(s)`).join(', ');
    checks.push(check('WARN', 'migration.014', `${counts}; apply 014 after deploying the new frontend and backend`));
  }

  // Migration 015.
  if (!f.tables.has(PROPOSALS_TABLE)) {
    checks.push(check('WARN', 'migration.015', `goal proposals unavailable until 015${present < AGENT_TABLES.length ? ' (apply 013 first)' : ''}`));
  } else if (!(f.constraints.get(PROPOSAL_STATUS_CHECK) ?? '').includes("'expired'")) {
    checks.push(check('WARN', 'migration.015', "agent_goal_proposals status check lacks 'expired'; re-apply 015"));
  } else {
    checks.push(check('PASS', 'migration.015', "agent_goal_proposals present; status check includes 'expired'"));
  }
  return checks;
}

const DATABASE_CHECKS = ['db.server_version', 'db.search_path', 'migration.013', 'db.transaction_sources', 'migration.014', 'migration.015'];
export const skippedDatabase = (reason: string): Check[] => DATABASE_CHECKS.map(name => check('SKIP', name, reason));

/** Connects with the app's own pool settings, reads facts in a rolled-back READ ONLY transaction. */
async function databaseChecks(s: PreflightSettings): Promise<Check[]> {
  if (!s.database.url && !s.database.host) return [check('FAIL', 'db.reachable', 'no DATABASE_URL or DB_HOST configured'), ...skippedDatabase('no database configured')];
  const pool = getPool();
  let timer: NodeJS.Timeout | undefined;
  let client: PoolClient;
  try {
    client = await Promise.race<PoolClient>([
      pool.connect(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('connect timeout'), { name: 'Timeout', code: 'ETIMEDOUT' })), CONNECT_TIMEOUT_MS); }),
    ]);
  } catch (error) {
    return [check('FAIL', 'db.reachable', `unreachable (${describeError(error)})`), ...skippedDatabase('database unreachable')];
  } finally {
    clearTimeout(timer);
  }
  try {
    await client.query('BEGIN READ ONLY');
    const facts = await gatherFacts(client, s.database.schema);
    return [check('PASS', 'db.reachable', 'connected (read-only transaction)'), ...classifyDatabase(facts, s)];
  } catch (error) {
    return [check('PASS', 'db.reachable', 'connected'), check('FAIL', 'db.catalog', `catalog query failed (${describeError(error)})`), ...skippedDatabase('catalog unreadable')];
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Host

/**
 * The HTTP client Pocky's runtime uses. It is imported lazily on the first turn,
 * so a missing package would otherwise surface only as agent_provider_error.
 */
export function directClientCheck(resolve: (id: string) => string = require.resolve): Check {
  try {
    resolve('@anthropic-ai/sdk');
    return check('PASS', 'host.direct_client', '@anthropic-ai/sdk installed');
  } catch (error) {
    return check('FAIL', 'host.direct_client', `@anthropic-ai/sdk not installed (${describeError(error)}); every turn would fail`);
  }
}

function hostChecks(): Check[] {
  return [
    check('PASS', 'host.platform', `${process.platform}-${process.arch}, Node ${process.versions.node}`),
    directClientCheck(),
  ];
}

// ---------------------------------------------------------------------------
// Network

async function networkCheck(s: PreflightSettings): Promise<Check> {
  const started = Date.now();
  try {
    // No key, no body: any HTTP status proves DNS, TLS and egress.
    const response = await fetch(PROVIDER_URL, { method: 'GET', signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS), redirect: 'manual' });
    await response.body?.cancel();
    return check('PASS', 'network.deepseek', `reachable (HTTP ${response.status} in ${Date.now() - started} ms)`);
  } catch (error) {
    const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
    return check(hostProblem(s), 'network.deepseek', `unreachable within ${NETWORK_TIMEOUT_MS / 1000} s (${describeError(cause)})`);
  }
}

// ---------------------------------------------------------------------------
// Live turn (opt-in)

/** Fictional, in-memory records: the live turn touches no database. */
export const fakeRecords: AgentRecords = {
  spendingSummary: async () => ({ income: '0.00', expenses: '0.00', net: '0.00', categories: [] }),
  compareSpending: async () => ({ a: { income: '0.00', expenses: '0.00' }, b: { income: '0.00', expenses: '0.00' }, categories: [] }),
  transactionDetails: async () => ({ rows: [], next_cursor: null }),
  spendingBaseline: async () => ({ months_with_data: 0, income: '0.00', expenses: '0.00', net: '0.00', categories: [] }),
  listGoals: async () => ({ goals: [] }),
  calculateScenario: async () => ({ status: 'incomplete', missing: ['starting_cash'] }),
  prepareGoalProposal: async () => { throw new AgentError('agent_unavailable', 503); },
};

async function liveCheck(s: PreflightSettings): Promise<Check> {
  if (!s.agent.apiKey) return check('SKIP', 'live.turn', 'no DEEPSEEK_API_KEY');
  if (!s.agent.enabled) return check('SKIP', 'live.turn', 'AGENT_ENABLED is not true; the runtime refuses turns');
  const started = Date.now();
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), LIVE_BUDGET_MS + 5_000);
  try {
    const result = await runAgent({
      content: 'I spent 12.50 CAD on lunch today',
      history: [], pendingRows: [], today: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
      currency: 'CAD', timezone: 'America/Toronto', language: 'en',
      signal: controller.signal, records: fakeRecords,
    });
    // Counts and timings only; the reply text and proposed rows are never printed.
    const rows = Array.isArray(result.proposedRows) ? result.proposedRows.length : 0;
    const detail = `${result.toolCalls} tool call(s), ${rows} row(s) proposed, ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens, ${Date.now() - started} ms`;
    return check(rows === 1 ? 'PASS' : 'WARN', 'live.turn', rows === 1 ? detail : `${detail}; expected one proposed row`);
  } catch (error) {
    const code = error instanceof AgentError ? error.code : errorSummary(error).error;
    return check('FAIL', 'live.turn', `${code} after ${Date.now() - started} ms`);
  } finally {
    clearTimeout(budget);
  }
}

// ---------------------------------------------------------------------------

export async function runPreflight(s: PreflightSettings, options: { live: boolean }): Promise<Check[]> {
  const checks = configChecks(s);
  checks.push(...await databaseChecks(s));
  checks.push(...hostChecks());
  checks.push(await networkCheck(s));
  checks.push(options.live ? await liveCheck(s) : check('SKIP', 'live.turn', 'pass --live to run one fictional turn'));
  return checks;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const unknown = args.filter(a => a !== '--live');
  if (unknown.length > 0) {
    console.error('usage: npm run agent:preflight [-- --live]');
    process.exit(2);
  }
  const settings: PreflightSettings = { nodeEnv: config.nodeEnv, database: config.database, agent: config.agent };
  const secrets = secretsOf(settings);
  runPreflight(settings, { live: args.includes('--live') })
    .then(checks => ({ text: formatReport(checks, secrets), code: exitCode(checks) }))
    .catch((error: unknown) => ({ text: formatLine(check('FAIL', 'preflight', `crashed (${describeError(error)})`), secrets), code: 1 }))
    // Exit once the report is flushed: a connect that timed out may still be pending in the pool.
    .then(({ text, code }) => { process.stdout.write(`${text}\n`, () => process.exit(code)); });
}
