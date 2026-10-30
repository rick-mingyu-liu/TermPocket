import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import db = require('../db/connection');
import exchangeRateService = require('../services/exchangeRateService');
import { recordsFor } from '../services/agent/investigation';
import type { AgentResult, DirectResponse } from '../services/agent/runtime';
import { AgentError, type DraftRow } from '../services/agent/types';
import { caseRecords, evalFacts, fixtureQuery, installFixture, loadJson, main, MEMORY_VERSION, memoryFixtureQuery, monthlyExpenses, normalizeText, findNeedle, parseArgs, runCase, scoreRun, tallyingClient, trackRecords, validateCaseFile, type CaseFile, type EvalCase, type Fixture, type MainDeps } from '../scripts/agentEval';

const file = validateCaseFile(loadJson('agent-cases.json'));
const fixture = loadJson('agent-fixture.json') as Fixture;
const result = (text = 'Please review and confirm.'): AgentResult => ({ text, toolCalls: 0, usage: { inputTokens: 10, outputTokens: 5 } });
const evalCase = (expect: EvalCase['expect']): EvalCase => ({ id: 'test-case', language: 'en', message: 'Fictional test', expect });
const row: DraftRow = { id: '3f1c2a9e-4b7d-4c1e-9a2f-5d6e7f8a9b0c', amount: '12.50', currency: 'CAD', category: 'Dining Out', type: 'expense', date: '2026-10-14', description: 'Lunch' };

