import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import config = require('../config');
import db = require('../db/connection');
import exchangeRateService = require('../services/exchangeRateService');
import { packageRoot } from '../utils/packageRoot';
import { errorSummary } from '../utils/errorSummary';
import { runAgent, type AgentInput, type AgentResult, type RecalledFact } from '../services/agent/runtime';
import { recordsFor } from '../services/agent/investigation';
import { GOAL_VERSION_SQL, validateGoalFields } from '../services/agent/planning';
import { prepareMemoryProposal, validateMemoryFields } from '../services/agent/memory';
import { AgentError, type AgentRecords, type DraftRow, type GoalFields, type MemoryCadence, type MemoryKind, type MemoryProposal } from '../services/agent/types';
import { categories, currencies, decimalCents, formatCents, validateDay, validateRows, validateSettings } from '../services/agent/validation';

/**
 * A repeatable evaluation of Pocky (conversation recording, investigation and
 * planning): each case in eval/agent-cases.json is one turn through the REAL
 * runtime and model, scored against expectations written as data.
 *
 *   npm run agent:eval                          # every case once
 *   npm run agent:eval -- --case en-record-single --repeat 3
 *   npm run agent:eval -- --json --min-pass 0.9
 *
 * Records come from eval/agent-fixture.json, a fictional student, through the
 * real record tools (recordsFor) with `db.query` and `getExchangeRate`
 * replaced in this process by in-memory versions: no database is opened and
 * any query the fixture does not recognise throws. The only network traffic
 * is the runtime's own request to the Claude API.
 *
 * Output: one line per run, then a summary. A reply excerpt (at most 200
 * characters) is printed only beside an expectation it failed. The API key is
 * never printed. Exit 0 when everything passed (or the pass rate reached
 * --min-pass), 1 otherwise, 2 for bad arguments, an invalid case file, or a
 * missing AGENT_ENABLED=true / CLAUDE_API_KEY.
 */

