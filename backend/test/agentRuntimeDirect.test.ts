import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageCreateParamsNonStreaming, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { cacheOnSuccess, clientOptions, createDirectRuntime, type DirectResponse, type MessagesClient } from '../services/agent/runtime';
import config = require('../config');
import { AgentError, type AgentRecords } from '../services/agent/types';
import logger = require('../utils/logger');

// The runtime against a scripted fake HTTP client: no network. Turn behaviour
// (tools, budgets, prompt envelope) is in agentRuntime.test.ts; these cover the
// request it sends and the loop itself.

config.agent.enabled = true; config.agent.apiKey = 'fictional-test-key';
const unused = async () => assert.fail('records read without a tool call');
const noRecords = { spendingSummary: unused, compareSpending: unused, transactionDetails: unused, spendingBaseline: unused, listGoals: unused, calculateScenario: unused, prepareGoalProposal: unused, prepareMemoryProposal: unused };
const okRecords = (answer: unknown = { ok: true }) => {
  const calls: string[] = [];
  const record = (fn: string) => async () => { calls.push(fn); return answer; };
  return { calls, records: { spendingSummary: record('spendingSummary'), compareSpending: record('compareSpending'), transactionDetails: record('transactionDetails'),
    spendingBaseline: record('spendingBaseline'), listGoals: record('listGoals'), calculateScenario: record('calculateScenario'), prepareGoalProposal: unused, prepareMemoryProposal: unused } };
};
const input = { content: 'Coffee 5 CAD today', history: [], pendingRows: [], currency: 'CAD', timezone: 'America/Toronto', language: 'en' as const, today: '2026-10-14', signal: new AbortController().signal, records: noRecords };
const row = { amount: '5.00', description: 'Coffee', category: 'Dining Out', type: 'expense', date: '2026-10-14', currency: 'CAD' };
const window = { start: '2026-09-01', end_exclusive: '2026-10-15' };

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
const zero: Usage = { input_tokens: 0, output_tokens: 0 };
let ids = 0;
const reply = (text: string, usage: Usage = { input_tokens: 20, output_tokens: 10 }, stop_reason = 'end_turn') =>
  ({ id: `msg_${++ids}`, content: [{ type: 'text', text }], stop_reason, usage }) as unknown as DirectResponse;
const uses = (calls: Array<[name: string, args: unknown]>, usage: Usage = zero, extra: unknown[] = []) =>
  ({ id: `msg_${++ids}`, content: [...extra, ...calls.map(([name, args]) => ({ type: 'tool_use', id: `toolu_${++ids}`, name, input: args, caller: { type: 'direct' } }))], stop_reason: 'tool_use', usage }) as unknown as DirectResponse;

type Step = DirectResponse | ((body: MessageCreateParamsNonStreaming, signal: AbortSignal) => Promise<DirectResponse>);
/** Answers request i with step i; records a deep copy of every request body. */
function scripted(steps: Step[]) {
  const requests: MessageCreateParamsNonStreaming[] = [];
  const signals: AbortSignal[] = [];
  const client: MessagesClient = { messages: { create: async (body, { signal }) => {
    requests.push(structuredClone(body)); signals.push(signal);
    const step = steps[requests.length - 1];
    if (step === undefined) return assert.fail(`unexpected request ${requests.length}`);
    return typeof step === 'function' ? step(body, signal) : step;
  } } };
  return { runtime: createDirectRuntime(async () => client), requests, signals };
}
/** The tool results the request after a tool_use response carried, in order. */
const resultsIn = (body: MessageCreateParamsNonStreaming) => body.messages[body.messages.length - 1]!.content as ToolResultBlockParam[];
const resultText = (r: ToolResultBlockParam) => (r.content as Array<{ text: string }>)[0]!.text;
const never = (_body: MessageCreateParamsNonStreaming, signal: AbortSignal) => new Promise<DirectResponse>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })), { once: true });
});