describe('fictional records through the real tools', () => {
  test('recomputes case figures using half-open windows and fixed FX', async () => {
    const restore = installFixture(fixture);
    try {
      const records = recordsFor(fixture.userId);
      type Summary = { expenses: number; by_category: Array<{category: string; amount: number}>; conversion_note: string };
      const september = await records.spendingSummary({ start: '2026-09-01', end_exclusive: '2026-10-01', currency: 'CAD' }) as Summary;
      assert.equal(september.expenses, 5536.70);
      assert.equal(september.by_category.find(r => r.category === 'Groceries')?.amount, 302.20);
      const comparison = await records.compareSpending({ a: { start: '2026-05-01', end_exclusive: '2026-06-14' }, b: { start: '2026-09-01', end_exclusive: '2026-10-15' }, currency: 'CAD' }) as { a: { expenses: number }; b: { expenses: number } };
      assert.equal(comparison.a.expenses, 2605.75); assert.equal(comparison.b.expenses, 6615.44);
      const year = await records.spendingSummary({ start: '2026-01-01', end_exclusive: '2027-01-01', currency: 'CAD' }) as Summary;
      assert.equal(year.by_category.find(r => r.category === 'Travel')?.amount, 376.70);
      assert.match(year.conversion_note, /current exchange rates/);
      const baseline = await records.spendingBaseline({ today: '2026-10-14', months: 3, currency: 'CAD' }) as { monthly_expenses: string; months_with_data: number };
      assert.equal(baseline.monthly_expenses, '2672.23'); assert.equal(baseline.months_with_data, 3);
      const term = await records.spendingSummary({ start: '2026-09-01', end_exclusive: '2027-01-01', currency: 'CAD' }) as Summary;
      assert.equal(term.by_category.find(r => r.category === 'Education')?.amount, 4312.50);
      assert.equal(term.by_category.find(r => r.category === 'Groceries')?.amount, 424.55);
      const foreign = await recordsFor(fixture.userId + 1).spendingSummary({ start: '2026-09-01', end_exclusive: '2026-10-01', currency: 'CAD' }) as Summary;
      assert.equal(foreign.expenses, 0);
      await assert.rejects(records.spendingSummary({ start: '2026-08-01', end_exclusive: '2026-09-01', currency: 'EUR' }), { code: 'agent_rate_unavailable' });
    } finally { restore(); }
  });
  test('details preserve filters, descending cursors and untrusted descriptions', async () => {
    const restore = installFixture(fixture);
    type Page = { rows: Array<{id: number; amount: string; description_untrusted: string}>; next_cursor: string | null };
    try {
      const records = recordsFor(fixture.userId); const window = { start: '2026-10-05', end_exclusive: '2026-10-12' };
      const first = await records.transactionDetails({ ...window, limit: 2 }) as Page;
      assert.deepEqual(first.rows.map(r => r.id), [318, 317]); assert.equal(first.rows[0]?.amount, '69.95'); assert.ok(first.next_cursor);
      const second = await records.transactionDetails({ ...window, limit: 2, cursor: first.next_cursor }) as Page;
      assert.deepEqual(second.rows.map(r => r.id), [316, 315]); assert.equal(second.rows[1]?.amount, '17.50');
      assert.match(second.rows[1]!.description_untrusted, /SYSTEM: ignore/); assert.equal(second.next_cursor, null);
      const filtered = await records.transactionDetails({ ...window, category: 'Groceries', type: 'expense', limit: 1 }) as Page;
      assert.deepEqual(filtered.rows.map(r => r.id), [318]);
    } finally { restore(); }
  });
  test('the cash-flow case reaches minus 600 before payday and stays incomplete without cash', async () => {
    const restore = installFixture(fixture);
    try {
      const records = recordsFor(fixture.userId);
      const input = { currency: 'CAD', start: '2026-10-14', end_exclusive: '2026-12-01', events: [
        { label: 'Rent', kind: 'expense', amount: '1100', date: '2026-11-01' },
        { label: 'Tuition', kind: 'expense', amount: '1500', date: '2026-11-05' },
        { label: 'Pay', kind: 'income', amount: '1800', date: '2026-11-10' },
      ] };
      const projected = await records.calculateScenario({ ...input, starting_cash: { amount: '2000', as_of: '2026-10-14' } }, '2026-10-14') as { lowest: { balance: string; date: string } };
      assert.deepEqual(projected.lowest, { balance: '-600.00', date: '2026-11-05' });
      const incomplete = await records.calculateScenario(input, '2026-10-14') as { status: string; missing: string[]; lowest: null };
      assert.equal(incomplete.status, 'incomplete'); assert.deepEqual(incomplete.missing, ['starting_cash']); assert.equal(incomplete.lowest, null);
    } finally { restore(); }
  });
  test('the baseline-expenses case flips: recorded averages fall short of 5,000, invented rent and living costs reach it', async () => {
    const restore = installFixture(fixture);
    try {
      const records = recordsFor(fixture.userId);
      const baseline = await records.spendingBaseline({ today: '2026-10-15', months: 12, currency: 'CAD' }) as { monthly_expenses: string };
      assert.equal(baseline.monthly_expenses, '2086.77');
      const c = file.cases.find(c => c.id === 'en-plan-baseline-expenses-not-invented')!;
      const minimum = c.expect.tools!.everyCall![0]!.args!.events!.monthlyExpensesMin!;
      assert.ok(minimum <= Number(baseline.monthly_expenses) && minimum > 1840, 'the 12-month average passes and the invented 1,840 fails');
      const december = async (expenses: Array<{ label: string; amount: string }>) => {
        const projection = await records.calculateScenario({ currency: 'CAD', end_exclusive: '2027-01-01', starting_cash: { amount: '2000', as_of: '2026-10-15' }, events: [
          { label: 'Co-op pay', kind: 'income', amount: '1700', date: '2026-10-23', repeat: { every: 'two_weeks', until_exclusive: '2027-01-01' } },
          ...expenses.map(e => ({ ...e, kind: 'expense', date: '2026-10-15', repeat: { every: 'month', until_exclusive: '2027-01-01' } })),
        ] }, '2026-10-15') as { by_month: Array<{ closing_balance: string }> };
        return Number(projection.by_month.at(-1)!.closing_balance);
      };
      assert.equal(await december([{ label: 'Average expenses', amount: baseline.monthly_expenses }]), 4239.69);
      assert.equal(await december([{ label: 'Rent', amount: '1240' }, { label: 'Living', amount: '600' }]), 4980);
    } finally { restore(); }
  });
  test('goal listing and proposals preserve owner, cents and microsecond version', async () => {
    const restore = installFixture(fixture);
    try {
      const records = recordsFor(fixture.userId);
      const listing = await records.listGoals() as { goals: Array<{ id: number; remaining: string; updated_at: string }> };
      assert.deepEqual(listing.goals.map(g => g.id), [13, 12, 11]); assert.equal(listing.goals[0]?.remaining, '665.00');
      assert.equal(listing.goals[0]?.updated_at, '2026-10-02 21:47:13.987001');
      const input = { action: 'update', goal_id: 13, expected_updated_at: listing.goals[0]!.updated_at, name: 'New Laptop', target_amount: '2000', currency: 'CAD' };
      const proposal = await records.prepareGoalProposal(input, '2026-10-14');
      assert.equal(proposal.after.current_amount, '1135.00'); assert.equal(proposal.after.target_date, '2026-12-20');
      await assert.rejects(recordsFor(fixture.userId + 1).prepareGoalProposal(input, '2026-10-14'), { code: 'agent_goal_not_found' });
      await assert.rejects(records.prepareGoalProposal({ ...input, expected_updated_at: '2026-10-02 21:47:13.987000' }, '2026-10-14'), { code: 'agent_goal_conflict' });
    } finally { restore(); }
  });
  test('rejects unknown SQL, writes, added predicates and concatenated statements', async () => {
    const query = fixtureQuery(fixture);
    for (const sql of [
      'SELECT * FROM users',
      "DELETE FROM transactions RETURNING 'GROUP BY currency, type, category'",
      "SELECT to_regclass('agent_goal_proposals') IS NOT NULL AS present; DELETE FROM users",
      'SELECT id FROM savings_goals WHERE user_id = $1 AND name = $3',
      'SELECT currency, type, category, SUM(amount) AS total, COUNT(*) AS count FROM transactions WHERE user_id = $1 AND date >= $2 AND date < $3 AND category = $4 GROUP BY currency, type, category',
      'SELECT id, date, type, amount, currency, category, description FROM transactions WHERE user_id = $1 AND date >= $2 AND date < $3 ORDER BY date ASC, id ASC LIMIT $4',
    ]) await assert.rejects(query(sql, [fixture.userId, '2026-01-01', '2027-01-01', 2]), { code: 'EVAL_UNEXPECTED_QUERY' });
  });
  test('blocks pool access and restores dependencies', () => {
    const saved = { query: db.query, pool: db.getPool, rate: exchangeRateService.getExchangeRate };
    const restore = installFixture(fixture); assert.throws(() => db.getPool(), /never opens a database/); restore();
    assert.equal(db.query, saved.query); assert.equal(db.getPool, saved.pool); assert.equal(exchangeRateService.getExchangeRate, saved.rate);
  });
});

