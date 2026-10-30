import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStats, gatherStats, type Db, type Stats } from '../scripts/stats';

/** A fake database: records every statement and answers the catalog probes from `tables`/`columns`. */
function fake(tables: string[], columns: string[], answer: (sql: string) => Record<string, unknown> = () => ({})) {
  const queries: string[] = [];
  const db: Db = { query: async (text: string) => {
    queries.push(text);
    if (text.includes('pg_catalog.pg_class')) return { rows: tables.map(name => ({ name })) };
    if (text.includes('information_schema.columns')) return { rows: columns.map(name => ({ name })) };
    return { rows: [answer(text)] };
  } };
  return { db, queries };
}
const ALL_TABLES = ['agent_runs', 'agent_receipts', 'agent_memories'];
const ALL_COLUMNS = ['users.transaction_retention_terms', 'access_tokens.expires_at'];

test('stats: every statement is an aggregate SELECT that reads no personal column', async () => {
  const { db, queries } = fake(ALL_TABLES, ALL_COLUMNS);
  await gatherStats(db, 'public');
  assert.ok(queries.length >= 10);
  for (const sql of queries) {
    assert.match(sql.trimStart(), /^SELECT\b/, sql);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/i, sql);
    assert.doesNotMatch(sql, /SELECT\s+\*|\.\*/, sql);
    assert.doesNotMatch(sql, /\b[xu]\.(email|first_name|last_name|password_hash|description|amount|text|rows|name|token_hash|content|request_hash|transaction_versions)\b/, sql);
  }
});

test('stats: the demo account is excluded from every figure', async () => {
  const { db, queries } = fake(ALL_TABLES, ALL_COLUMNS);
  await gatherStats(db, 'public');
  const data = queries.filter(sql => /\bFROM\s+(users|transactions|savings_goals|agent_runs|agent_receipts|agent_memories|access_tokens|\()/.test(sql));
  assert.ok(data.length >= 7);
  for (const sql of data) assert.match(sql, /NOT [xu]\.is_demo/, sql);
});

test('stats: tables and columns missing before 013, 016, 022 and 023 are reported as unavailable, not queried', async () => {
  const { db, queries } = fake([], []);
  const s = await gatherStats(db, 'public');
  assert.equal(s.pocky, null);
  assert.equal(s.memories, null);
  assert.equal(s.autoDeleteOn, null);
  const all = queries.join('\n');
  assert.ok(!/FROM agent_runs|FROM agent_receipts|FROM agent_memories/.test(all), 'agent tables are not queried before they exist');
  assert.ok(!/x\.transaction_retention_terms/.test(all), 'the retention column is not read before 016');
  assert.ok(!/x\.expires_at/.test(all), 'a token never expires before 023');
  const text = formatStats(s, '2026-11-12');
  assert.match(text, /not available \(agent tables absent\)/);
  assert.match(text, /automatic deletion on\s+—\s+—\s+n\/a/);
});

test('stats: aggregate rows become numbers, with null and non-numeric values made safe', async () => {
  const { db } = fake(ALL_TABLES, ALL_COLUMNS, sql => {
    if (sql.includes('FROM users x')) return { signups_7: '3', signups_30: '9', signups_all: '20', verified_7: '2', verified_30: '7', verified_all: '18', auto_delete: '1' };
    if (sql.includes('FROM agent_runs x')) return { turns_7: '10', turns_30: '40', complete_7: '9', complete_30: '37', failed_7: '1', failed_30: '3', limits_7: '0', limits_30: '1', input_7: '15234.6', input_30: null, output_7: 'NaN', output_30: '350' };
    if (sql.includes('FROM agent_memories x')) return { facts: '12', users: '4' };
    return {};
  });
  const s = await gatherStats(db, 'public');
  assert.deepEqual(s.signups, { d7: 3, d30: 9, all: 20 });
  assert.deepEqual(s.pocky?.turns, { d7: 10, d30: 40, all: null });
  assert.deepEqual(s.pocky?.avgInputTokens, { d7: 15235, d30: null, all: null });
  assert.equal(s.pocky?.avgOutputTokens.d7, 0);
  assert.deepEqual(s.memories, { facts: 12, users: 4 });
  assert.equal(s.autoDeleteOn, 1);
});

test('stats: the report prints only labels and numbers', () => {
  const w = (d7: number | null, d30: number | null, all: number | null) => ({ d7, d30, all });
  const s: Stats = {
    signups: w(3, 9, 20), verified: w(2, 7, 18), activeAccounts: w(5, 11, null), transactions: w(87, 340, 1200),
    bySource: { manual: w(51, 200, null), screenshot: w(12, 60, null), pocky: w(24, 80, null) }, goals: w(1, 4, 9),
    pocky: { turns: w(64, 250, null), users: w(6, 14, null), complete: w(61, 241, null), failed: w(3, 9, null), limitHits: w(1, 2, null),
      avgInputTokens: w(15200, 14800, null), avgOutputTokens: w(350, 340, null), saves: w(20, 70, null), undone: w(1, 3, null) },
    memories: { facts: 37, users: 9 }, activeAccessTokens: 4, autoDeleteOn: 2,
  };
  const text = formatStats(s, '2026-11-12');
  assert.match(text, /^TermPocket stats — 2026-11-12 \(demo account excluded\)/);
  assert.match(text, /transactions added\s+87\s+340\s+1,200/);
  assert.match(text, /completion rate\s+95%\s+96%/);
  assert.match(text, /saved memories\s+—\s+—\s+37\n/);
  assert.match(text, /accounts with memories\s+—\s+—\s+9\n/);
  assert.match(text, /active MCP access tokens\s+—\s+—\s+4/);
  // Nothing but labels, digits and separators: no stray value could carry personal data.
  assert.doesNotMatch(text, /@/);
});