async function limitReason(run: () => Promise<unknown>): Promise<{ error: AgentError; reason: string | undefined; fields: Record<string, unknown> | undefined }> {
  const logged: unknown[][] = [];
  const spy = mock.method(logger, 'error', (...args: unknown[]) => { logged.push(args); });
  try {
    const error = await run().then(() => assert.fail('expected a failure'), (e: unknown) => e as AgentError);
    const limit = logged.find(args => args[0] === 'Agent run hit a limit')?.[1] as Record<string, unknown> | undefined;
    return { error, reason: limit?.reason as string | undefined, fields: limit };
  } finally { spy.mock.restore(); }
}

test('direct: one tool call sends the same prompt, envelope and tools, then returns the reply', async () => {
  const s = scripted([uses([['propose_transactions', { rows: [row] }]], { input_tokens: 100, output_tokens: 20 }), reply('Please review the draft.', { input_tokens: 150, output_tokens: 15, cache_read_input_tokens: 50 })]);
  const progress: number[] = [];
  const result = await s.runtime(input, event => progress.push(event.toolCalls));
  assert.equal(result.text, 'Please review the draft.');
  assert.equal(result.toolCalls, 1);
  assert.deepEqual(progress, [1]);
  assert.equal(result.proposedRows?.length, 1);
  // Real usage only, summed over both requests, cache reads included.
  assert.deepEqual(result.usage, { inputTokens: 300, outputTokens: 35 });
  const [first, second] = s.requests;
  assert.equal(first!.model, config.agent.model);
  assert.equal(first!.max_tokens, config.agent.maxOutputTokens);
  assert.deepEqual(first!.thinking, { type: 'disabled' });
  assert.match(String(first!.system), /^You are Pocky/);
  assert.deepEqual(first!.messages.length, 1);
  const envelope = JSON.parse(String(first!.messages[0]!.content)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(envelope), ['currentMessage', 'history', 'pendingRows', 'context']);
  // No memories (before 022, the demo account): propose_memory is not offered.
  assert.deepEqual(first!.tools!.map(t => (t as { name: string }).name), ['propose_transactions', 'spending_summary', 'compare_spending', 'transaction_details', 'spending_baseline', 'list_goals', 'calculate_scenario', 'propose_goal']);
  for (const t of first!.tools!) {
    const schema = (t as { input_schema: Record<string, unknown> }).input_schema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.$schema, undefined);
    assert.ok((t as { description?: string }).description);
  }
  const proposal = (first!.tools![0] as { input_schema: { required: string[]; properties: { rows: { maxItems: number } } } }).input_schema;
  assert.deepEqual(proposal.required, ['rows']);
  assert.equal(proposal.properties.rows.maxItems, config.agent.maxRows);
  // The assistant turn is echoed with API fields only, then one result.
  assert.equal(second!.messages.length, 3);
  const echoed = second!.messages[1]!.content as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(echoed[0]!).sort(), ['id', 'input', 'name', 'type']);
  const [result1] = resultsIn(second!);
  assert.equal(result1!.tool_use_id, echoed[0]!.id);
  assert.equal(result1!.is_error, undefined);
  assert.equal((JSON.parse(resultText(result1!)) as { status: string }).status, 'pending_review');
});

test('direct: several tool calls in one response run in order and answer in one message, in order', async () => {
  const order: string[] = [];
  const records = { ...okRecords().records,
    spendingSummary: async () => { order.push('summary'); await new Promise(resolve => setTimeout(resolve, 5)); return { s: 1 }; },
    listGoals: async () => { order.push('goals'); return { g: 1 }; } };
  const s = scripted([
    uses([['spending_summary', window], ['list_goals', {}], ['propose_transactions', { rows: [row] }]], zero, [{ type: 'text', text: 'Checking.' }]),
    reply('Done.'),
  ]);
  const result = await s.runtime({ ...input, records });
  assert.deepEqual(order, ['summary', 'goals']);
  assert.equal(result.toolCalls, 3);
  assert.equal(result.text, 'Done.');
  const results = resultsIn(s.requests[1]!);
  const echoed = s.requests[1]!.messages[1]!.content as Array<{ type: string; id?: string }>;
  assert.deepEqual(echoed.map(b => b.type), ['text', 'tool_use', 'tool_use', 'tool_use']);
  assert.deepEqual(results.map(r => r.tool_use_id), echoed.slice(1).map(b => b.id));
  assert.deepEqual(results.map(r => resultText(r).slice(0, 7)), ['{"s":1}', '{"g":1}', '{"statu']);
});

