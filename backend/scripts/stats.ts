import config = require('../config');
import type { PoolClient } from 'pg';
import { getPool } from '../db/connection';
import { errorSummary } from '../utils/errorSummary';

/**
 * Usage totals for the owner, run in Render's shell:
 *
 *   npm run stats
 *
 * Prints counts and averages only: never an address, a name, a description,
 * an amount, message or memory text, or any row. Every statement is a SELECT
 * of aggregates inside one READ ONLY transaction with a short
 * statement_timeout, rolled back at the end. The demo account (shared by
 * every visitor) is left out of every figure.
 *
 * Windows are the last 7 and 30 days by the database clock. Some history is
 * not kept, so some figures have no all-time column: unverified accounts are
 * deleted within a day, and Pocky's runs and receipts after 30 days.
 * Activity means recording something (a transaction, a Pocky turn, a goal);
 * logins are not recorded.
 */

export interface Db { query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }

/** One figure over the last 7 days, the last 30 days and all time; null where not kept. */
export interface Windowed { d7: number | null; d30: number | null; all: number | null }

export interface Stats {
  signups: Windowed;
  verified: Windowed;
  activeAccounts: Windowed;
  transactions: Windowed;
  bySource: { manual: Windowed; screenshot: Windowed; pocky: Windowed };
  goals: Windowed;
  /** Null when the agent tables (migration 013) are absent. */
  pocky: null | {
    turns: Windowed;
    users: Windowed;
    complete: Windowed;
    failed: Windowed;
    limitHits: Windowed;
    avgInputTokens: Windowed;
    avgOutputTokens: Windowed;
    saves: Windowed;
    undone: Windowed;
  };
  memories: null | { facts: number; users: number };
  activeAccessTokens: number;
  autoDeleteOn: number | null;
}

const STATEMENT_TIMEOUT = '5s';
const CONNECT_TIMEOUT_MS = 10_000;
const W7 = "now() - interval '7 days'";
const W30 = "now() - interval '30 days'";
/** Joined into every user-scoped query, so the demo account never counts. */
const NOT_DEMO = 'JOIN users u ON u.id = x.user_id AND NOT u.is_demo';

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const avg = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(num(v)));
const windowed = (row: Record<string, unknown> | undefined, prefix: string, all = true): Windowed =>
  ({ d7: num(row?.[`${prefix}_7`]), d30: num(row?.[`${prefix}_30`]), all: all ? num(row?.[`${prefix}_all`]) : null });
/** `count(*) FILTER (...)` for both windows and, unless `all` is false, without one. */
const counts = (name: string, column: string, where = 'TRUE', all = true) => [
  `count(*) FILTER (WHERE (${where}) AND x.${column} >= ${W7}) AS ${name}_7`,
  `count(*) FILTER (WHERE (${where}) AND x.${column} >= ${W30}) AS ${name}_30`,
  ...(all ? [`count(*) FILTER (WHERE ${where}) AS ${name}_all`] : []),
].join(', ');