export const TOOL_NAMES = ['propose_transactions', 'spending_summary', 'compare_spending', 'transaction_details', 'spending_baseline', 'list_goals', 'calculate_scenario', 'propose_goal', 'propose_memory'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
const EXCERPT_CHARS = 200;
const MAX_REPEAT = 20;

// ---------------------------------------------------------------------------
// Case file

export interface ExpectedRow { id?: string; type?: 'expense' | 'income'; amount?: string; currency?: string; category?: string | string[]; date?: string }
/**
 * One argument condition: min for numbers, notBefore for day strings, and
 * monthlyExpensesMin for calculate_scenario's events (see monthlyExpenses);
 * an absent argument fails unless optional.
 */
export interface ArgCondition { min?: number; notBefore?: string; monthlyExpensesMin?: number; optional?: true }
/** A tool call whose arguments (as the handler received them) meet every condition. */
export interface CallMatcher { tool: ToolName; args?: Record<string, ArgCondition> }
export interface Expectations {
  /** anyOf: at least one successful call matches one matcher. everyCall: every call to a named tool meets its matcher. */
  tools?: { include?: ToolName[]; exclude?: ToolName[]; anyOf?: CallMatcher[]; everyCall?: CallMatcher[] };
  maxToolCalls?: number;
  /** The pending batch after the turn: proposedRows when the model proposed, otherwise the pendingRows it started with. */
  draft?: { count?: number; newRows?: number; unchanged?: boolean; rows?: ExpectedRow[] };
  /** null: no goal proposal may be produced. */
  goalProposal?: null | { action: 'create' | 'update'; goal_id?: number | null; after?: Partial<GoalFields> };
  /**
   * null: no memory proposal may be produced. ref names the case's own fact
   * (m1 is the first of `memories`), which the proposal's memory_id must be.
   * optional: no proposal also passes, but one that is produced must match.
   */
  memoryProposal?: null | { action: 'remember' | 'update' | 'forget'; kind?: MemoryKind; ref?: string; amount?: string | null; optional?: true };
  reply?: { mustContain?: string[]; mustContainAny?: string[][]; mustNotContain?: string[]; mustMatch?: string[]; mustNotMatch?: string[] };
}
/** A remembered fact as a case states it; the harness gives it a fictional id and version. */
export interface EvalMemory { kind: MemoryKind; text: string; amount?: string; currency?: string; cadence?: MemoryCadence; saved_on: string }
/** The conversation's latest memory offer as the prompt sees it. */
export interface EvalMemoryProposal { action: MemoryProposal['action']; kind: MemoryKind; status: MemoryProposal['status']; text?: string }
export interface EvalCase {
  id: string;
  language: 'en' | 'zh' | 'auto';
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  pendingRows?: DraftRow[];
  today?: string;
  timezone?: string;
  currency?: string;
  /** 'voice' runs the case as a dictated message (context.input = "dictated"); absent means typed. */
  input?: 'voice';
  /** Facts the user has saved, oldest first (m1 first). Absent means memory is available and empty. */
  memories?: EvalMemory[];
  memoryProposal?: EvalMemoryProposal;
  expect: Expectations;
}
export interface CaseFile { defaults: { today: string; timezone: string; currency: string }; cases: EvalCase[] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string' && s.length > 0);
const unknownKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).filter(k => !keys.includes(k));
function validCondition(c: unknown): boolean {
  if (!isObject(c) || unknownKeys(c, ['min', 'notBefore', 'monthlyExpensesMin', 'optional']).length || (c.min === undefined && c.notBefore === undefined && c.monthlyExpensesMin === undefined)) return false;
  for (const k of ['min', 'monthlyExpensesMin'] as const) if (c[k] !== undefined && (typeof c[k] !== 'number' || !Number.isFinite(c[k]))) return false;
  if (c.notBefore !== undefined) { try { if (typeof c.notBefore !== 'string') return false; validateDay(c.notBefore); } catch { return false; } }
  return c.optional === undefined || c.optional === true;
}
function validMatcher(m: unknown): boolean {
  if (!isObject(m) || unknownKeys(m, ['tool', 'args']).length || !(TOOL_NAMES as readonly unknown[]).includes(m.tool)) return false;
  return m.args === undefined || (isObject(m.args) && Object.values(m.args).every(validCondition));
}

function checkRow(row: unknown, where: string, problems: string[]): void {
  if (!isObject(row)) { problems.push(`${where}: not an object`); return; }
  for (const k of unknownKeys(row, ['id', 'type', 'amount', 'currency', 'category', 'date'])) problems.push(`${where}: unknown key ${k}`);
  if (row.type !== undefined && row.type !== 'expense' && row.type !== 'income') problems.push(`${where}: type`);
  if (row.amount !== undefined && (typeof row.amount !== 'string' || !/^\d{1,8}\.\d{2}$/.test(row.amount))) problems.push(`${where}: amount must be a two-decimal string`);
  if (row.currency !== undefined && (typeof row.currency !== 'string' || !currencies.includes(row.currency))) problems.push(`${where}: currency`);
  const allCategories = [...categories.income, ...categories.expense];
  const cats = typeof row.category === 'string' ? [row.category] : row.category;
  if (cats !== undefined && (!isStringArray(cats) || cats.some(c => !allCategories.includes(c)))) problems.push(`${where}: category`);
  if (row.date !== undefined) { try { validateDay(row.date); } catch { problems.push(`${where}: date`); } }
  if (row.id !== undefined && typeof row.id !== 'string') problems.push(`${where}: id`);
}

const MEMORY_KINDS: MemoryKind[] = ['income', 'expense', 'reserve', 'preference', 'other'];
function validMemory(m: unknown): boolean {
  if (!isObject(m) || unknownKeys(m, ['kind', 'text', 'amount', 'currency', 'cadence', 'saved_on']).length) return false;
  try {
    const { saved_on: day, ...fields } = m;
    validateDay(day);
    const checked = validateMemoryFields(fields);
    return checked.text === m.text;
  } catch { return false; }
}
function validMemoryProposal(p: unknown): boolean {
  if (!isObject(p) || unknownKeys(p, ['action', 'kind', 'status', 'text']).length) return false;
  if (!['remember', 'update', 'forget'].includes(String(p.action)) || !MEMORY_KINDS.includes(p.kind as MemoryKind)) return false;
  if (!['pending', 'confirmed', 'cancelled', 'expired', 'conflict'].includes(String(p.status))) return false;
  // Only a pending or confirmed offer still holds its text (docs/MEMORY.md).
  if (p.text !== undefined && (typeof p.text !== 'string' || !p.text.trim() || (p.status !== 'pending' && p.status !== 'confirmed'))) return false;
  return true;
}

/** Every problem in the file at once, so a broken case file is fixed in one pass. Throws listing them. */
export function validateCaseFile(raw: unknown): CaseFile {
  const problems: string[] = [];
  if (!isObject(raw) || !isObject(raw.defaults) || !Array.isArray(raw.cases)) throw new Error('case file: needs { defaults, cases[] }');
  const { today, timezone, currency } = raw.defaults;
  try { validateDay(today); validateSettings({ currency, timezone, language: 'en' }); } catch { problems.push('defaults: today, timezone or currency invalid'); }
  const ids = new Set<string>();
  raw.cases.forEach((c: unknown, index: number) => {
    const at = isObject(c) && typeof c.id === 'string' ? c.id : `#${index}`;
    if (!isObject(c)) { problems.push(`${at}: not an object`); return; }
    for (const k of unknownKeys(c, ['id', 'language', 'message', 'history', 'pendingRows', 'today', 'timezone', 'currency', 'input', 'memories', 'memoryProposal', 'expect', 'note'])) problems.push(`${at}: unknown key ${k}`);
    if (c.memories !== undefined) {
      if (!Array.isArray(c.memories) || c.memories.length > config.agent.maxMemories) problems.push(`${at}: memories must be an array of at most ${config.agent.maxMemories}`);
      else c.memories.forEach((m: unknown, i: number) => { if (!validMemory(m)) problems.push(`${at}: memories[${i}]`); });
    }
    if (c.memoryProposal !== undefined && !validMemoryProposal(c.memoryProposal)) problems.push(`${at}: memoryProposal`);
    if (c.input !== undefined && c.input !== 'voice') problems.push(`${at}: input must be "voice" when set`);
    if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.id)) problems.push(`${at}: id must be lowercase kebab-case`);
    else if (ids.has(c.id)) problems.push(`${at}: duplicate id`);
    else ids.add(c.id);
    if (c.language !== 'en' && c.language !== 'zh' && c.language !== 'auto') problems.push(`${at}: language`);
    if (typeof c.message !== 'string' || !c.message.trim() || c.message.length > config.agent.maxInputChars) problems.push(`${at}: message`);
    if (c.history !== undefined && (!Array.isArray(c.history) || c.history.some(m => !isObject(m) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string'))) problems.push(`${at}: history`);
    if (c.pendingRows !== undefined) { try { validateRows(c.pendingRows, true); } catch { problems.push(`${at}: pendingRows fail the runtime's row validation`); } }
    try {
      validateSettings({ currency: c.currency ?? currency, timezone: c.timezone ?? timezone, language: 'en' });
      if (c.today !== undefined) validateDay(c.today);
    } catch { problems.push(`${at}: today, timezone or currency override invalid`); }
    const e = c.expect;
    if (!isObject(e)) { problems.push(`${at}: expect`); return; }
    for (const k of unknownKeys(e, ['tools', 'maxToolCalls', 'draft', 'goalProposal', 'memoryProposal', 'reply'])) problems.push(`${at}: unknown expectation ${k}`);
    if (e.memoryProposal !== undefined && e.memoryProposal !== null) {
      const m = e.memoryProposal;
      const facts = Array.isArray(c.memories) ? c.memories.length : 0;
      if (!isObject(m) || !['remember', 'update', 'forget'].includes(String(m.action))) problems.push(`${at}: memoryProposal.action`);
      else {
        for (const k of unknownKeys(m, ['action', 'kind', 'ref', 'amount', 'optional'])) problems.push(`${at}: memoryProposal.${k}`);
        if (m.optional !== undefined && m.optional !== true) problems.push(`${at}: memoryProposal.optional can only be true`);
        if (m.kind !== undefined && !MEMORY_KINDS.includes(m.kind as MemoryKind)) problems.push(`${at}: memoryProposal.kind`);
        const ref = typeof m.ref === 'string' ? /^m([1-9]\d?)$/.exec(m.ref) : null;
        if (m.ref !== undefined && (!ref || Number(ref[1]) > facts)) problems.push(`${at}: memoryProposal.ref must name one of the case's memories`);
        if ((m.action === 'remember') === (m.ref !== undefined)) problems.push(`${at}: memoryProposal.ref is required for update and forget, and not allowed for remember`);
        if (m.amount !== undefined && m.amount !== null && (typeof m.amount !== 'string' || !/^\d{1,8}\.\d{2}$/.test(m.amount))) problems.push(`${at}: memoryProposal.amount`);
      }
    }
    if (e.tools !== undefined) {
      if (!isObject(e.tools)) problems.push(`${at}: tools`);
      else {
        for (const k of unknownKeys(e.tools, ['include', 'exclude', 'anyOf', 'everyCall'])) problems.push(`${at}: tools.${k}`);
        for (const k of ['anyOf', 'everyCall'] as const) {
          const list = e.tools[k];
          if (list !== undefined && (!Array.isArray(list) || list.length === 0 || !list.every(validMatcher))) problems.push(`${at}: tools.${k}`);
        }
        const excluded = e.tools.exclude;
        if (isStringArray(e.tools.include) && isStringArray(excluded) && e.tools.include.some(t => excluded.includes(t))) problems.push(`${at}: tools include and exclude overlap`);
        for (const list of [e.tools.include, e.tools.exclude]) {
          if (list !== undefined && (!isStringArray(list) || list.some(t => !(TOOL_NAMES as readonly string[]).includes(t)))) problems.push(`${at}: tools lists name unknown tools`);
        }
      }
    }
    if (e.maxToolCalls !== undefined && (typeof e.maxToolCalls !== 'number' || !Number.isInteger(e.maxToolCalls) || e.maxToolCalls < 0)) problems.push(`${at}: maxToolCalls`);
    if (e.draft !== undefined) {
      const d = e.draft;
      if (!isObject(d)) problems.push(`${at}: draft`);
      else {
        for (const k of unknownKeys(d, ['count', 'newRows', 'unchanged', 'rows'])) problems.push(`${at}: draft.${k}`);
        for (const k of ['count', 'newRows'] as const) if (d[k] !== undefined && (typeof d[k] !== 'number' || !Number.isInteger(d[k]) || (d[k] as number) < 0)) problems.push(`${at}: draft.${k}`);
        if (d.unchanged !== undefined && d.unchanged !== true) problems.push(`${at}: draft.unchanged can only be true`);
        if (d.rows !== undefined) {
          if (!Array.isArray(d.rows)) problems.push(`${at}: draft.rows`);
          else d.rows.forEach((r: unknown, i: number) => checkRow(r, `${at}: draft.rows[${i}]`, problems));
        }
      }
    }
    if (e.goalProposal !== undefined && e.goalProposal !== null) {
      const g = e.goalProposal;
      if (!isObject(g) || (g.action !== 'create' && g.action !== 'update')) problems.push(`${at}: goalProposal.action`);
      else {
        for (const k of unknownKeys(g, ['action', 'goal_id', 'after'])) problems.push(`${at}: goalProposal.${k}`);
        if (g.goal_id !== undefined && g.goal_id !== null && (typeof g.goal_id !== 'number' || !Number.isSafeInteger(g.goal_id) || g.goal_id < 1)) problems.push(`${at}: goalProposal.goal_id`);
        if ((g.action === 'create' && g.goal_id !== undefined && g.goal_id !== null) || (g.action === 'update' && g.goal_id === null)) problems.push(`${at}: goalProposal.goal_id disagrees with action`);
        if (g.after !== undefined) {
          if (!isObject(g.after)) problems.push(`${at}: goalProposal.after`);
          else {
            try {
              validateGoalFields({ name: 'Expected goal', target_amount: '99999999.99', current_amount: '0.00', currency: 'CAD', target_date: null, description: null, ...g.after }, typeof g.after.current_amount === 'string' ? g.after.current_amount : undefined);
            } catch { problems.push(`${at}: goalProposal.after`); }
          }
        }
      }
    }
    if (e.reply !== undefined) {
      const r = e.reply;
      if (!isObject(r)) problems.push(`${at}: reply`);
      else {
        for (const k of unknownKeys(r, ['mustContain', 'mustContainAny', 'mustNotContain', 'mustMatch', 'mustNotMatch'])) problems.push(`${at}: reply.${k}`);
        for (const k of ['mustContain', 'mustNotContain', 'mustMatch', 'mustNotMatch'] as const) if (r[k] !== undefined && !isStringArray(r[k])) problems.push(`${at}: reply.${k}`);
        if (r.mustContainAny !== undefined && (!Array.isArray(r.mustContainAny) || !r.mustContainAny.every(isStringArray))) problems.push(`${at}: reply.mustContainAny`);
        for (const k of ['mustMatch', 'mustNotMatch'] as const) {
          const patterns = r[k];
          if (isStringArray(patterns)) for (const p of patterns) { try { new RegExp(p, 'mi'); } catch { problems.push(`${at}: reply.${k} ${p}`); } }
        }
      }
    }
  });
  if (raw.cases.length === 0) problems.push('no cases');
  if (problems.length) throw new Error(`case file invalid:\n  ${problems.join('\n  ')}`);
  return raw as unknown as CaseFile;
}

// ---------------------------------------------------------------------------
// Fixture: the real record tools over in-memory rows

export interface FixtureTransaction { id: number; date: string; type: 'income' | 'expense'; amount: string; currency: string; category: string; description: string }
export interface FixtureGoal extends GoalFields { id: number; updated_at: string }
export interface Fixture { userId: number; rates: Record<string, number>; transactions: FixtureTransaction[]; goals: FixtureGoal[] }

/** Reject malformed fixtures before any paid model turn. These files contain fictional data only. */
export function validateFixture(raw: unknown): Fixture {
  const invalid = (): never => { throw new Error('eval fixture invalid'); };
  if (!isObject(raw) || !Number.isSafeInteger(raw.userId) || Number(raw.userId) < 1 || !isObject(raw.rates)
    || !Array.isArray(raw.transactions) || !Array.isArray(raw.goals)) return invalid();
  for (const [pair, rate] of Object.entries(raw.rates)) {
    const parts = pair.split('->');
    if (parts.length !== 2 || parts.some(p => !currencies.includes(p)) || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) invalid();
  }
  const ids = new Set<number>();
  for (const row of raw.transactions) {
    if (!isObject(row) || typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id < 1 || ids.has(row.id)) return invalid();
    ids.add(row.id);
    try {
      validateRows([{ ...row, id: '3f1c2a9e-4b7d-4c1e-9a2f-5d6e7f8a9b0c' }], true);
    } catch { invalid(); }
  }
  ids.clear();
  for (const goal of raw.goals) {
    if (!isObject(goal) || typeof goal.id !== 'number' || !Number.isSafeInteger(goal.id) || goal.id < 1 || ids.has(goal.id)
      || typeof goal.updated_at !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(goal.updated_at)) return invalid();
    ids.add(goal.id);
    const { id: _id, updated_at: _version, ...fields } = goal;
    try { validateGoalFields(fields); } catch { invalid(); }
  }
  return raw as unknown as Fixture;
}

type Rows = { rows: Array<Record<string, unknown>>; rowCount: number };
const rowsOf = (rows: Array<Record<string, unknown>>): Rows => ({ rows, rowCount: rows.length });

/**
 * Answers exactly the statements investigation.ts and planning.ts issue, from
 * the fixture. Anything else throws, so a changed query fails loudly instead
 * of being answered wrongly, and nothing can reach a real database.
 */
const unexpectedQuery = () => Object.assign(new Error('eval fixture does not answer this query'), { name: 'EvalUnexpectedQuery', code: 'EVAL_UNEXPECTED_QUERY' });

export function fixtureQuery(f: Fixture) {
  return async (text: string, params: unknown[] = []): Promise<Rows> => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql === "SELECT to_regclass('agent_goal_proposals') IS NOT NULL AS present" && params.length === 0) return rowsOf([{ present: true }]);
    if (sql === `SELECT name, target_amount, current_amount, currency, target_date, description, ${GOAL_VERSION_SQL} AS version FROM savings_goals WHERE id = $1 AND user_id = $2` && params.length === 2) {
      const goal = f.goals.find(g => g.id === params[0] && f.userId === params[1]);
      return rowsOf(goal ? [{ ...goal, version: goal.updated_at }] : []);
    }
    if (sql === `SELECT id, name, target_amount, current_amount, currency, target_date, description, ${GOAL_VERSION_SQL} AS version FROM savings_goals WHERE user_id = $1 ORDER BY target_date NULLS LAST, id LIMIT $2` && params.length === 2) {
      const owned = params[0] === f.userId ? [...f.goals] : [];
      owned.sort((a, b) => (a.target_date ?? '9999') .localeCompare(b.target_date ?? '9999') || a.id - b.id);
      return rowsOf(owned.slice(0, Number(params[1])).map(g => ({ ...g, version: g.updated_at })));
    }
    const inWindow = f.transactions.filter(t => params[0] === f.userId && t.date >= String(params[1]) && t.date < String(params[2]));
    if (sql === 'SELECT currency, type, category, SUM(amount) AS total, COUNT(*) AS count FROM transactions WHERE user_id = $1 AND date >= $2 AND date < $3 GROUP BY currency, type, category' && params.length === 3) {
      const groups = new Map<string, { currency: string; type: string; category: string; cents: number; count: number }>();
      for (const t of inWindow) {
        const key = `${t.currency}|${t.type}|${t.category}`;
        const g = groups.get(key) ?? { currency: t.currency, type: t.type, category: t.category, cents: 0, count: 0 };
        g.cents += decimalCents(t.amount); g.count += 1;
        groups.set(key, g);
      }
      return rowsOf([...groups.values()].map(g => ({ currency: g.currency, type: g.type, category: g.category, total: formatCents(g.cents), count: String(g.count) })));
    }
    if (sql === "SELECT COUNT(DISTINCT date_trunc('month', date)) AS months FROM transactions WHERE user_id = $1 AND date >= $2 AND date < $3" && params.length === 3) {
      return rowsOf([{ months: String(new Set(inWindow.map(t => t.date.slice(0, 7))).size) }]);
    }
    if (sql.startsWith('SELECT id, date, type, amount, currency, category, description FROM transactions')) {
      const at = (pattern: RegExp): unknown[] => { const m = pattern.exec(sql); return m ? m.slice(1).map(n => params[Number(n) - 1]) : []; };
      const [category] = at(/AND category = \$(\d+)/);
      const [type] = at(/AND type = \$(\d+)/);
      const [afterDate, afterId] = at(/\(date, id\) < \(\$(\d+)::date, \$(\d+)\)/);
      const [limit] = at(/LIMIT \$(\d+)/);
      let expected = 'SELECT id, date, type, amount, currency, category, description FROM transactions WHERE user_id = $1 AND date >= $2 AND date < $3';
      let parameter = 3;
      if (category !== undefined) expected += ` AND category = $${++parameter}`;
      if (type !== undefined) expected += ` AND type = $${++parameter}`;
      if (afterDate !== undefined) { expected += ` AND (date, id) < ($${parameter + 1}::date, $${parameter + 2})`; parameter += 2; }
      expected += ` ORDER BY date DESC, id DESC LIMIT $${++parameter}`;
      if (sql !== expected || params.length !== parameter) throw unexpectedQuery();
      const rows = inWindow
        .filter(t => (category === undefined || t.category === category) && (type === undefined || t.type === type))
        .filter(t => afterDate === undefined || t.date < String(afterDate) || (t.date === afterDate && t.id < Number(afterId)))
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
        .slice(0, Number(limit));
      return rowsOf(rows.map(t => ({ ...t })));
    }
    throw unexpectedQuery();
  };
}

