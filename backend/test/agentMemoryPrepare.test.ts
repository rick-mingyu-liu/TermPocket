import { test } from 'node:test';
import assert from 'node:assert/strict';
import config = require('../config');
import db = require('../db/connection');
import { prepareMemoryProposal, listMemories, memoriesForTurn } from '../services/agent/memory';
import { recordsFor } from '../services/agent/investigation';

// propose_memory's server side with the database stubbed: what it validates,
// what it reads, and that it never writes. One process per file, so the first
// test sees migration 022 missing before the positive answer is cached.
const userId = 7;
const id = '00000000-0000-4000-8000-000000000001';
const version = '2026-10-23 12:00:00.123456';
const rent = { kind: 'expense', text: 'Fictional rent', amount: '950.00', currency: 'CAD', cadence: 'month' };

function stub(options: { present?: boolean; demo?: boolean; count?: number; facts?: Record<string, typeof rent & { version: string; owner: number }> } = {}) {
  const statements: string[] = [];
  const client = { query: (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    statements.push(sql);
    if (sql.includes('to_regclass')) return { rows: [{ present: options.present ?? true }], rowCount: 1 };
    if (sql === 'SELECT is_demo FROM users WHERE id=$1') return { rows: [{ is_demo: options.demo === true }], rowCount: 1 };
    if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: String(options.count ?? 0) }], rowCount: 1 };
    if (sql.startsWith('SELECT kind,text,amount,currency,cadence,')) {
      const fact = options.facts?.[String(params[0])];
      const rows = fact && fact.owner === params[1] ? [{ kind: fact.kind, text: fact.text, amount: fact.amount, currency: fact.currency, cadence: fact.cadence, version: fact.version }] : [];
      return { rows, rowCount: rows.length };
    }
    throw new Error(`unexpected statement ${sql}`);
  }) as unknown as typeof db.query };
  return { client, statements };
}
const facts = { [id]: { ...rent, version, owner: userId } };
const prepare = (input: unknown, s = stub({ facts })) => prepareMemoryProposal(userId, input, s.client);

test('before migration 022 the tool answers agent_unavailable', async () => {
  await assert.rejects(prepare({ action: 'remember', kind: 'other', text: 'Fictional' }, stub({ present: false })), { code: 'agent_unavailable', status: 503 });
});

test('remember validates the fact, normalises the amount and counts only toward the cap', async () => {
  assert.deepEqual(await prepare({ action: 'remember', kind: 'expense', text: 'Fictional rent', amount: '950', currency: 'CAD', cadence: 'month' }),
    { action: 'remember', kind: 'expense', memory_id: null, expected_updated_at: null, before: null, after: rent });
  assert.equal((await prepare({ action: 'remember', kind: 'preference', text: '把 Uber Eats 算作 Dining Out' })).after!.amount, null);
  await assert.rejects(prepare({ action: 'remember', kind: 'other', text: 'x' }, stub({ count: config.agent.maxMemories })), { code: 'agent_memory_full', status: 409 });
  assert.equal((await prepare({ action: 'remember', kind: 'other', text: 'x' }, stub({ count: config.agent.maxMemories - 1 }))).action, 'remember');
  await assert.rejects(prepare({ action: 'remember', kind: 'other', text: 'x' }, stub({ demo: true })), { code: 'agent_memory_demo', status: 403 });
});

test('invalid input is refused before any query', async () => {
  for (const input of [
    null, [], { action: 'remember' }, { action: 'remember', kind: 'other', text: '' }, { action: 'remember', kind: 'system', text: 'x' },
    { action: 'remember', kind: 'other', text: 'x'.repeat(121) }, { action: 'remember', kind: 'expense', text: 'x', amount: '950' },
    { action: 'remember', kind: 'expense', text: 'x', amount: '0', currency: 'CAD' }, { action: 'remember', kind: 'expense', text: 'x', amount: '1e3', currency: 'CAD' },
    { action: 'remember', kind: 'expense', text: 'x', cadence: 'month' }, { action: 'remember', kind: 'expense', text: 'x', amount: '9', currency: 'JPY' },
    { action: 'remember', kind: 'other', text: 'x', memory_id: id }, { action: 'remember', kind: 'other', text: 'x', user_id: 8 },
    { action: 'forget', memory_id: id, expected_updated_at: version, text: 'x' }, { action: 'forget', memory_id: 'm1', expected_updated_at: version },
    { action: 'update', memory_id: id, expected_updated_at: '2026-10-23' }, { action: 'delete', memory_id: id, expected_updated_at: version },
  ]) {
    const s = stub({ facts });
    await assert.rejects(prepare(input, s), { code: 'agent_invalid_input' }, JSON.stringify(input));
    assert.deepEqual(s.statements, []);
  }
});