test('direct: an unknown tool is answered with an error, counts as an attempt, and the turn goes on', async () => {
  const s = scripted([uses([['delete_transactions', { all: true }], ['Bash', { command: 'env' }]]), reply('I cannot do that.')]);
  const result = await s.runtime(input);
  assert.equal(result.toolCalls, 0);
  const results = resultsIn(s.requests[1]!);
  assert.deepEqual(results.map(r => [r.is_error, resultText(r)]), [[true, 'agent_unknown_tool: Use only the listed tools.'], [true, 'agent_unknown_tool: Use only the listed tools.']]);
  // Nine unknown calls exhaust the attempt budget even though nothing ran.
  const many = scripted([uses(Array.from({ length: 9 }, () => ['Bash', {}] as [string, unknown]))]);
  const { error, reason } = await limitReason(() => many.runtime(input));
  assert.equal(error.code, 'agent_limit_exceeded');
  assert.equal(reason, 'tool_attempts');
  assert.deepEqual(error.usage, { inputTokens: 0, outputTokens: 0, toolCalls: 0 });
});

test('direct: invalid arguments get a repairable schema error naming fields, never values, and never reach the handler', async () => {
  const fake = okRecords();
  const s = scripted([
    uses([['propose_transactions', { rows: [{ ...row, amount: 5, secret_field: 'Fictional SIN 123' }] }], ['spending_summary', { start: 20260901 }]]),
    uses([['propose_transactions', { rows: [row] }]]),
    reply('Fixed.'),
  ]);
  const result = await s.runtime({ ...input, records: fake.records });
  assert.equal(fake.calls.length, 0);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.proposedRows?.length, 1);
  const [bad, badRead] = resultsIn(s.requests[1]!);
  assert.equal(bad!.is_error, true);
  assert.match(resultText(bad!), /^agent_invalid_input: The arguments do not match the propose_transactions schema\. Fix: rows\.0\.amount \(invalid_type\), rows\.0 \(unrecognized_keys\)\.$/);
  assert.ok(!resultText(bad!).includes('Fictional'));
  assert.match(resultText(badRead!), /start \(invalid_type\), end_exclusive \(invalid_type\)/);
  // Schema failures spend attempts: nine of them stop the turn.
  const many = scripted([uses(Array.from({ length: 9 }, () => ['list_goals', 'not an object'] as [string, unknown]))]);
  const { error, reason } = await limitReason(() => many.runtime(input));
  assert.equal(error.code, 'agent_limit_exceeded');
  assert.equal(reason, 'tool_attempts');
});

test('direct: assertActive runs before every tool execution', async () => {
  let checks = 0;
  const fake = okRecords();
  const s = scripted([uses([['spending_summary', window], ['list_goals', {}]]), uses([['spending_baseline', {}]]), reply('ok')]);
  await s.runtime({ ...input, records: fake.records, assertActive: async () => { checks++; } });
  assert.equal(checks, 3);
  assert.deepEqual(fake.calls, ['spendingSummary', 'listGoals', 'spendingBaseline']);
  // Revoked between two calls in one response: the second never runs, and nothing more is requested.
  let allowed = 1;
  const revoked = okRecords();
  const r = scripted([uses([['spending_summary', window], ['list_goals', {}]])]);
  await assert.rejects(r.runtime({ ...input, records: revoked.records, assertActive: async () => { if (allowed-- <= 0) throw new Error('revoked'); } }), { code: 'agent_cancelled' });
  assert.deepEqual(revoked.calls, ['spendingSummary']);
  assert.equal(r.requests.length, 1);
});