/** A fixed rate per direction; a pair the fixture lacks fails the way a provider outage would. */
export function fixtureRate(f: Fixture) {
  return async (from: string, to: string): Promise<number> => {
    if (from === to) return 1;
    const rate = f.rates[`${from}->${to}`];
    if (rate === undefined) throw Object.assign(new Error('eval fixture has no rate'), { name: 'EvalNoRate' });
    return rate;
  };
}

/** Points db.query and getExchangeRate at the fixture for this process; returns the undo. */
export function installFixture(f: Fixture): () => void {
  const saved = { query: db.query, getPool: db.getPool, rate: exchangeRateService.getExchangeRate };
  Object.assign(db, { query: fixtureQuery(f), getPool: () => { throw new Error('agent:eval never opens a database pool'); } });
  Object.assign(exchangeRateService, { getExchangeRate: fixtureRate(f) });
  return () => { Object.assign(db, { query: saved.query, getPool: saved.getPool }); Object.assign(exchangeRateService, { getExchangeRate: saved.rate }); };
}

/** A case's facts as the runtime receives them: fictional ids and one fixed version, m1 first. */
export const MEMORY_VERSION = '2026-10-01 12:00:00.000000';
export function evalFacts(c: Pick<EvalCase, 'memories'>): RecalledFact[] {
  return (c.memories ?? []).map((m, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, version: MEMORY_VERSION,
    kind: m.kind, text: m.text, amount: m.amount ?? null, currency: m.currency ?? null, cadence: m.cadence ?? null, saved_on: m.saved_on,
  }));
}