/** Runs inside the caller's READ ONLY transaction. Aggregates only. */
export async function gatherStats(db: Db, schema: string): Promise<Stats> {
  await db.query('SELECT set_config($1, $2, true)', ['statement_timeout', STATEMENT_TIMEOUT]);
  await db.query('SELECT set_config($1, $2, true)', ['search_path', quoteIdent(schema)]);
  const tableRows = await db.query(
    `SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname = ANY($2::text[])`,
    [schema, ['agent_runs', 'agent_receipts', 'agent_memories']]
  );
  const tables = new Set(tableRows.rows.map(r => String(r.name)));
  const columnRows = await db.query(
    `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
     WHERE table_schema = $1 AND (table_name, column_name) IN (('users', 'transaction_retention_terms'), ('access_tokens', 'expires_at'))`,
    [schema]
  );
  const columns = new Set(columnRows.rows.map(r => String(r.name)));

  const users = (await db.query(
    `SELECT ${counts('signups', 'created_at')}, ${counts('verified', 'created_at', 'x.email_verified')}
       ${columns.has('users.transaction_retention_terms') ? ', count(*) FILTER (WHERE x.transaction_retention_terms IS NOT NULL) AS auto_delete' : ''}
     FROM users x WHERE NOT x.is_demo`
  )).rows[0];

  const tx = (await db.query(
    `SELECT ${counts('added', 'created_at')},
       ${counts('manual', 'created_at', "x.source = 'manual'", false)},
       ${counts('screenshot', 'created_at', "x.source IN ('ocr', 'ocr_llm')", false)},
       ${counts('pocky', 'created_at', "x.source = 'agent'", false)}
     FROM transactions x ${NOT_DEMO}`
  )).rows[0];

  const goals = (await db.query(`SELECT ${counts('goals', 'created_at')} FROM savings_goals x ${NOT_DEMO}`)).rows[0];

  // An account is active in a window if it recorded anything in it.
  const activity = ['SELECT x.user_id, x.created_at FROM transactions x', 'SELECT x.user_id, x.created_at FROM savings_goals x'];
  if (tables.has('agent_runs')) activity.push('SELECT x.user_id, x.created_at FROM agent_runs x');
  const active = (await db.query(
    `SELECT count(DISTINCT x.user_id) FILTER (WHERE x.created_at >= ${W7}) AS active_7,
            count(DISTINCT x.user_id) FILTER (WHERE x.created_at >= ${W30}) AS active_30
     FROM (${activity.join(' UNION ALL ')}) x ${NOT_DEMO}`
  )).rows[0];

  let pocky: Stats['pocky'] = null;
  if (tables.has('agent_runs')) {
    const runs = (await db.query(
      `SELECT ${counts('turns', 'created_at', 'TRUE', false)},
         count(DISTINCT x.user_id) FILTER (WHERE x.created_at >= ${W7}) AS users_7,
         count(DISTINCT x.user_id) FILTER (WHERE x.created_at >= ${W30}) AS users_30,
         ${counts('complete', 'created_at', "x.status = 'complete'", false)},
         ${counts('failed', 'created_at', "x.status = 'failed'", false)},
         ${counts('limits', 'created_at', "x.error_code = 'agent_limit_exceeded'", false)},
         avg(x.input_tokens) FILTER (WHERE x.status = 'complete' AND x.created_at >= ${W7}) AS input_7,
         avg(x.input_tokens) FILTER (WHERE x.status = 'complete' AND x.created_at >= ${W30}) AS input_30,
         avg(x.output_tokens) FILTER (WHERE x.status = 'complete' AND x.created_at >= ${W7}) AS output_7,
         avg(x.output_tokens) FILTER (WHERE x.status = 'complete' AND x.created_at >= ${W30}) AS output_30
       FROM agent_runs x ${NOT_DEMO}`
    )).rows[0];
    const receipts = tables.has('agent_receipts') ? (await db.query(
      `SELECT ${counts('saves', 'created_at', 'TRUE', false)}, ${counts('undone', 'created_at', 'x.undone_at IS NOT NULL', false)}
       FROM agent_receipts x ${NOT_DEMO}`
    )).rows[0] : undefined;
    pocky = {
      turns: windowed(runs, 'turns', false),
      users: windowed(runs, 'users', false),
      complete: windowed(runs, 'complete', false),
      failed: windowed(runs, 'failed', false),
      limitHits: windowed(runs, 'limits', false),
      avgInputTokens: { d7: avg(runs?.input_7), d30: avg(runs?.input_30), all: null },
      avgOutputTokens: { d7: avg(runs?.output_7), d30: avg(runs?.output_30), all: null },
      saves: receipts ? windowed(receipts, 'saves', false) : { d7: null, d30: null, all: null },
      undone: receipts ? windowed(receipts, 'undone', false) : { d7: null, d30: null, all: null },
    };
  }

  let memories: Stats['memories'] = null;
  if (tables.has('agent_memories')) {
    const m = (await db.query(`SELECT count(*) AS facts, count(DISTINCT x.user_id) AS users FROM agent_memories x ${NOT_DEMO}`)).rows[0];
    memories = { facts: num(m?.facts), users: num(m?.users) };
  }

  // Before migration 023 a token has no expires_at and never expires.
  const live = columns.has('access_tokens.expires_at')
    ? `AND COALESCE(x.expires_at, x.created_at + make_interval(days => ${Number(config.accessTokens.ttlDays)})) > now()` : '';
  const tokens = (await db.query(`SELECT count(*) AS active FROM access_tokens x ${NOT_DEMO} WHERE x.revoked_at IS NULL ${live}`)).rows[0];

  return {
    signups: windowed(users, 'signups'),
    verified: windowed(users, 'verified'),
    activeAccounts: { d7: num(active?.active_7), d30: num(active?.active_30), all: null },
    transactions: windowed(tx, 'added'),
    bySource: { manual: windowed(tx, 'manual', false), screenshot: windowed(tx, 'screenshot', false), pocky: windowed(tx, 'pocky', false) },
    goals: windowed(goals, 'goals'),
    pocky,
    memories,
    activeAccessTokens: num(tokens?.active),
    autoDeleteOn: columns.has('users.transaction_retention_terms') ? num(users?.auto_delete) : null,
  };
}