test('direct: each budget trips a 429 agent_limit_exceeded and logs its reason with counts only', async () => {
  const many = (n: number, name = 'list_goals'): Array<[string, unknown]> => Array.from({ length: n }, () => [name, {}]);
  const cases: Array<{ reason: string; steps: Step[]; records?: AgentRecords; before?: () => void }> = [
    // Every execution is first an attempt, so a ninth call of any kind trips the
    // attempt budget at the gate, before its handler (and before tool_calls could).
    { reason: 'tool_attempts', steps: [uses(many(8)), uses(many(1))], records: okRecords().records },
    { reason: 'tool_attempts', steps: [uses(many(9, 'unknown'))] },
    { reason: 'tool_output_chars', steps: [uses([['spending_summary', window], ['propose_transactions', { rows: Array.from({ length: 12 }, () => ({ ...row, description: 'd'.repeat(255) })) }]])],
      records: { ...okRecords().records, spendingSummary: async () => ({ pad: 'x'.repeat(config.agent.maxToolOutputChars - 500) }) } },
    { reason: 'total_tokens', steps: [reply('x', { input_tokens: config.agent.maxTotalTokens, output_tokens: 1 })] },
    // Cumulative output across requests, each under max_tokens on its own.
    { reason: 'output_tokens', steps: [uses(many(1), { input_tokens: 10, output_tokens: 3000 }), reply('x', { input_tokens: 10, output_tokens: 1001 })], records: okRecords().records },
    { reason: 'assistant_chars', steps: [reply('x'.repeat(config.agent.maxToolOutputChars + config.agent.maxOutputChars + 1))] },
    { reason: 'final_chars', steps: [reply('x'.repeat(config.agent.maxOutputChars + 1))] },
    { reason: 'max_turns', steps: Array.from({ length: config.agent.maxTurns }, () => uses([['unknown', {}]])) },
    // Cut off at max_tokens: asking for more would overrun the output budget.
    { reason: 'max_tokens', steps: [reply('Partial', { input_tokens: 10, output_tokens: config.agent.maxOutputTokens }, 'max_tokens')] },
  ];
  // max_turns needs more attempts than the eight-attempt budget allows.
  const oldTurns = config.agent.maxTurns;
  for (const c of cases) {
    if (c.reason === 'max_turns') config.agent.maxTurns = 4;
    try {
      const steps = c.reason === 'max_turns' ? c.steps.slice(0, 4) : c.steps;
      const s = scripted(steps);
      const { error, reason, fields } = await limitReason(() => s.runtime({ ...input, records: c.records ?? noRecords }));
      assert.equal(error.code, 'agent_limit_exceeded', c.reason);
      // Mid-turn or at the final reply, a limit is the same 429.
      assert.equal(error.status, 429, c.reason);
      assert.equal(reason, c.reason);
      assert.deepEqual(Object.keys(fields!).sort(), ['inputTokens', 'observedChars', 'outputTokens', 'reason', 'thinkingBlocks', 'toolAttempts', 'toolCalls', 'toolOutputChars']);
      assert.ok(error.usage, `${c.reason} carries usage`);
      if (c.reason === 'max_turns') assert.equal(s.requests.length, 4);
    } finally { config.agent.maxTurns = oldTurns; }
  }
});

test('direct: max_turns ends the turn without running the last turn\'s tools', async () => {
  const oldTurns = config.agent.maxTurns; config.agent.maxTurns = 2;
  try {
    const fake = okRecords();
    const s = scripted([uses([['list_goals', {}]]), uses([['list_goals', {}]])]);
    await assert.rejects(s.runtime({ ...input, records: fake.records }), { code: 'agent_limit_exceeded' });
    assert.deepEqual(fake.calls, ['listGoals']);
  } finally { config.agent.maxTurns = oldTurns; }
});