/**
 * The statements prepareMemoryProposal issues, answered from a case's facts;
 * anything else throws, like fixtureQuery. Nothing is ever written.
 */
export function memoryFixtureQuery(userId: number, facts: RecalledFact[]) {
  return async (text: string, params: unknown[] = []): Promise<Rows> => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql === "SELECT to_regclass('agent_memories') IS NOT NULL AS present" && params.length === 0) return rowsOf([{ present: true }]);
    if (sql === 'SELECT is_demo FROM users WHERE id=$1' && params.length === 1) return rowsOf(params[0] === userId ? [{ is_demo: false }] : []);
    if (sql === 'SELECT count(*) AS count FROM agent_memories WHERE user_id=$1' && params.length === 1) return rowsOf([{ count: String(params[0] === userId ? facts.length : 0) }]);
    if (sql === `SELECT kind,text,amount,currency,cadence,${GOAL_VERSION_SQL} AS version FROM agent_memories WHERE id=$1 AND user_id=$2` && params.length === 2) {
      const fact = params[1] === userId ? facts.find(f => f.id === params[0]) : undefined;
      return rowsOf(fact ? [{ kind: fact.kind, text: fact.text, amount: fact.amount, currency: fact.currency, cadence: fact.cadence, version: fact.version }] : []);
    }
    throw unexpectedQuery();
  };
}

