import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import db = require('../db/connection');
import store = require('../services/agent/store');

/**
 * Migration 015 may be applied after the planning release is deployed. Until
 * then the store must never query agent_goal_proposals: conversations read
 * with no goal proposal, the buttons answer agent_unavailable, a proposal from
 * a turn is dropped, and the hourly sweep skips the table. When it exists, a
 * failing proposal cleanup must not roll back the other cleanups. The pool is
 * faked; no database is needed.
 */

const conversationId = '00000000-0000-4000-8000-0000000000aa';
const ids = { proposalId: '00000000-0000-4000-8000-0000000000bb', requestId: '00000000-0000-4000-8000-0000000000cc' };
let present: boolean;
let failProposalCleanup: boolean;
let statements: string[];
let printed: unknown[];

beforeEach(() => {
  present = false; failProposalCleanup = false; statements = []; printed = [];
  mock.method(console, 'error', (...args: unknown[]) => { printed.push(args); });
  const client = {
    query: async (text: string) => {
      statements.push(text);
      if (text.includes('to_regclass')) return { rowCount: 1, rows: [{ present: text.includes("agent_goal_proposals") && present }] };
      if (text.includes('agent_goal_proposals')) {
        assert.ok(present, `queried a table that does not exist: ${text}`);
        if (failProposalCleanup && text.startsWith('UPDATE agent_goal_proposals')) throw Object.assign(new Error('secret row text'), { code: '57014' });
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('FROM users')) return { rowCount: 1, rows: [{ id: 7 }] };
      if (text.includes('FROM agent_conversations')) return { rowCount: 1, rows: [{ id: conversationId, user_id: 7, title: 't', currency: 'CAD', timezone: 'UTC', language: 'auto' }] };
      if (text.includes('FROM agent_runs WHERE id=$1')) return { rowCount: 1, rows: [{ id: ids.requestId, status: 'running', error_code: null, lease_expired: false }] };
      if (text.startsWith('DELETE FROM agent_drafts')) return { rowCount: 2, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release: () => {},
  };
  mock.method(db, 'getPool', () => ({ connect: async () => client }));
});
afterEach(() => mock.restoreAll());

const touched = () => statements.filter(s => s.includes('agent_goal_proposals') && !s.includes('to_regclass'));

// Runs first: only a positive probe is cached, so the absent case must come before any present one.
test('without the table: no goal proposal, unavailable buttons, dropped proposals and a sweep that skips it', async () => {
  const state = await store.getConversation(7, conversationId);
  assert.equal(state.goalProposal, null);
  await assert.rejects(store.confirmGoalProposal(7, conversationId, ids), { code: 'agent_unavailable', status: 503 });
  await assert.rejects(store.cancelGoalProposal(7, conversationId, ids.proposalId), { code: 'agent_unavailable', status: 503 });
  const draft = { action: 'create', goal_id: null, expected_updated_at: null, before: null, after: { name: 'n', target_amount: '1.00', current_amount: '0.00', currency: 'CAD', target_date: '2027-01-01', description: null } };
  const finished = await store.finishTurn(7, conversationId, ids.requestId, { text: 'Reply', goalProposal: draft });
  assert.equal(finished.goalProposal, null);
  assert.ok(statements.some(s => s.startsWith("INSERT INTO agent_messages")), 'the reply was still stored');
  assert.equal(await store.cleanupAgentData(), 2);
  assert.ok(!statements.some(s => s.includes('SAVEPOINT goal_proposals')));
  assert.deepEqual(touched(), []);
  assert.equal(statements.at(-1), 'COMMIT');
});

test('once the table appears it is used without a restart, and a failing proposal cleanup keeps the others', async () => {
  present = true;
  await store.getConversation(7, conversationId);
  assert.equal(touched().length, 1);
  failProposalCleanup = true; statements = [];
  assert.equal(await store.cleanupAgentData(), 2);
  const order = statements.filter(s => /SAVEPOINT|^COMMIT|^ROLLBACK/.test(s) && !s.includes('memory_proposals'));
  assert.deepEqual(order, ['SAVEPOINT goal_proposals', 'ROLLBACK TO SAVEPOINT goal_proposals', 'COMMIT']);
  assert.ok(statements.some(s => s.startsWith('DELETE FROM agent_drafts')));
  assert.match(JSON.stringify(printed), /Agent goal proposal cleanup failed/);
  assert.doesNotMatch(JSON.stringify(printed), /secret/);
  assert.match(JSON.stringify(printed), /57014/);
});
