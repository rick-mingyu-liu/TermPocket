import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

/**
 * Account deletion against PostgreSQL. Two fictional users get rows in every
 * per-user table — through the real agent store and token service where they
 * write them, so the rows are the shapes the app makes — and one has a Pocky
 * turn still running. Deleting one leaves that user zero rows anywhere and the
 * other user exactly as before; a wrong password and the demo account delete
 * nothing; and the turn that was running cannot publish afterwards.
 *
 * Also checks that OWNED_TABLES names every table with a user_id column, so a
 * table added later without being listed fails here rather than relying on a
 * cascade nobody wrote down.
 *
 * Needs an explicit TEST_DATABASE_URL (with migrations 013, 015, 016 and 022),
 * never the .env database. Users are fictional and removed afterwards; the
 * demo account, if the test database has one, is only read.
 */
const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) { process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; process.env.NODE_ENV = 'test'; }

describe('account deletion against the database', { skip: !enabled }, () => {
  let db: typeof import('../db/connection');
  let store: typeof import('../services/agent/store');
  let accounts: typeof import('../services/accountService');
  let tokens: typeof import('../services/accessTokens');
  const PASSWORD = 'fictional-deletion-password';
  const created: number[] = [];
  let alice: number; let bob: number;
  let demo: number; let demoCreated = false;
  let runningConversation: string; let runningRequest: string;
  const settings = { currency: 'CAD', timezone: 'America/Toronto', language: 'auto' as const };

  async function user(name: string, demoFlag = false): Promise<number> {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const id = (await db.query<{ id: number }>(
      `INSERT INTO users(email,password_hash,first_name,last_name,email_verified,is_demo,transaction_retention_terms)
       VALUES($1,$2,$3,'Deletion',TRUE,$4,$5) RETURNING id`,
      [`${name}-${randomUUID()}@example.invalid`, hash, name, demoFlag, demoFlag ? null : 6]
    )).rows[0]!.id;
    created.push(id);
    return id;
  }

  /** Rows in every per-user table, the way the app writes them. */
  async function populate(owner: number): Promise<void> {
    await db.query("INSERT INTO transactions(user_id,amount,description,category,type,date,currency) VALUES($1,12.50,'Fictional lunch','Dining Out','expense','2026-10-01','CAD')", [owner]);
    await db.query("INSERT INTO savings_goals(user_id,name,target_amount,target_date) VALUES($1,'Fictional laptop',1500,'2027-04-30')", [owner]);
    await db.query('INSERT INTO import_batches(user_id,row_count,edited_count,llm_count) VALUES($1,3,1,0)', [owner]);
    await tokens.createToken(owner, 'Fictional agent', { operator: true });

    // A confirmed draft with its receipt.
    const drafted = await store.createConversation(owner, settings);
    const r1 = randomUUID();
    await store.beginTurn(owner, drafted.id, { ...settings, requestId: r1, content: 'Fictional lunch 12.50' });
    const row = { id: randomUUID(), amount: '12.50', description: 'Fictional lunch', category: 'Dining Out', type: 'expense' as const, date: '2026-10-14', currency: 'CAD' };
    const s = await store.finishTurn(owner, drafted.id, r1, { text: 'Please review.', proposedRows: [row, { ...row, id: randomUUID() }] });
    await store.confirmDraft(owner, drafted.id, { version: s.draft!.version, rowIds: [s.draft!.rows[0]!.id], requestId: randomUUID() });

    // A pending goal proposal.
    const planned = await store.createConversation(owner, settings);
    const r2 = randomUUID();
    await store.beginTurn(owner, planned.id, { ...settings, requestId: r2, content: 'Fictional goal request' });
    await store.finishTurn(owner, planned.id, r2, {
      text: 'Please review the goal.',
      goalProposal: { action: 'create', goal_id: null, expected_updated_at: null, before: null, after: { name: 'Fictional trip', target_amount: '2000.00', current_amount: '0.00', currency: 'CAD', target_date: '2027-05-01', description: null } },
    });

    // A remembered fact and a pending offer, using the same button-owned
    // lifecycle as the app. Both must disappear with the account.
    const remembered = await store.createConversation(owner, settings);
    const memoryRun = randomUUID();
    await store.beginTurn(owner, remembered.id, { ...settings, requestId: memoryRun, content: 'Fictional rent is 950 CAD a month' });
    const memoryDraft = {
      action: 'remember', kind: 'expense', memory_id: null, expected_updated_at: null, before: null,
      after: { kind: 'expense', text: 'Fictional rent', amount: '950.00', currency: 'CAD', cadence: 'month' },
    };
    const offered = await store.finishTurn(owner, remembered.id, memoryRun, { text: 'Review this memory.', memoryProposal: memoryDraft });
    await store.confirmMemoryProposal(owner, remembered.id, { proposalId: offered.memoryProposal!.id, requestId: randomUUID() });
    const pendingRun = randomUUID();
    await store.beginTurn(owner, remembered.id, { ...settings, requestId: pendingRun, content: 'Fictional reserve is 1000 CAD' });
    await store.finishTurn(owner, remembered.id, pendingRun, { text: 'Review this memory.', memoryProposal: {
      ...memoryDraft, kind: 'reserve', after: { ...memoryDraft.after, kind: 'reserve', text: 'Fictional reserve', amount: '1000.00', cadence: null },
    } });

    // A receipt detached from deleted history (conversation_id SET NULL).
    const detached = await store.createConversation(owner, settings);
    const r3 = randomUUID();
    await store.beginTurn(owner, detached.id, { ...settings, requestId: r3, content: 'Fictional coffee 4.00' });
    const d = await store.finishTurn(owner, detached.id, r3, { text: 'Please review.', proposedRows: [{ ...row, id: randomUUID(), amount: '4.00' }] });
    await store.confirmDraft(owner, detached.id, { version: d.draft!.version, rowIds: d.draft!.rows.map((r) => r.id), requestId: randomUUID() });
    await store.deleteConversation(owner, detached.id);
  }

  async function counts(owner: number): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of accounts.OWNED_TABLES) {
      out[table] = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE user_id=$1`, [owner])).rows[0]!.n);
    }
    out.users = Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM users WHERE id=$1', [owner])).rows[0]!.n);
    return out;
  }

  before(async () => {
    db = require('../db/connection');
    store = require('../services/agent/store');
    accounts = require('../services/accountService');
    tokens = require('../services/accessTokens');
    const probe = await db.query<{ present: boolean }>(
      "SELECT to_regclass('agent_goal_proposals') IS NOT NULL AND to_regclass('agent_memories') IS NOT NULL AND to_regclass('agent_memory_proposals') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='transaction_retention_terms') AS present"
    );
    assert.ok(probe.rows[0]!.present, 'the test database needs migrations 015, 016 and 022 (npm run db:setup against TEST_DATABASE_URL)');
    alice = await user('alice');
    bob = await user('bob');
    const existingDemo = (await db.query<{ id: number }>('SELECT id FROM users WHERE is_demo')).rows[0];
    if (existingDemo) demo = existingDemo.id;
    else { demo = await user('demo', true); demoCreated = true; }
    await populate(alice);
    await populate(bob);
    // A turn still running when the account goes.
    runningConversation = (await store.createConversation(alice, settings)).id;
    runningRequest = randomUUID();
    await store.beginTurn(alice, runningConversation, { ...settings, requestId: runningRequest, content: 'Fictional pending question' });
  });

  after(async () => {
    if (!db) return;
    const own = demoCreated ? created : created.filter((id) => id !== demo);
    await db.query('DELETE FROM users WHERE id=ANY($1::int[])', [own]);
    await db.getPool().end();
  });

  test('OWNED_TABLES names every table with a user_id column', async () => {
    const found = (await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.columns WHERE table_schema=current_schema() AND column_name='user_id' ORDER BY table_name"
    )).rows.map((r) => r.table_name);
    assert.deepEqual(found, [...accounts.OWNED_TABLES].sort());
  });

  test('every table starts with rows for both users', async () => {
    for (const owner of [alice, bob]) {
      for (const [table, n] of Object.entries(await counts(owner))) assert.ok(n > 0, `user ${owner} has no ${table} rows to delete`);
    }
    const detached = await db.query('SELECT 1 FROM agent_receipts WHERE user_id=$1 AND conversation_id IS NULL', [alice]);
    assert.equal(detached.rowCount, 1, 'no detached receipt');
  });

  test('a wrong password deletes nothing', async () => {
    const before = await counts(alice);
    await assert.rejects(accounts.deleteAccount(alice, 'not-the-password'), { code: 'account_password_incorrect' });
    assert.deepEqual(await counts(alice), before);
  });

  test('the demo account refuses, even with its right password', async () => {
    const before = await counts(demo);
    await assert.rejects(accounts.deleteAccount(demo, demoCreated ? PASSWORD : 'password123'), { code: 'account_demo' });
    assert.deepEqual(await counts(demo), before);
  });

  test('deleting one account leaves it nothing anywhere and the other user untouched', async () => {
    const bobBefore = await counts(bob);
    const deleted = await accounts.deleteAccount(alice, PASSWORD);
    assert.equal(deleted.users, 1);
    assert.ok((deleted.agent_admissions ?? 0) >= 4, 'admissions were not deleted with the account');
    for (const [table, n] of Object.entries(await counts(alice))) assert.equal(n, 0, `${table} still has rows for the deleted user`);
    assert.deepEqual(await counts(bob), bobBefore, 'the other user lost rows');
    const retention = await db.query<{ terms: number | null }>('SELECT transaction_retention_terms AS terms FROM users WHERE id=$1', [bob]);
    assert.equal(retention.rows[0]!.terms, 6, "the other user's retention setting changed");
  });

  test('the turn that was running cannot publish or be checked afterwards', async () => {
    await assert.rejects(store.assertRunActive(alice, runningConversation, runningRequest), { code: 'agent_not_found' });
    await assert.rejects(store.finishTurn(alice, runningConversation, runningRequest, { text: 'late reply' }), { code: 'agent_not_found' });
    assert.equal((await db.query('SELECT 1 FROM agent_messages WHERE conversation_id=$1', [runningConversation])).rowCount, 0);
  });

  test('a second deletion finds no account', async () => {
    await assert.rejects(accounts.deleteAccount(alice, PASSWORD), { code: 'account_not_found' });
  });
});