/** The real record tools for a case: the fixture's records, and propose_memory over the case's facts. */
export function caseRecords(c: Pick<EvalCase, 'memories'>, fixture: Fixture): AgentRecords {
  const memoryQuery = memoryFixtureQuery(fixture.userId, evalFacts(c)) as unknown as typeof db.query;
  return { ...recordsFor(fixture.userId), prepareMemoryProposal: input => prepareMemoryProposal(fixture.userId, input, { query: memoryQuery }) };
}

export interface ToolCall { tool: ToolName; ok: boolean; fixtureError?: boolean; args?: Record<string, unknown> }
const RECORD_TOOLS: Record<keyof AgentRecords, ToolName> = {
  spendingSummary: 'spending_summary', compareSpending: 'compare_spending', transactionDetails: 'transaction_details',
  spendingBaseline: 'spending_baseline', listGoals: 'list_goals', calculateScenario: 'calculate_scenario', prepareGoalProposal: 'propose_goal',
  prepareMemoryProposal: 'propose_memory',
};

/** Records which tools reached their handler, and whether each answered or failed. */
export function trackRecords(records: AgentRecords, calls: ToolCall[]): AgentRecords {
  const tracked = {} as Record<keyof AgentRecords, unknown>;
  for (const key of Object.keys(RECORD_TOOLS) as Array<keyof AgentRecords>) {
    const fn = records[key] as (...args: unknown[]) => Promise<unknown>;
    tracked[key] = async (...args: unknown[]) => {
      const call: ToolCall = { tool: RECORD_TOOLS[key], ok: false, ...(isObject(args[0]) ? { args: args[0] } : {}) };
      calls.push(call);
      try {
        const value = await fn(...args);
        call.ok = true;
        return value;
      } catch (error) {
        if (isObject(error) && error.code === 'EVAL_UNEXPECTED_QUERY') call.fixtureError = true;
        throw error;
      }
    };
  }
  return tracked as unknown as AgentRecords;
}

export function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(packageRoot(__dirname), 'eval', name), 'utf8'));
}

// ---------------------------------------------------------------------------
// Scoring