test('direct: thinking blocks are counted and echoed back, never logged', async () => {
  const secret = 'fictional private reasoning about rent';
  const s = scripted([
    uses([['list_goals', {}]], { input_tokens: 10, output_tokens: 10 }, [{ type: 'thinking', thinking: secret, signature: 'sig' }]),
    { id: 'm_final', content: [{ type: 'thinking', thinking: secret, signature: 'sig2' }, { type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: { input_tokens: config.agent.maxTotalTokens, output_tokens: 1 } } as unknown as DirectResponse,
  ]);
  const { reason, fields } = await limitReason(() => s.runtime({ ...input, records: okRecords().records }));
  assert.equal(reason, 'total_tokens');
  assert.equal(fields!.thinkingBlocks, 2);
  assert.ok(!JSON.stringify(fields).includes(secret));
  assert.deepEqual((s.requests[1]!.messages[1]!.content as Array<{ type: string }>)[0], { type: 'thinking', thinking: secret, signature: 'sig' });
});

test('direct: cancellation mid-request aborts the HTTP call and returns agent_cancelled', async () => {
  const controller = new AbortController();
  const s = scripted([uses([['list_goals', {}]]), (body, signal) => { setTimeout(() => controller.abort(), 5); return never(body, signal); }]);
  await assert.rejects(s.runtime({ ...input, records: okRecords().records, signal: controller.signal }), { code: 'agent_cancelled', status: 409 });
  assert.equal(s.signals[1]!.aborted, true);
});

test('direct: cancellation while a tool runs stops before the next tool and the next request', async () => {
  const controller = new AbortController();
  const fake = okRecords();
  const records = { ...fake.records, spendingSummary: async () => { controller.abort(); return { s: 1 }; } };
  const s = scripted([uses([['spending_summary', window], ['list_goals', {}]])]);
  await assert.rejects(s.runtime({ ...input, records, signal: controller.signal }), { code: 'agent_cancelled' });
  assert.deepEqual(fake.calls, []);
  assert.equal(s.requests.length, 1);
});

test('direct: the deadline aborts a hanging request as agent_timeout', async () => {
  const oldTimeout = config.agent.timeoutMs; config.agent.timeoutMs = 15;
  try {
    const s = scripted([never]);
    await assert.rejects(s.runtime(input), { code: 'agent_timeout', status: 504 });
    assert.equal(s.signals[0]!.aborted, true);
    // A client that never even loads is bounded by the same deadline.
    const stuck = createDirectRuntime(() => new Promise(() => {}));
    await assert.rejects(stuck(input), { code: 'agent_timeout' });
  } finally { config.agent.timeoutMs = oldTimeout; }
});

test('direct: the deadline and a cancel end the turn while a tool or revocation check is still pending', async () => {
  // A hung query, pool connect or rate lookup must not hold the turn, and with it
  // the process's model slot, past the deadline. The handler never settles here.
  const hang = () => new Promise<never>(() => {});
  const oldTimeout = config.agent.timeoutMs; config.agent.timeoutMs = 30;
  try {
    for (const hung of [{ records: { ...okRecords().records, listGoals: hang } }, { records: okRecords().records, assertActive: hang }]) {
      const s = scripted([uses([['list_goals', {}]])]);
      const started = Date.now();
      await assert.rejects(s.runtime({ ...input, ...hung }), { code: 'agent_timeout', status: 504 });
      assert.ok(Date.now() - started < 1000, 'returned at the deadline, not when the tool settled');
      assert.equal(s.requests.length, 1);
    }
  } finally { config.agent.timeoutMs = oldTimeout; }
  const controller = new AbortController();
  const s = scripted([uses([['list_goals', {}]])]);
  const records = { ...okRecords().records, listGoals: () => { setTimeout(() => controller.abort(), 5); return hang(); } };
  await assert.rejects(s.runtime({ ...input, records, signal: controller.signal }), { code: 'agent_cancelled', status: 409 });
  assert.equal(s.requests.length, 1);
});

test('direct: provider errors map to agent_provider_error and log name and code only', async () => {
  const secret = 'secret raw provider payload: Fictional lunch 42.00';
  const failures: Step[][] = [
    [async () => { throw Object.assign(new Error(secret), { name: 'RateLimitError', status: 429, error: { message: secret } }); }],
    [async () => { throw Object.assign(new Error(secret), { name: 'APIConnectionError', code: 'ECONNRESET' }); }],
    [reply('refused', undefined, 'refusal')],
    [reply('   ')],
    [{ id: 'm', content: [], stop_reason: 'tool_use', usage: zero } as unknown as DirectResponse],
  ];
  for (const steps of failures) {
    const logged: unknown[][] = [];
    const spy = mock.method(logger, 'error', (...args: unknown[]) => { logged.push(args); });
    try {
      await assert.rejects(scripted(steps).runtime(input), { code: 'agent_provider_error', message: 'agent_provider_error', status: 502 });
    } finally { spy.mock.restore(); }
    assert.ok(!JSON.stringify(logged).includes('secret'));
    assert.ok(!JSON.stringify(logged).includes('refused'));
  }
  const logged: unknown[][] = [];
  const spy = mock.method(logger, 'error', (...args: unknown[]) => { logged.push(args); });
  try { await assert.rejects(scripted(failures[1]!).runtime(input)); } finally { spy.mock.restore(); }
  assert.deepEqual(logged, [['Agent runtime failed', { error: 'APIConnectionError', code: 'ECONNRESET' }]]);
});

test('direct: a goal proposal and a draft are published only by a turn that finishes', async () => {
  const goalDraft = { action: 'create' as const, goal_id: null, expected_updated_at: null, before: null,
    after: { name: 'Fictional laptop', target_amount: '1500.00', current_amount: '0.00', currency: 'CAD', target_date: '2027-04-30', description: null } };
  const records = { ...okRecords().records, prepareGoalProposal: async () => goalDraft };
  const calls: Array<[string, unknown]> = [['propose_goal', { action: 'create', name: 'Fictional laptop', target_amount: '1500', currency: 'CAD', target_date: '2027-04-30' }], ['propose_transactions', { rows: [row] }]];
  const done = await scripted([uses(calls), reply('Review both.')]).runtime({ ...input, records });
  assert.deepEqual(done.goalProposal, goalDraft);
  assert.equal(done.proposedRows?.length, 1);
  // The same tools, then a token overrun: the turn fails and nothing is returned to publish.
  await assert.rejects(scripted([uses(calls), reply('x', { input_tokens: config.agent.maxTotalTokens, output_tokens: 1 })]).runtime({ ...input, records }), { code: 'agent_limit_exceeded' });
});

test('direct: nothing from the host clock reaches the provider; the envelope context is the only date', async () => {
  // A host clock far from the conversation day: any leak would show 2031.
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2031, 2, 3, 12, 0, 0) });
  try {
    const s = scripted([uses([['list_goals', {}], ['propose_transactions', { rows: [row] }]]), reply('Please review.')]);
    await s.runtime({ ...input, records: okRecords({ goals: [] }).records });
    const everything = JSON.stringify(s.requests);
    assert.ok(!everything.includes('2031'));
    assert.ok(!/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b|GMT|UTC|Coordinated/.test(everything));
    // Every date-shaped string in every request is either the envelope's context or the row the model itself proposed.
    const context = (JSON.parse(String(s.requests[0]!.messages[0]!.content)) as { context: unknown }).context;
    const allowed = new Set([...JSON.stringify(context).matchAll(/\d{4}-\d{2}-\d{2}/g)].map(m => m[0]).concat(row.date));
    for (const body of s.requests) {
      const { messages, ...rest } = body;
      assert.ok(!/\d{4}-\d{2}-\d{2}/.test(JSON.stringify(rest)), 'system prompt and tool schemas carry no date');
      for (const found of JSON.stringify(messages).matchAll(/\d{4}-\d{2}-\d{2}/g)) assert.ok(allowed.has(found[0]), found[0]);
    }
  } finally { mock.timers.reset(); }
});