test('update keeps omitted fields, may change kind, clears amount together, and refuses a no-op', async () => {
  const update = (fields: Record<string, unknown>) => prepare({ action: 'update', memory_id: id, expected_updated_at: version, ...fields });
  const raised = await update({ amount: '1000' });
  assert.deepEqual(raised, { action: 'update', kind: 'expense', memory_id: id, expected_updated_at: version, before: rent, after: { ...rent, amount: '1000.00' } });
  const reserve = await update({ kind: 'reserve', text: 'Keep 950 in chequing', cadence: null });
  assert.equal(reserve.kind, 'reserve'); assert.deepEqual(reserve.after, { kind: 'reserve', text: 'Keep 950 in chequing', amount: '950.00', currency: 'CAD', cadence: null });
  assert.deepEqual((await update({ amount: null })).after, { ...rent, amount: null, currency: null, cadence: null });
  await assert.rejects(update({ text: 'Fictional rent' }), { code: 'agent_invalid_input' });
  await assert.rejects(update({}), { code: 'agent_invalid_input' });
});

test('forget and update read the owned fact and compare its version exactly', async () => {
  const s = stub({ facts });
  assert.deepEqual(await prepare({ action: 'forget', memory_id: id, expected_updated_at: version }, s),
    { action: 'forget', kind: 'expense', memory_id: id, expected_updated_at: version, before: rent, after: null });
  assert.ok(s.statements.every(sql => sql.startsWith('SELECT')) && !s.statements.some(sql => sql.includes('*')));
  await assert.rejects(prepare({ action: 'forget', memory_id: id, expected_updated_at: '2026-10-23 12:00:00.123457' }), { code: 'agent_memory_conflict', status: 409 });
  await assert.rejects(prepare({ action: 'forget', memory_id: '00000000-0000-4000-8000-000000000002', expected_updated_at: version }), { code: 'agent_memory_not_found', status: 404 });
  // Another user's fact reads exactly like a missing one.
  await assert.rejects(prepareMemoryProposal(userId + 1, { action: 'forget', memory_id: id, expected_updated_at: version }, stub({ facts }).client), { code: 'agent_memory_not_found' });
  await assert.rejects(prepare({ action: 'update', memory_id: id, expected_updated_at: version, amount: '5' }, stub({ facts, demo: true })), { code: 'agent_memory_demo' });
});

test('recordsFor binds the route\'s user id', async () => {
  const seen: unknown[][] = [];
  const saved = db.query;
  Object.assign(db, { query: async (text: string, params: unknown[] = []) => { seen.push(params); return text.includes('to_regclass') ? { rows: [{ present: true }] } : text.includes('is_demo') ? { rows: [{ is_demo: false }] } : { rows: [{ count: '0' }] }; } });
  try { await recordsFor(42).prepareMemoryProposal({ action: 'remember', kind: 'other', text: 'Fictional' }); }
  finally { Object.assign(db, { query: saved }); }
  assert.ok(seen.filter(p => p.length).every(p => p[0] === 42));
});

test('listing rejects a bad timezone as input, including one only PostgreSQL refuses', async () => {
  const client = { query: (async (text: string) => {
    if (text.includes('to_regclass')) return { rows: [{ present: true }] };
    if (text.includes('is_demo')) return { rows: [{ is_demo: false }] };
    throw Object.assign(new Error('time zone "Fictional/Zone" not recognized'), { code: '22023' });
  }) as unknown as typeof db.query };
  await assert.rejects(listMemories(userId, 'America/Toronto', { query: client.query }), { code: 'agent_invalid_input' });
  for (const zone of ['Not/AZone', 5, ['UTC'], 'x'.repeat(101)]) await assert.rejects(listMemories(userId, zone, { query: client.query }), { code: 'agent_invalid_input' });
});

test('a turn whose zone only PostgreSQL refuses falls back to UTC for saved_on, behind a savepoint', async () => {
  const statements: string[] = [];
  const fact = { id, kind: 'other', text: 'Fictional', amount: null, currency: null, cadence: null, version, saved_on: '2026-10-23' };
  const client = (failure: { code: string }) => ({ query: (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim(); statements.push(params[1] === undefined ? sql : `${sql.slice(0, 20)} [${String(params[1])}]`);
    if (sql.includes('to_regclass')) return { rows: [{ present: true }] };
    if (sql.includes('is_demo')) return { rows: [{ is_demo: false }] };
    if (sql.startsWith('SELECT id,kind,text') && params[1] !== 'UTC') throw Object.assign(new Error('time zone "US/Pacific-New" not recognized'), failure);
    if (sql.startsWith('SELECT id,kind,text')) return { rows: [fact] };
    return { rows: [] };
  }) as unknown as typeof db.query });
  assert.deepEqual(await memoriesForTurn(userId, 'US/Pacific-New', client({ code: '22023' })), [fact]);
  assert.deepEqual(statements.filter(s => !s.includes('to_regclass') && !s.includes('is_demo')), ['SAVEPOINT memory_zone', 'SELECT id,kind,text, [US/Pacific-New]', 'ROLLBACK TO SAVEPOINT memory_zone', 'SELECT id,kind,text, [UTC]']);
  // Any other failure still fails the turn.
  await assert.rejects(memoriesForTurn(userId, 'US/Pacific-New', client({ code: '57014' })), { code: '57014' });
});