/**
 * Lower case, U+2212 as '-', no thousands separators between digits, and no
 * trailing decimal zeros, so a figure compares by value however it is written:
 * '1,302.20', '1302.2' and '1302.20' all become '1302.2'. The record tools
 * return some totals as JSON numbers (302.2), which the model may quote as is.
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\u2212/g, '-')
    .replace(/(\d)[,\u00a0\u2009\u202f](?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d)\.(\d*?)0+(?!\d)/g, (_match, digit: string, decimals: string) => (decimals ? `${digit}.${decimals}` : digit));
}

/** Whole numeric values must match their sign too, including -$600 and −600. */
export function findNeedle(normalized: string, needle: string): number {
  const n = normalizeText(needle);
  if (!/^-?\d+(\.\d+)?$/.test(n)) return normalized.indexOf(n);
  const negative = n.startsWith('-');
  const amount = n.replace(/^-/, '');
  const pattern = new RegExp(`(?<![\\d.])${amount.replace('.', '\\.')}(?!\\d|\\.\\d)`, 'g');
  for (const match of normalized.matchAll(pattern)) {
    const sign = /-(?:[$€£¥]|(?:cad|usd|eur|gbp|aud|cny)\s*)?$/.exec(normalized.slice(0, match.index));
    if (negative === (sign !== null)) return sign?.index ?? match.index;
  }
  return -1;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
export function excerpt(text: string, around?: number): string {
  const flat = oneLine(text);
  if (flat.length <= EXCERPT_CHARS) return flat;
  if (around === undefined) return `${flat.slice(0, EXCERPT_CHARS - 1)}…`;
  const start = Math.max(0, Math.min(around - 80, flat.length - EXCERPT_CHARS + 2));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + EXCERPT_CHARS - 2)}…`;
}

export interface RunOutcome { result?: AgentResult; errorCode?: string; calls: ToolCall[] }

const rowLabel = (r: Partial<DraftRow>) => `${r.type ?? '?'} ${r.amount ?? '?'} ${r.currency ?? '?'} ${r.category ?? '?'} ${r.date ?? '?'}`;
function rowMatches(row: DraftRow, want: ExpectedRow): boolean {
  if (want.id !== undefined && row.id !== want.id.toLowerCase()) return false;
  if (want.type !== undefined && row.type !== want.type) return false;
  if (want.amount !== undefined && row.amount !== want.amount) return false;
  if (want.currency !== undefined && row.currency !== want.currency) return false;
  if (want.date !== undefined && row.date !== want.date) return false;
  if (want.category !== undefined && !(typeof want.category === 'string' ? [want.category] : want.category).includes(row.category)) return false;
  return true;
}
const sameRows = (a: DraftRow[], b: DraftRow[]) => {
  const key = (r: DraftRow) => JSON.stringify([r.id, r.amount, r.description, r.category, r.type, r.date, r.currency]);
  return a.length === b.length && a.map(key).sort().join('\n') === b.map(key).sort().join('\n');
};

/**
 * What calculate_scenario's events charge per month on a repeat: a monthly
 * expense counts once, a two_weeks one 26/12 times and a weekly one 52/12
 * times. One-off events and income do not count. Undefined when `events` is
 * not an array of events with decimal amounts.
 */
export function monthlyExpenses(events: unknown): number | undefined {
  if (!Array.isArray(events)) return undefined;
  const perMonth = { month: 1, two_weeks: 26 / 12, week: 52 / 12 } as const;
  let total = 0;
  for (const event of events) {
    if (!isObject(event) || typeof event.amount !== 'string' || !/^\d+(\.\d+)?$/.test(event.amount)) return undefined;
    const every = isObject(event.repeat) ? event.repeat.every : undefined;
    if (event.kind === 'expense' && (every === 'month' || every === 'two_weeks' || every === 'week')) total += Number(event.amount) * perMonth[every];
  }
  return Math.round(total * 100) / 100;
}

/** The first condition the call fails, as a reason, or null when it matches. */
function callMismatch(call: ToolCall, m: CallMatcher): string | null {
  if (call.tool !== m.tool) return `not ${m.tool}`;
  for (const [name, c] of Object.entries(m.args ?? {})) {
    const value = call.args?.[name];
    if (value === undefined) { if (c.optional) continue; return `${m.tool} without ${name}`; }
    if (c.min !== undefined && !(typeof value === 'number' && value >= c.min)) return `${m.tool} ${name} ${JSON.stringify(value)}, at least ${c.min} expected`;
    // A string comparison orders days correctly only because the day schema forces YYYY-MM-DD.
    if (c.notBefore !== undefined && !(typeof value === 'string' && value >= c.notBefore)) return `${m.tool} ${name} ${JSON.stringify(value)}, not before ${c.notBefore} expected`;
    if (c.monthlyExpensesMin !== undefined) {
      const monthly = monthlyExpenses(value);
      if (monthly === undefined || monthly < c.monthlyExpensesMin) return `${m.tool} ${name} repeat ${monthly ?? 'unreadable'} a month in expenses, at least ${c.monthlyExpensesMin} expected`;
    }
  }
  return null;
}

/** Every expectation the run failed, as a reason; empty means PASS. */
export function scoreRun(c: EvalCase, outcome: RunOutcome): string[] {
  if (outcome.errorCode || !outcome.result) return [`run failed: ${outcome.errorCode ?? 'no result'}`];
  const { result } = outcome;
  const e = c.expect;
  const failures: string[] = [];
  if (outcome.calls.some(call => call.fixtureError)) failures.push('fixture rejected unsupported SQL; update the fixture adapter before evaluating');

  const called = new Set<ToolName>(outcome.calls.map(call => call.tool));
  if (result.proposedRows !== undefined) called.add('propose_transactions');
  const successful = new Set<ToolName>(outcome.calls.filter(call => call.ok).map(call => call.tool));
  if (result.proposedRows !== undefined) successful.add('propose_transactions');
  const calledList = [...called].join(', ') || 'none';
  for (const tool of e.tools?.include ?? []) if (!successful.has(tool)) failures.push(`tool ${tool} did not succeed (called: ${calledList})`);
  for (const tool of e.tools?.exclude ?? []) if (called.has(tool)) failures.push(`tool ${tool} was called`);
  const anyOf = e.tools?.anyOf;
  if (anyOf && !outcome.calls.some(call => call.ok && anyOf.some(m => callMismatch(call, m) === null))) {
    const reasons = outcome.calls.flatMap(call => anyOf.filter(m => m.tool === call.tool).map(m => callMismatch(call, m) ?? (call.ok ? '' : `${m.tool} failed`))).filter(Boolean);
    failures.push(`no successful call matches any of ${anyOf.map(m => m.tool).join(', ')} (called: ${calledList}${reasons.length ? `; ${reasons.join('; ')}` : ''})`);
  }
  for (const m of e.tools?.everyCall ?? []) {
    for (const call of outcome.calls) { const why = call.tool === m.tool ? callMismatch(call, m) : null; if (why) failures.push(`call ${why}`); }
  }
  if (e.maxToolCalls !== undefined && result.toolCalls > e.maxToolCalls) failures.push(`${result.toolCalls} tool calls, at most ${e.maxToolCalls} expected (called: ${calledList})`);

  if (e.draft) {
    const pending = c.pendingRows ?? [];
    const proposed = result.proposedRows as DraftRow[] | undefined;
    const batch = proposed ?? pending;
    const pendingIds = new Set(pending.map(r => r.id.toLowerCase()));
    const describe = () => excerpt(`[${batch.map(rowLabel).join('; ')}]`);
    if (e.draft.unchanged && proposed !== undefined && !sameRows(proposed, pending)) failures.push(`pending batch changed: ${describe()}`);
    if (e.draft.count !== undefined && batch.length !== e.draft.count) failures.push(`${batch.length} draft row(s), ${e.draft.count} expected: ${describe()}`);
    const added = batch.filter(r => !pendingIds.has(r.id.toLowerCase())).length;
    if (e.draft.newRows !== undefined && added !== e.draft.newRows) failures.push(`${added} new draft row(s), ${e.draft.newRows} expected: ${describe()}`);
    const unused = [...batch];
    for (const want of e.draft.rows ?? []) {
      const index = unused.findIndex(row => rowMatches(row, want));
      if (index === -1) failures.push(`no draft row matches ${JSON.stringify(want)}: ${describe()}`);
      else unused.splice(index, 1);
    }
  }

  if (e.goalProposal === null && result.goalProposal) failures.push(`unexpected goal proposal (${result.goalProposal.action} ${result.goalProposal.after.name})`);
  if (e.goalProposal) {
    const got = result.goalProposal;
    if (!got) failures.push(`no goal proposal (expected ${e.goalProposal.action})`);
    else {
      if (got.action !== e.goalProposal.action) failures.push(`goal proposal action ${got.action}, expected ${e.goalProposal.action}`);
      if (e.goalProposal.goal_id !== undefined && got.goal_id !== e.goalProposal.goal_id) failures.push(`goal proposal goal_id ${got.goal_id}, expected ${e.goalProposal.goal_id}`);
      for (const [key, want] of Object.entries(e.goalProposal.after ?? {})) {
        const actual = got.after[key as keyof GoalFields];
        if (actual !== want) failures.push(`goal proposal after.${key} ${JSON.stringify(actual)}, expected ${JSON.stringify(want)}`);
      }
    }
  }

  if (e.memoryProposal === null && result.memoryProposal) failures.push(`unexpected memory proposal (${result.memoryProposal.action} ${result.memoryProposal.kind})`);
  if (e.memoryProposal) {
    const got = result.memoryProposal;
    const want = e.memoryProposal;
    if (!got) { if (!want.optional) failures.push(`no memory proposal (expected ${want.action})`); }
    else {
      if (got.action !== want.action) failures.push(`memory proposal action ${got.action}, expected ${want.action}`);
      if (want.kind !== undefined && got.kind !== want.kind) failures.push(`memory proposal kind ${got.kind}, expected ${want.kind}`);
      if (want.ref !== undefined) {
        const facts = evalFacts(c);
        const index = facts.findIndex(f => f.id === got.memory_id);
        if (`m${index + 1}` !== want.ref) failures.push(`memory proposal names ${index === -1 ? 'no listed fact' : `m${index + 1}`}, expected ${want.ref}`);
      }
      if (want.amount !== undefined && (got.after?.amount ?? null) !== want.amount) failures.push(`memory proposal amount ${JSON.stringify(got.after?.amount ?? null)}, expected ${JSON.stringify(want.amount)}`);
    }
  }

  if (e.reply) {
    const reply = oneLine(normalizeText(result.text));
    for (const needle of e.reply.mustContain ?? []) {
      if (findNeedle(reply, needle) === -1) failures.push(`reply lacks "${needle}": ${excerpt(result.text)}`);
    }
    for (const group of e.reply.mustContainAny ?? []) {
      if (!group.some(needle => findNeedle(reply, needle) !== -1)) failures.push(`reply has none of ${JSON.stringify(group)}: ${excerpt(result.text)}`);
    }
    for (const needle of e.reply.mustNotContain ?? []) {
      const at = findNeedle(reply, needle);
      if (at !== -1) failures.push(`reply contains "${needle}": ${excerpt(reply, at)}`);
    }
    for (const pattern of e.reply.mustMatch ?? []) {
      if (!new RegExp(pattern, 'mi').test(result.text)) failures.push(`reply does not match /${pattern}/: ${excerpt(result.text)}`);
    }
    for (const pattern of e.reply.mustNotMatch ?? []) {
      const m = new RegExp(pattern, 'mi').exec(result.text);
      if (m) failures.push(`reply matches /${pattern}/: ${excerpt(result.text, oneLine(result.text.slice(0, m.index)).length)}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Running