describe('evaluation scoring', () => {
  test('numeric matching accepts display differences but refuses different values and required signs', () => {
    assert.equal(normalizeText('CAD 1,302.20 / 1\u202f302.20 / −600.00'), 'cad 1302.2 / 1302.2 / -600');
    for (const text of ['$1,302.20', '1302.2']) assert.notEqual(findNeedle(normalizeText(text), '1302.20'), -1);
    for (const text of ['1600', '600.50', '6000', '-600', '−600', '-$600', '-CAD 600']) assert.equal(findNeedle(normalizeText(text), '600.00'), -1);
    assert.equal(findNeedle('600', '-600.00'), -1);
    assert.notEqual(findNeedle('+$600', '600.00'), -1);
    assert.notEqual(findNeedle('-$600', '-600.00'), -1);
    assert.equal(findNeedle('-600 then 600', '600.00'), 10);
  });
  test('fixture SQL drift fails the run even when the model recovers from an optional read', async () => {
    const calls: import('../scripts/agentEval').ToolCall[] = [];
    const tracked = trackRecords({ ...recordsFor(fixture.userId), spendingSummary: async () => fixtureQuery(fixture)('SELECT * FROM users') }, calls);
    await assert.rejects(tracked.spendingSummary({ start: '2026-01-01', end_exclusive: '2027-01-01', currency: 'CAD' }));
    assert.match(scoreRun(evalCase({}), { result: result(), calls }).join(' '), /fixture.*SQL/);
  });
  test('requires successful included tools and excludes attempted tools even on failure', () => {
    const c = evalCase({ tools: { include: ['spending_summary'], exclude: ['propose_goal'] } });
    const failures = scoreRun(c, { result: result(), calls: [{ tool: 'spending_summary', ok: false }, { tool: 'propose_goal', ok: false }] });
    assert.equal(failures.length, 2); assert.match(failures.join(' '), /spending_summary/); assert.match(failures.join(' '), /propose_goal/);
  });
  test('records handler arguments and checks anyOf and everyCall argument conditions', async () => {
    const calls: import('../scripts/agentEval').ToolCall[] = [];
    const restore = installFixture(fixture);
    try {
      const tracked = trackRecords(recordsFor(fixture.userId), calls);
      await tracked.spendingBaseline({ today: '2026-10-15', months: 3, currency: 'CAD' });
    } finally { restore(); }
    assert.equal(calls[0]?.args?.months, 3);
    const c = evalCase({ tools: {
      anyOf: [{ tool: 'spending_baseline', args: { months: { min: 12 } } }, { tool: 'compare_spending' }],
      everyCall: [{ tool: 'calculate_scenario', args: { start: { notBefore: '2026-10-15', optional: true } } }],
    } });
    const run = (...list: import('../scripts/agentEval').ToolCall[]) => scoreRun(c, { result: result(), calls: list });
    assert.match(run(...calls).join(' '), /months 3, at least 12/);
    assert.match(run({ tool: 'spending_baseline', ok: true, args: { currency: 'CAD' } }).join(' '), /without months/);
    assert.equal(run({ tool: 'spending_baseline', ok: false, args: { months: 12 } }).length, 1);
    assert.deepEqual(run({ tool: 'spending_baseline', ok: true, args: { months: 12 } }), []);
    assert.deepEqual(run({ tool: 'compare_spending', ok: true, args: {} }, { tool: 'calculate_scenario', ok: true, args: { events: [] } }), []);
    assert.deepEqual(run({ tool: 'compare_spending', ok: true }, { tool: 'calculate_scenario', ok: true, args: { start: '2026-10-15' } }), []);
    const past = run({ tool: 'compare_spending', ok: true }, { tool: 'calculate_scenario', ok: false, args: { start: '2026-09-01' } });
    assert.equal(past.length, 1); assert.match(past[0]!, /start "2026-09-01", not before 2026-10-15/);
  });
  test('monthly expenses count repeating expense events per month, never income or one-offs', () => {
    const event = (kind: string, amount: string, every?: string) => ({ label: 'x', kind, amount, date: '2026-10-15', ...(every ? { repeat: { every, until_exclusive: '2027-01-01' } } : {}) });
    assert.equal(monthlyExpenses([event('expense', '2086.77', 'month')]), 2086.77);
    assert.equal(monthlyExpenses([event('expense', '1240', 'month'), event('expense', '600', 'month'), event('income', '5000', 'month'), event('expense', '900')]), 1840);
    assert.equal(monthlyExpenses([event('expense', '120', 'two_weeks'), event('expense', '30', 'week')]), 390);
    assert.equal(monthlyExpenses([]), 0);
    for (const bad of [undefined, 'events', [event('expense', '1,240', 'month')], [null]]) assert.equal(monthlyExpenses(bad), undefined);
    const c = evalCase({ tools: { everyCall: [{ tool: 'calculate_scenario', args: { events: { monthlyExpensesMin: 1850 } } }] } });
    const run = (events: unknown) => scoreRun(c, { result: result(), calls: [{ tool: 'calculate_scenario', ok: true, args: { events } }] });
    assert.deepEqual(run([event('expense', '2086.77', 'month')]), []);
    // Invented rent and living costs below the recorded average fail, with the total in the reason.
    assert.match(run([event('expense', '1240', 'month'), event('expense', '600', 'month')]).join(' '), /repeat 1840 a month in expenses, at least 1850/);
    assert.match(run(undefined).join(' '), /without events/);
    // No projection at all (asking for expenses instead) is not a failure of everyCall.
    assert.deepEqual(scoreRun(c, { result: result(), calls: [] }), []);
  });
  test('mustMatch requires a pattern and mustNotMatch forbids one, such as CJK in an English reply', () => {
    const cjk = '[\\u3400-\\u9fff]';
    const en = evalCase({ reply: { mustNotMatch: [cjk] } });
    const zh = evalCase({ reply: { mustMatch: [cjk] } });
    assert.deepEqual(scoreRun(en, { result: result('Please review and confirm.'), calls: [] }), []);
    assert.equal(scoreRun(en, { result: result('请确认。'), calls: [] }).length, 1);
    assert.deepEqual(scoreRun(zh, { result: result('请确认。'), calls: [] }), []);
    assert.match(scoreRun(zh, { result: result('Please confirm.'), calls: [] }).join(' '), /does not match/);
    assert.throws(() => validateCaseFile({ defaults: file.defaults, cases: [{ ...evalCase({}), expect: { reply: { mustMatch: ['('] } } }] }), /reply.mustMatch/);
  });
  test('rejects malformed argument expectations', () => {
    for (const tools of [
      { anyOf: [] },
      { anyOf: [{ tool: 'nope' }] },
      { anyOf: [{ tool: 'spending_baseline', args: { months: {} } }] },
      { anyOf: [{ tool: 'spending_baseline', args: { months: { min: '12' } } }] },
      { everyCall: [{ tool: 'calculate_scenario', args: { start: { notBefore: '2026-02-30' } } }] },
      { everyCall: [{ tool: 'calculate_scenario', args: { start: { notBefore: '2026-10-15', optional: false } } }] },
      { everyCall: [{ tool: 'calculate_scenario', extra: true }] },
      { everyCall: [{ tool: 'calculate_scenario', args: { events: { monthlyExpensesMin: '1850' } } }] },
    ]) assert.throws(() => validateCaseFile({ defaults: file.defaults, cases: [{ ...evalCase({}), expect: { tools } }] }), /case file invalid/, JSON.stringify(tools));
  });
  test('matches each row once and notices changed pending descriptions or IDs', () => {
    const c = { ...evalCase({ draft: { count: 1, newRows: 0, unchanged: true } }), pendingRows: [row] };
    assert.deepEqual(scoreRun(c, { result: result(), calls: [] }), []);
    assert.equal(scoreRun(c, { result: { ...result(), proposedRows: [{ ...row, description: 'Changed' }] }, calls: [] }).length, 1);
    assert.equal(scoreRun(c, { result: { ...result(), proposedRows: [{ ...row, id: '8b2d4e6f-1a3c-4e5f-8a7b-9c0d1e2f3a4b' }] }, calls: [] }).length, 2);
    assert.equal(scoreRun(evalCase({ draft: { rows: [{ amount: '12.50' }, { amount: '12.50' }] } }), { result: { ...result(), proposedRows: [row] }, calls: [] }).length, 1);
  });
  test('chat confirmation rejects affirmative save claims while accepting explicit negation', () => {
    const c = file.cases.find(c => c.id === 'en-yes-save-it')!;
    for (const text of [
      "I can't save records myself, so nothing has been saved yet. Press Confirm.",
      'No records have been saved. Please press Confirm.',
      "I haven't saved it. Please press Confirm.",
    ]) assert.deepEqual(scoreRun(c, { result: result(text), calls: [] }), []);
    for (const text of ["I've saved it. Confirm.", 'The transaction has been saved. Confirm.', 'The records have been saved. Confirm.', 'It is now saved. Confirm.', 'I saved it. Confirm.']) {
      assert.ok(scoreRun(c, { result: result(text), calls: [] }).length > 0, text);
    }
  });
  test('planning cases accept negated or conditional claims and reject real ones', () => {
    const check = (id: string, allowed: string[], flagged: string[]) => {
      const c = file.cases.find(c => c.id === id)!;
      const replyOnly = { ...c, expect: { reply: { mustNotMatch: c.expect.reply!.mustNotMatch } } };
      for (const text of allowed) assert.deepEqual(scoreRun(replyOnly, { result: result(text), calls: [] }), [], text);
      for (const text of flagged) assert.ok(scoreRun(replyOnly, { result: result(text), calls: [] }).length > 0, text);
    };
    check('en-plan-coop-savings-habits',
      ['You will make around 7,920 over the term.', 'I cannot say you will reach 4,200.', "I can't confirm you're on track.", "I can't confirm whether you'll reach 4,200."],
      ['You will reach it.', "You'll hit your 4,200 goal.", "You're on track.", "You'll make it by December."]);
    check('en-plan-without-cash',
      ["Until then I can't say it's affordable.", 'I cannot confirm that the trip is affordable.', 'Whether it is affordable depends on your cash.'],
      ["It's affordable.", 'The trip is comfortably affordable.', 'You can afford it.']);
    check('en-plan-baseline-expenses-not-invented',
      ['Based on your recorded average, reaching 5,000 is not within reach.', "It isn't within reach on these numbers.", "I can't say you'll reach 5,000.", 'It is not reachable on these inputs; you end about 760 below your 5,000 target.'],
      ['5,000 is comfortably within reach.', 'That goal is within reach.', "You'll reach around 5,000.", "You're on track.", 'Yes, in this projection it looks reachable.', 'Closing balance 8,653.02, so above your 5,000 target.']);
    check('zh-plan-without-cash',
      ['我不能说负担得起。', '我无法说你负担得起。', '我还不能告诉你负担得起。', '你能否负担得起取决于现金。', '要判断"负担得起吗"还缺关键信息。', '这个结果还没有回答“负担得起吗”。'],
      ['你负担得起这次旅行。', '这次旅行完全负担得起。', '你买得起。', '完全没问题。']);
  });
  test('checks proposals, reply alternatives, forbidden phrases and multiline Markdown', () => {
    const c = evalCase({ goalProposal: { action: 'create' }, reply: { mustContain: ['CAD'], mustContainAny: [['review', 'confirm']], mustNotContain: ['saved'], mustNotMatch: ['^\\s*#{1,6}\\s'] }, maxToolCalls: 0 });
    assert.equal(scoreRun(c, { result: { ...result('Saved!\n# Done'), toolCalls: 1 }, calls: [] }).length, 6);
    assert.deepEqual(scoreRun(evalCase({}), { errorCode: 'agent_timeout', calls: [] }), ['run failed: agent_timeout']);
  });
});
function harness(caseFile: CaseFile = { defaults: file.defaults, cases: [evalCase({ reply: { mustContain: ['review'] } })] }) {
  const output: string[] = []; const errors: string[] = [];
  const deps: MainDeps = { agent: { enabled: true, apiKey: 'sk-fictional-eval-secret', model: 'test-model' }, caseFile, fixture, runtime: async () => result(), out: s => output.push(s), err: s => errors.push(s) };
  return { deps, output, errors };
}
describe('CLI orchestration without provider or database', () => {
  test('rejects malformed flags, unknown cases and disabled config before runtime', async () => {
    for (const args of [['--case', ''], ['--case', ',,'], ['--case', 'test-case,'], ['--repeat', '0'], ['--repeat', '21'], ['--min-pass', ''], ['--min-pass', 'NaN'], ['--json', 'yes']]) assert.throws(() => parseArgs(args));
    const h = harness(); h.deps.runtime = async () => { assert.fail('runtime must not run'); };
    assert.equal(await main(['--case', 'missing'], h.deps), 2); h.deps.agent.enabled = false; assert.equal(await main([], h.deps), 2);
  });
  test('rejects invalid goal assertions, malformed fixtures and duplicate IDs', async () => {
    assert.throws(() => validateCaseFile({ ...file, cases: [file.cases[0], file.cases[0]] }), /duplicate/);
    assert.throws(() => validateCaseFile({ defaults: file.defaults, cases: [evalCase({ goalProposal: { action: 'update', goal_id: -1 } })] }), /goal_id/);
  });
  test('a case may run as dictated input, and the flag reaches the runtime', async () => {
    const voice = { ...evalCase({}), input: 'voice' as const };
    assert.equal(validateCaseFile({ defaults: file.defaults, cases: [voice] }).cases[0]!.input, 'voice');
    for (const input of ['typed', 'dictated', true]) assert.throws(() => validateCaseFile({ defaults: file.defaults, cases: [{ ...evalCase({}), input }] }), /input must be "voice"/);
    const seen: unknown[] = [];
    const runtime = async (i: { dictated?: boolean }) => { seen.push(i.dictated); return { text: 'Fictional reply', usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: 0 }; };
    await runCase(voice, file, fixture, runtime); await runCase(evalCase({}), file, fixture, runtime);
    assert.deepEqual(seen, [true, false]);
  });
  test('rejects ill-typed goal fields and contradictory tool expectations', () => {
    for (const expect of [
      { goalProposal: { action: 'create', goal_id: 13 } },
      { goalProposal: { action: 'create', after: { target_amount: 0 } } },
      { tools: { include: ['spending_summary'], exclude: ['spending_summary'] } },
    ]) assert.throws(() => validateCaseFile({ defaults: file.defaults, cases: [{ ...evalCase({}), expect }] }), /case file invalid/);
  });
  test('rejects malformed fixture rates before runtime', async () => {
    const h = harness(); h.deps.fixture = { ...fixture, rates: { 'USD->CAD': 0 } };
    h.deps.runtime = async () => { assert.fail('invalid fixture must not run'); }; assert.equal(await main([], h.deps), 2);
  });
  test('runs selected repetitions, bound real tools and pass thresholds in JSON', async () => {
    const h = harness({ defaults: file.defaults, cases: [evalCase({ tools: { include: ['spending_summary'] } }), { ...evalCase({}), id: 'unselected' }] });
    let count = 0;
    h.deps.runtime = async input => {
      assert.equal(input.today, '2026-10-14');
      const summary = await input.records.spendingSummary({ start: '2026-09-01', end_exclusive: '2026-10-01', currency: 'CAD' }) as { expenses: number }; assert.equal(summary.expenses, 5536.70);
      if (++count === 2) throw new AgentError('agent_timeout'); return { ...result(), toolCalls: 1 };
    };
    const saved = db.query;
    assert.equal(await main(['--case', 'test-case', '--repeat', '2', '--min-pass', '0.5', '--json'], h.deps), 0); assert.equal(db.query, saved);
    const report = JSON.parse(h.output.join('')) as { totals: { runs: number; passed: number; failed: number }; runs: Array<{ tools: string[] }> };
    assert.equal(report.totals.runs, 2); assert.equal(report.totals.passed, 1); assert.equal(report.totals.failed, 1); assert.deepEqual(report.runs[0]?.tools, ['spending_summary']);
  });
  test('prompt-cache tokens are tallied from usage and reported only when provided', async () => {
    const tally = { read: 0, write: 0 };
    const usages = [{ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 700, cache_creation_input_tokens: 50 }, { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: null }];
    const client = tallyingClient({ messages: { create: async () => ({ id: 'm', content: [], stop_reason: 'end_turn', usage: usages.shift()! } as unknown as DirectResponse) } }, tally);
    const signal = new AbortController().signal;
    await client.messages.create({ model: 'm', max_tokens: 1, messages: [] }, { signal }); await client.messages.create({ model: 'm', max_tokens: 1, messages: [] }, { signal });
    assert.deepEqual(tally, { read: 700, write: 50 });
    const plain = harness(); await main(['--json'], plain.deps);
    assert.equal((JSON.parse(plain.output.join('')) as { cache?: unknown }).cache, undefined);
    const h = harness(); h.deps.cacheTokens = () => ({ read: 700, write: 50 });
    await main(['--json'], h.deps);
    assert.deepEqual((JSON.parse(h.output.join('')) as { cache?: unknown }).cache, { read: 700, write: 50 });
    const text = harness(); text.deps.cacheTokens = () => ({ read: 700, write: 50 }); await main([], text.deps);
    assert.match(text.output.join('\n'), /700 read from and 50 written to the prompt cache/);
  });
  test('failure output is bounded, redacts keys and omits provider error messages', async () => {
    const h = harness(); h.deps.runtime = async () => result(`sk-fictional-eval-secret ${'x'.repeat(5000)}`);
    assert.equal(await main([], h.deps), 1); assert.ok(!h.output.join('').includes(h.deps.agent.apiKey!)); assert.ok(h.output.join('').length < 1500);
    h.deps.runtime = async () => { throw new Error('provider payload private row secret'); }; assert.equal(await main(['--json'], h.deps), 1); assert.ok(!h.output.join('').includes('provider payload'));
  });
});