// ---------------------------------------------------------------------------
// Output

const cell = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-US'));
const percent = (part: number | null, whole: number | null) => (part === null || !whole ? '—' : `${Math.round((part / whole) * 100)}%`);
const row = (label: string, w: Windowed) => `  ${label.padEnd(30)}${cell(w.d7).padStart(9)}${cell(w.d30).padStart(9)}${cell(w.all).padStart(10)}`;
const textRow = (label: string, d7: string, d30: string, all = '—') => `  ${label.padEnd(30)}${d7.padStart(9)}${d30.padStart(9)}${all.padStart(10)}`;

export function formatStats(s: Stats, today: string): string {
  const lines = [
    `TermPocket stats — ${today} (demo account excluded)`,
    `  ${''.padEnd(30)}${'7 days'.padStart(9)}${'30 days'.padStart(9)}${'all time'.padStart(10)}`,
    '',
    'Accounts',
    row('sign-ups (kept)', s.signups),
    row('verified email', s.verified),
    row('active (recorded something)', s.activeAccounts),
    '',
    'Records',
    row('transactions added', s.transactions),
    row('  by hand', s.bySource.manual),
    row('  from screenshots', s.bySource.screenshot),
    row('  through Pocky', s.bySource.pocky),
    row('savings goals created', s.goals),
    '',
    'Pocky',
  ];
  if (s.pocky) {
    const p = s.pocky;
    lines.push(
      row('turns', p.turns),
      row('accounts using Pocky', p.users),
      row('completed', p.complete),
      row('failed', p.failed),
      row('  of which hit a limit', p.limitHits),
      textRow('completion rate', percent(p.complete.d7, p.turns.d7), percent(p.complete.d30, p.turns.d30)),
      row('avg input tokens / turn', p.avgInputTokens),
      row('avg output tokens / turn', p.avgOutputTokens),
      row('confirmed saves', p.saves),
      row('  undone', p.undone),
    );
  } else lines.push('  not available (agent tables absent)');
  lines.push(
    textRow('saved memories', '—', '—', s.memories ? cell(s.memories.facts) : 'n/a'),
    textRow('  accounts with memories', '—', '—', s.memories ? cell(s.memories.users) : 'n/a'),
    '',
    'Settings',
    textRow('active MCP access tokens', '—', '—', cell(s.activeAccessTokens)),
    textRow('automatic deletion on', '—', '—', s.autoDeleteOn === null ? 'n/a' : cell(s.autoDeleteOn)),
    '',
    'Input tokens include prompt-cache reads; see the Anthropic Console for cost.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

/** Connects with the app's pool settings and reads the totals in a rolled-back READ ONLY transaction. */
export async function runStats(schema: string): Promise<string> {
  const pool = getPool();
  let timer: NodeJS.Timeout | undefined;
  let client: PoolClient;
  try {
    client = await Promise.race<PoolClient>([
      pool.connect(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('connect timeout'), { name: 'Timeout', code: 'ETIMEDOUT' })), CONNECT_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  try {
    await client.query('BEGIN READ ONLY');
    const stats = await gatherStats(client, schema);
    const today = String((await client.query('SELECT current_date::text AS today')).rows[0]?.today ?? '');
    return formatStats(stats, today);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

if (require.main === module) {
  if (process.argv.length > 2) {
    console.error('usage: npm run stats');
    process.exit(2);
  }
  runStats(config.database.schema)
    .then(text => ({ text, code: 0 }))
    // The error's name and code only: a pg message can quote a row.
    .catch((error: unknown) => {
      const { error: name, code } = errorSummary(error);
      return { text: `stats failed (${code ? `${name} ${code}` : name})`, code: 1 };
    })
    .then(({ text, code }) => { process.stdout.write(`${text}\n`, () => process.exit(code)); });
}