export type Runtime = (input: AgentInput) => Promise<AgentResult>;
export interface RunReport {
  id: string; run: number; status: 'PASS' | 'FAIL'; failures: string[];
  toolCalls: number; tools: string[]; inputTokens: number; outputTokens: number; latencyMs: number;
}

/** The prompt reads only action, kind, status and the text of a pending or confirmed offer. */
function evalProposal(p: EvalMemoryProposal): NonNullable<AgentInput['memoryProposal']> {
  const fields = p.text === undefined ? null : { kind: p.kind, text: p.text, amount: null, currency: null, cadence: null };
  return { action: p.action, kind: p.kind, status: p.status, before: p.action === 'remember' ? null : fields, after: p.action === 'forget' ? null : fields };
}

export async function runCase(c: EvalCase, file: CaseFile, fixture: Fixture, runtime: Runtime, run = 1): Promise<RunReport> {
  const calls: ToolCall[] = [];
  const started = Date.now();
  let outcome: RunOutcome;
  try {
    const result = await runtime({
      content: c.message, history: c.history ?? [], pendingRows: c.pendingRows ?? [],
      today: c.today ?? file.defaults.today, timezone: c.timezone ?? file.defaults.timezone,
      currency: c.currency ?? file.defaults.currency, language: c.language, dictated: c.input === 'voice',
      signal: new AbortController().signal, records: trackRecords(caseRecords(c, fixture), calls),
      // Memory is available in every case (022 is applied in production); a case lists the facts saved so far.
      memories: evalFacts(c), memoryProposal: c.memoryProposal ? evalProposal(c.memoryProposal) : null,
    });
    outcome = { result, calls };
  } catch (error) {
    outcome = { errorCode: error instanceof AgentError ? error.code : errorSummary(error).error, calls };
  }
  const latencyMs = Date.now() - started;
  const failures = scoreRun(c, outcome);
  const tools = [...new Set([...calls.map(call => call.tool), ...(outcome.result?.proposedRows !== undefined ? ['propose_transactions'] : [])])];
  return {
    id: c.id, run, status: failures.length ? 'FAIL' : 'PASS', failures,
    toolCalls: outcome.result?.toolCalls ?? calls.length, tools,
    inputTokens: outcome.result?.usage.inputTokens ?? 0, outputTokens: outcome.result?.usage.outputTokens ?? 0, latencyMs,
  };
}