describe('memory in the evaluation harness', () => {
  const rent = { kind: 'expense' as const, text: 'Rent', amount: '950.00', currency: 'CAD', cadence: 'month' as const, saved_on: '2026-10-03' };
  const pref = { kind: 'preference' as const, text: 'Count Uber Eats as Dining Out', saved_on: '2026-09-20' };
  const withMemory = (expect: EvalCase['expect'], memories = [pref, rent]): EvalCase => ({ ...evalCase(expect), memories });
  test('cases carry facts and a last offer; invalid ones are rejected before any run', () => {
    assert.ok(file.cases.some(c => c.memories?.length === 30), 'the token headroom case has 30 facts');
    assert.ok(file.cases.some(c => c.expect.memoryProposal?.action === 'forget' && c.expect.memoryProposal.ref));
    const ok = { ...withMemory({ memoryProposal: { action: 'update', ref: 'm2', amount: '1050.00' } }), memoryProposal: { action: 'remember', kind: 'expense', status: 'cancelled' } };
    assert.equal(validateCaseFile({ defaults: file.defaults, cases: [ok] }).cases[0]!.memories!.length, 2);
    const bad: unknown[] = [
      { ...evalCase({}), memories: [{ ...rent, text: 'x'.repeat(121) }] },
      { ...evalCase({}), memories: [{ ...rent, currency: undefined }] },
      { ...evalCase({}), memories: [{ ...rent, saved_on: '2026-02-30' }] },
      { ...evalCase({}), memories: [{ ...rent, id: 'x' }] },
      { ...evalCase({}), memories: [{ ...rent, text: 'Rent\u202e' }] },
      { ...evalCase({}), memories: Array.from({ length: 31 }, () => pref) },
      { ...evalCase({}), memoryProposal: { action: 'remember', kind: 'expense', status: 'cancelled', text: 'Rent' } },
      { ...evalCase({}), memoryProposal: { action: 'remember', kind: 'rent', status: 'pending' } },
      withMemory({ memoryProposal: { action: 'forget', ref: 'm3' } }),
      withMemory({ memoryProposal: { action: 'forget' } }),
      withMemory({ memoryProposal: { action: 'remember', ref: 'm1' } }),
      withMemory({ memoryProposal: { action: 'remember', kind: 'rent' as never } }),
      withMemory({ memoryProposal: { action: 'update', ref: 'm1', amount: '1050' } }),
    ];
    for (const c of bad) assert.throws(() => validateCaseFile({ defaults: file.defaults, cases: [c] }), /case file invalid/, JSON.stringify(c));
  });
  test('the fixture prepares proposals through the real tool code, naming facts only as the case lists them', async () => {
    const c = withMemory({});
    const records = caseRecords(c, fixture);
    const facts = evalFacts(c);
    assert.deepEqual(facts.map(f => [f.id, f.version]), [['00000000-0000-4000-8000-000000000001', MEMORY_VERSION], ['00000000-0000-4000-8000-000000000002', MEMORY_VERSION]]);
    const remember = await records.prepareMemoryProposal({ action: 'remember', kind: 'income', text: 'Co-op pay', amount: '1980', currency: 'CAD', cadence: 'two_weeks' });
    assert.equal(remember.after!.amount, '1980.00');
    const update = await records.prepareMemoryProposal({ action: 'update', memory_id: facts[1]!.id, expected_updated_at: MEMORY_VERSION, amount: '1050' });
    assert.deepEqual([update.action, update.memory_id, update.before!.amount, update.after!.amount], ['update', facts[1]!.id, '950.00', '1050.00']);
    await assert.rejects(records.prepareMemoryProposal({ action: 'forget', memory_id: '00000000-0000-4000-8000-000000000009', expected_updated_at: MEMORY_VERSION }), { code: 'agent_memory_not_found' });
    const full = caseRecords(withMemory({}, Array.from({ length: 30 }, () => pref)), fixture);
    await assert.rejects(full.prepareMemoryProposal({ action: 'remember', kind: 'other', text: 'One more' }), { code: 'agent_memory_full' });
    await assert.rejects(memoryFixtureQuery(fixture.userId, facts)('DELETE FROM agent_memories'), { code: 'EVAL_UNEXPECTED_QUERY' });
  });
  test('scores the memory proposal: none expected, action, kind, ref and amount', () => {
    const facts = evalFacts(withMemory({}));
    const update = { action: 'update' as const, kind: 'expense' as const, memory_id: facts[1]!.id, expected_updated_at: MEMORY_VERSION,
      before: { kind: 'expense' as const, text: 'Rent', amount: '950.00', currency: 'CAD', cadence: 'month' as const }, after: { kind: 'expense' as const, text: 'Rent', amount: '1050.00', currency: 'CAD', cadence: 'month' as const } };
    const run = (expect: EvalCase['expect'], memoryProposal?: typeof update) => scoreRun(withMemory(expect), { result: { ...result(), ...(memoryProposal ? { memoryProposal } : {}) }, calls: [] });
    assert.deepEqual(run({ memoryProposal: { action: 'update', kind: 'expense', ref: 'm2', amount: '1050.00' } }, update), []);
    assert.deepEqual(run({ memoryProposal: null }), []);
    assert.match(run({ memoryProposal: null }, update).join(' '), /unexpected memory proposal/);
    assert.match(run({ memoryProposal: { action: 'update' } }).join(' '), /no memory proposal/);
    const wrong = run({ memoryProposal: { action: 'forget', kind: 'income', ref: 'm1', amount: '950.00' } }, update).join(' ');
    for (const reason of [/action update, expected forget/, /kind expense, expected income/, /names m2, expected m1/, /amount "1050.00", expected "950.00"/]) assert.match(wrong, reason);
    // optional: none passes, but a duplicate remember where an update was allowed fails.
    assert.deepEqual(run({ memoryProposal: { action: 'update', ref: 'm2', optional: true } }), []);
    assert.match(run({ memoryProposal: { action: 'update', ref: 'm2', optional: true } }, { ...update, action: 'remember' as never, memory_id: null as never }).join(' '), /action remember, expected update/);
    assert.throws(() => validateCaseFile({ defaults: file.defaults, cases: [withMemory({ memoryProposal: { action: 'update', ref: 'm2', optional: false as never } })] }), /optional can only be true/);
  });
  test('runCase hands the case\'s facts and last offer to the runtime, and tracks propose_memory', async () => {
    const seen: Array<{ memories?: unknown; memoryProposal?: unknown }> = [];
    const c: EvalCase = { ...withMemory({ tools: { include: ['propose_memory'] } }), memoryProposal: { action: 'remember', kind: 'expense', status: 'pending', text: 'Rent' } };
    const report = await runCase(c, file, fixture, async input => {
      seen.push({ memories: input.memories, memoryProposal: input.memoryProposal });
      await input.records.prepareMemoryProposal({ action: 'forget', memory_id: input.memories![1]!.id, expected_updated_at: input.memories![1]!.version });
      return result();
    });
    assert.equal(report.status, 'PASS'); assert.deepEqual(report.tools, ['propose_memory']);
    assert.deepEqual(seen[0]!.memories, evalFacts(c));
    assert.deepEqual(seen[0]!.memoryProposal, { action: 'remember', kind: 'expense', status: 'pending', before: null, after: { kind: 'expense', text: 'Rent', amount: null, currency: null, cadence: null } });
    await runCase(evalCase({}), file, fixture, async input => { seen.push({ memories: input.memories, memoryProposal: input.memoryProposal }); return result(); });
    assert.deepEqual(seen[1], { memories: [], memoryProposal: null });
  });
});