test('direct: a disabled or keyless agent never loads the client', async () => {
  const runtime = createDirectRuntime(async () => assert.fail('client loaded'));
  const oldKey = config.agent.apiKey; config.agent.apiKey = undefined;
  try { await assert.rejects(runtime(input), { code: 'agent_unavailable' }); } finally { config.agent.apiKey = oldKey; }
});

test('direct: responses that repeat or omit an id are each counted against the token budgets', async () => {
  const same = (r: DirectResponse, id: string) => ({ ...r, id }) as DirectResponse;
  // Two requests, one shared id: both are billed, so both count.
  const s = scripted([same(uses([['list_goals', {}]], { input_tokens: 100, output_tokens: 20 }), 'msg_same'), same(reply('Done.', { input_tokens: 150, output_tokens: 15 }), 'msg_same')]);
  const result = await s.runtime({ ...input, records: okRecords().records });
  assert.deepEqual(result.usage, { inputTokens: 250, outputTokens: 35 });
  // Empty ids, each request just over half the budget: together they trip it.
  const half = Math.floor(config.agent.maxTotalTokens / 2) + 1;
  const e = scripted([same(uses([['list_goals', {}]], { input_tokens: half, output_tokens: 0 }), ''), same(reply('Done.', { input_tokens: half, output_tokens: 0 }), '')]);
  const { error, reason } = await limitReason(() => e.runtime({ ...input, records: okRecords().records }));
  assert.equal(error.code, 'agent_limit_exceeded');
  assert.equal(reason, 'total_tokens');
});