export interface Totals { runs: number; passed: number; failed: number; passRate: number; inputTokens: number; outputTokens: number; latencyMs: number }
export function totalsOf(reports: RunReport[]): Totals {
  const passed = reports.filter(r => r.status === 'PASS').length;
  return {
    runs: reports.length, passed, failed: reports.length - passed,
    passRate: reports.length ? passed / reports.length : 0,
    inputTokens: reports.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: reports.reduce((n, r) => n + r.outputTokens, 0),
    latencyMs: reports.reduce((n, r) => n + r.latencyMs, 0),
  };
}

export function formatRun(r: RunReport, repeat: number): string {
  const name = repeat > 1 ? `${r.id}#${r.run}` : r.id;
  const head = `${r.status}  ${name.padEnd(34)}  ${(r.latencyMs / 1000).toFixed(1).padStart(5)} s  ${String(r.inputTokens).padStart(6)} in / ${String(r.outputTokens).padStart(5)} out tok  tools: ${r.tools.join(', ') || 'none'}`;
  return [head, ...r.failures.map(f => `      - ${f}`)].join('\n');
}

export function formatSummary(t: Totals): string {
  return `${t.passed}/${t.runs} passed (${(t.passRate * 100).toFixed(1)}%), ${t.failed} failed; ${t.inputTokens} in / ${t.outputTokens} out tokens; ${(t.latencyMs / 1000).toFixed(1)} s`;
}

/** Removes the key wherever it might appear, however unlikely: output is meant for terminals and CI logs. */
const redact = (text: string, secrets: Array<string | undefined>) =>
  secrets.filter((s): s is string => typeof s === 'string' && s.length >= 4).reduce((t, s) => t.split(s).join('[redacted]'), text);

export interface Options { cases: string[]; repeat: number; json: boolean; minPass?: number }
export const USAGE = 'usage: npm run agent:eval [-- [--case <id>[,<id>...]]... [--repeat N] [--min-pass 0..1] [--json]]';

export function parseArgs(argv: string[]): Options {
  const options: Options = { cases: [], repeat: 1, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined || !v.trim()) throw new Error(`${arg} needs a value`); return v; };
    if (arg === '--json') options.json = true;
    else if (arg === '--case') {
      const ids = value().split(',');
      if (ids.some(id => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))) throw new Error('--case needs comma-separated case IDs');
      options.cases.push(...ids);
    }
    else if (arg === '--repeat') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > MAX_REPEAT) throw new Error(`--repeat must be 1-${MAX_REPEAT}`);
      options.repeat = n;
    } else if (arg === '--min-pass') {
      const n = Number(value());
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error('--min-pass must be between 0 and 1');
      options.minPass = n;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

export interface MainDeps {
  agent: { enabled: boolean; apiKey?: string; model: string };
  runtime: Runtime;
  out: (line: string) => void;
  err: (line: string) => void;
  caseFile?: unknown;
  fixture?: unknown;
}

export async function main(argv: string[], deps: MainDeps): Promise<number> {
  const out = (line: string) => deps.out(redact(line, [deps.agent.apiKey]));
  const err = (line: string) => deps.err(redact(line, [deps.agent.apiKey]));
  let options: Options;
  try { options = parseArgs(argv); } catch (error) { err(`${(error as Error).message}\n${USAGE}`); return 2; }
  if (!deps.agent.enabled || !deps.agent.apiKey) {
    err('agent:eval runs real model turns: set AGENT_ENABLED=true and CLAUDE_API_KEY in the environment.');
    return 2;
  }
  let file: CaseFile;
  let fixture: Fixture;
  try {
    file = validateCaseFile(deps.caseFile ?? loadJson('agent-cases.json'));
    fixture = validateFixture(deps.fixture ?? loadJson('agent-fixture.json'));
  } catch (error) { err((error as Error).message); return 2; }
  const unknown = options.cases.filter(id => !file.cases.some(c => c.id === id));
  if (unknown.length) { err(`unknown case id(s): ${unknown.join(', ')}`); return 2; }
  const selected = options.cases.length ? file.cases.filter(c => options.cases.includes(c.id)) : file.cases;

  const model = /^[A-Za-z0-9._:-]{1,64}$/.test(deps.agent.model) ? deps.agent.model : '(custom)';
  if (!options.json) out(`Evaluating Pocky: ${selected.length} case(s) x ${options.repeat}, model ${model}, today ${file.defaults.today} ${file.defaults.timezone}`);
  const restore = installFixture(fixture);
  const reports: RunReport[] = [];
  try {
    for (const c of selected) {
      for (let run = 1; run <= options.repeat; run++) {
        const report = await runCase(c, file, fixture, deps.runtime, run);
        reports.push(report);
        if (!options.json) out(formatRun(report, options.repeat));
      }
    }
  } finally {
    restore();
  }
  const totals = totalsOf(reports);
  const passed = options.minPass === undefined ? totals.failed === 0 : totals.passRate >= options.minPass;
  if (options.json) out(JSON.stringify({ model, today: file.defaults.today, repeat: options.repeat, minPass: options.minPass ?? null, passed, totals, runs: reports }, null, 2));
  else out(`\n${passed ? 'Eval passed' : 'Eval FAILED'}: ${formatSummary(totals)}${options.minPass === undefined ? '' : ` (min pass ${(options.minPass * 100).toFixed(1)}%)`}`);
  return passed ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2), {
    agent: config.agent, runtime: runAgent,
    out: line => process.stdout.write(`${line}\n`), err: line => process.stderr.write(`${line}\n`),
  })
    .catch((error: unknown) => { process.stderr.write(`agent:eval crashed (${errorSummary(error).error})\n`); return 1; })
    .then(code => { process.stdout.write('', () => process.exit(code)); });
}