test('direct: an empty text block is not echoed into the next request', async () => {
  const s = scripted([uses([['list_goals', {}]], zero, [{ type: 'text', text: '' }]), reply('Done.')]);
  await s.runtime({ ...input, records: okRecords().records });
  const echoed = s.requests[1]!.messages[1]!.content as Array<{ type: string }>;
  assert.deepEqual(echoed.map(b => b.type), ['tool_use']);
  assert.ok(!JSON.stringify(s.requests[1]!.messages).includes('"text":""'));
});

test('direct: a client that fails to load is retried on the next turn, and a loaded one is reused', async () => {
  let loads = 0;
  const client: MessagesClient = { messages: { create: async () => reply('Hello.') } };
  const load = cacheOnSuccess(async () => { if (++loads === 1) throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' }); return client; });
  const runtime = createDirectRuntime(load);
  const spy = mock.method(logger, 'error', () => {});
  try {
    await assert.rejects(runtime(input), { code: 'agent_provider_error' });
  } finally { spy.mock.restore(); }
  assert.equal((await runtime(input)).text, 'Hello.');
  assert.equal((await runtime(input)).text, 'Hello.');
  assert.equal(loads, 2);
});

test('direct: a response cut off at max_tokens never runs its tools', async () => {
  for (const stop of ['max_tokens', 'model_context_window_exceeded']) {
    const fake = okRecords();
    const cut = { ...uses([['list_goals', {}], ['spending_summary', window]], { input_tokens: 10, output_tokens: 10 }), stop_reason: stop } as DirectResponse;
    const s = scripted([cut]);
    const { error, reason } = await limitReason(() => s.runtime({ ...input, records: fake.records }));
    assert.equal(error.code, 'agent_limit_exceeded', stop);
    assert.equal(reason, 'max_tokens');
    assert.deepEqual(fake.calls, []);
    assert.equal(s.requests.length, 1);
  }
});

test('the HTTP client takes nothing from the host\'s ANTHROPIC_* variables, OpenTelemetry included', async () => {
  // ANTHROPIC_CUSTOM_HEADERS is the exception the options cannot close; the startup check refuses it (configValidate.test.ts).
  const host = { ANTHROPIC_API_KEY: 'fictional-host-key', ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_AUTH_TOKEN: 'fictional-token', ANTHROPIC_LOG: 'debug',
    ANTHROPIC_OPEN_TELEMETRY: 'true', ANTHROPIC_OPEN_TELEMETRY_PROPAGATION: 'true', ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE: 'content' };
  const saved = Object.fromEntries(Object.keys(host).map((k) => [k, process.env[k]]));
  Object.assign(process.env, host);
  try {
    // Loaded the way the runtime loads it.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic(clientOptions());
    assert.equal(client.logLevel, 'off');
    assert.equal(client.openTelemetry.propagation, false);
    assert.equal(client.openTelemetry.traces.enabled, false);

    // And the request it actually sends.
    const sent: { url: string; headers: Headers }[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
    };
    await new Anthropic({ ...clientOptions(), fetch }).messages.create({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(sent.length, 1);
    const [request] = sent as [{ url: string; headers: Headers }];
    assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(request.headers.get('x-api-key'), 'fictional-test-key');
    for (const name of ['authorization', 'traceparent', 'tracestate', 'baggage']) assert.equal(request.headers.get(name), null, name);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
