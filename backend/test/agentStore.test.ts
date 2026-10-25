import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ConversationState } from '../services/agent/types';
const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) { process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; process.env.NODE_ENV = 'test'; }
describe('agent storage safety', { skip: !enabled }, () => {
  let store: typeof import('../services/agent/store');
  let db: typeof import('../db/connection');
  const users: number[] = [];
  let alice: number; let bob: number;
  const settings = { currency: 'CAD', timezone: 'America/Toronto', language: 'auto' as const };
  const row = () => ({ id: randomUUID(), amount: '12.50', description: 'Fictional lunch', category: 'Dining Out', type: 'expense' as const, date: '2026-10-14', currency: 'CAD' });
  async function proposal(): Promise<ConversationState> {
    const c = await store.createConversation(alice, settings); const requestId = randomUUID();
    await store.beginTurn(alice, c.id, { ...settings, requestId, content: 'Fictional lunch' });
    return store.finishTurn(alice, c.id, requestId, { text: 'Please review.', proposedRows: [row(), row()] });
  }
  before(async () => {
    store = require('../services/agent/store'); db = require('../db/connection');
    for (let n = 0; n < 2; n++) users.push((await db.query<{id:number}>("INSERT INTO users(email,password_hash,first_name,last_name) VALUES($1,'x','Agent','Test') RETURNING id", [`agent-${randomUUID()}@example.invalid`])).rows[0]!.id);
    alice = users[0]!; bob = users[1]!;
  });
  // Many tests admit turns for the same user; keep each under the hourly cap.
  beforeEach(async () => { await db.query('DELETE FROM agent_admissions WHERE user_id=ANY($1::int[])', [users]); });
  after(async () => { if (db) { await db.query('DELETE FROM users WHERE id=ANY($1::int[])', [users]); await db.getPool().end(); } });
  test('conversation order follows creation time and stays stable after visits and messages', async () => {
    const older = await store.createConversation(bob, settings);
    const newer = await store.createConversation(bob, settings);
    const sameTime = await store.createConversation(bob, settings);
    await db.query("UPDATE agent_conversations SET created_at='2026-01-01T00:00:00Z',updated_at='2030-01-01T00:00:00Z' WHERE id=$1", [older.id]);
    await db.query("UPDATE agent_conversations SET created_at='2026-01-02T00:00:00Z',updated_at='2026-01-02T00:00:00Z' WHERE id=ANY($1::uuid[])", [[newer.id,sameTime.id]]);
    const expected = [...[newer.id,sameTime.id].sort().reverse(),older.id];
    assert.deepEqual((await store.listConversations(bob)).map(c=>c.id), expected);
    await store.getConversation(bob, older.id);
    const requestId = randomUUID();
    await store.beginTurn(bob,older.id,{...settings,requestId,content:'Fictional follow-up'});
    await store.finishTurn(bob,older.id,requestId,{text:'Please provide an amount.'});
    assert.deepEqual((await store.listConversations(bob)).map(c=>c.id), expected);
    for (const id of expected) await store.deleteConversation(bob,id);
  });
  test('concurrent identical confirmations write a selected subset once; changed nonce reuse conflicts', async () => {
    const s = await proposal(); const input = { version: s.draft!.version, rowIds: [s.draft!.rows[0]!.id], requestId: randomUUID() };
    const results = await Promise.all([store.confirmDraft(alice,s.conversation.id,input), store.confirmDraft(alice,s.conversation.id,input)]);
    assert.equal(results[0]!.receipts[0]!.id, results[1]!.receipts[0]!.id);
    assert.equal(results[0]!.receipts[0]!.transaction_ids.length,1);
    assert.equal(results[0]!.draft!.rows.length,1);
    assert.equal((await db.query('SELECT id FROM transactions WHERE user_id=$1',[alice])).rowCount,1);
    await assert.rejects(store.confirmDraft(alice,s.conversation.id,{...input,rowIds:[s.draft!.rows[1]!.id]}),{code:'agent_request_conflict'});
    await store.undoReceipt(alice,results[0]!.receipts[0]!.id);
  });
  test('one confirmation saves edited selected rows, retains other edits and replays exactly once', async () => {
    const s=await proposal();
    const rows=s.draft!.rows.map((r,i)=>({...r,amount:i?'24.90':'18.50',description:i?'Fictional remaining edit':'Fictional saved edit'}));
    const input={version:s.draft!.version,rowIds:[rows[0]!.id],requestId:randomUUID(),rows};
    const [saved,replayed]=await Promise.all([store.confirmDraft(alice,s.conversation.id,input),store.confirmDraft(alice,s.conversation.id,input)]);
    assert.equal(saved.receipts[0]!.id,replayed.receipts[0]!.id);
    const transaction=(await db.query<{amount:string;description:string}>('SELECT amount,description FROM transactions WHERE id=$1',[saved.receipts[0]!.transaction_ids[0]])).rows[0]!;
    assert.deepEqual(transaction,{amount:'18.50',description:'Fictional saved edit'});
    assert.deepEqual(saved.draft!.rows,[rows[1]]);
    await assert.rejects(store.confirmDraft(alice,s.conversation.id,Object.assign({},input,{rows:rows.map(r=>({...r,amount:'99.00'}))})),{code:'agent_request_conflict'});
    await store.undoReceipt(alice,saved.receipts[0]!.id);
  });
  test('inline edits reject foreign, missing, duplicate or invalid rows without changing the draft', async () => {
    const s=await proposal();const rows=s.draft!.rows;
    const base={version:s.draft!.version,rowIds:[rows[0]!.id],requestId:randomUUID()};
    for(const invalid of [[rows[0]], [rows[0],row()], [rows[0],rows[0]], rows.map(r=>({...r,amount:'0.00'}))]) {
      await assert.rejects(store.confirmDraft(alice,s.conversation.id,Object.assign({},base,{rows:invalid})),{code:'agent_invalid_input'});
    }
    await assert.rejects(store.confirmDraft(bob,s.conversation.id,Object.assign({},base,{rows})),{code:'agent_not_found'});
    const current=await store.getConversation(alice,s.conversation.id);
    assert.equal(current.draft!.version,s.draft!.version);assert.equal(current.receipts.length,0);
  });
  test('ownership, obsolete versions and arbitrary edited IDs cannot write', async () => {
    const s = await proposal();
    await assert.rejects(store.getConversation(bob,s.conversation.id),{code:'agent_not_found'});
    await assert.rejects(store.confirmDraft(bob,s.conversation.id,{version:1,rowIds:[s.draft!.rows[0]!.id],requestId:randomUUID()}),{code:'agent_not_found'});
    await assert.rejects(store.editDraft(alice,s.conversation.id,1,[row()]),{code:'agent_invalid_input'});
    const edited = await store.editDraft(alice,s.conversation.id,1,[{...s.draft!.rows[0]!,amount:'15.00'}]);
    assert.equal(edited.draft!.version,2);
    await assert.rejects(store.confirmDraft(alice,s.conversation.id,{version:1,rowIds:[s.draft!.rows[0]!.id],requestId:randomUUID()}),{code:'agent_version_conflict'});
  });
  test('cancelled and deleted runs cannot publish drafts; request identity is immutable',async()=>{
    const c=await store.createConversation(alice,settings); const requestId=randomUUID(); const input={...settings,requestId,content:'Fictional input'};
    assert.equal((await store.beginTurn(alice,c.id,input)).started,true);
    assert.equal((await store.beginTurn(alice,c.id,input)).started,false);
    await assert.rejects(store.beginTurn(alice,c.id,{...input,content:'Changed'}),{code:'agent_request_conflict'});
    const other=await store.createConversation(alice,settings);
    await assert.rejects(store.beginTurn(alice,other.id,{...input,requestId:randomUUID()}),{code:'agent_busy'});
    await store.cancelRun(alice,c.id,requestId);
    await assert.rejects(store.finishTurn(alice,c.id,requestId,{text:'late',proposedRows:[row()]}),{code:'agent_cancelled'});
    const r2=randomUUID(); await store.beginTurn(alice,c.id,{...input,requestId:r2});
    await store.deleteConversation(alice,c.id);
    await assert.rejects(store.finishTurn(alice,c.id,r2,{text:'late'}),{code:'agent_not_found'});
  });
  test('undo detects microsecond manual edits; deletion preserves saved entries and usable minimal receipt',async()=>{
    const s=await proposal(); const confirmed=await store.confirmDraft(alice,s.conversation.id,{version:1,rowIds:s.draft!.rows.map(r=>r.id),requestId:randomUUID()});
    const receipt=confirmed.receipts[0]!;
    await db.query("UPDATE transactions SET description='Manual edit' WHERE id=$1",[receipt.transaction_ids[0]]);
    await assert.rejects(store.undoReceipt(alice,receipt.id),{code:'agent_undo_conflict'});
    assert.equal((await db.query('SELECT id FROM transactions WHERE id=ANY($1::int[])',[receipt.transaction_ids])).rowCount,2);
    await store.deleteConversation(alice,s.conversation.id);
    assert.equal((await db.query('SELECT id FROM transactions WHERE id=ANY($1::int[])',[receipt.transaction_ids])).rowCount,2);
    const s2=await proposal();const saved=await store.confirmDraft(alice,s2.conversation.id,{version:1,rowIds:[s2.draft!.rows[0]!.id],requestId:randomUUID()});
    await store.deleteConversation(alice,s2.conversation.id);await store.undoReceipt(alice,saved.receipts[0]!.id);await store.undoReceipt(alice,saved.receipts[0]!.id);
  });
  test('undo compares PostgreSQL microseconds without JavaScript Date truncation',async()=>{
    const s=await proposal();const confirmed=await store.confirmDraft(alice,s.conversation.id,{version:1,rowIds:[s.draft!.rows[0]!.id],requestId:randomUUID()});const receipt=confirmed.receipts[0]!;
    // Two timestamps in the same JavaScript millisecond must still conflict.
    // Set the retained timestamp one microsecond earlier while retaining xmin,
    // isolating timestamp precision from the independent tuple-version guard.
    await db.query(`UPDATE agent_receipts SET transaction_versions=jsonb_set(transaction_versions,'{0,updated_at}',to_jsonb(((transaction_versions->0->>'updated_at')::timestamptz-interval '1 microsecond')::text)) WHERE id=$1`,[receipt.id]);
    await assert.rejects(store.undoReceipt(alice,receipt.id),{code:'agent_undo_conflict'});
    assert.equal((await db.query('SELECT id FROM transactions WHERE id=ANY($1::int[])',[receipt.transaction_ids])).rowCount,1);
  });
  test('compound foreign keys reject same-owner wrong-conversation run links and cross-owner drafts',async()=>{
    const s=await proposal();const other=await store.createConversation(alice,settings);
    const message=(await db.query<{id:string}>('SELECT id FROM agent_messages WHERE conversation_id=$1 LIMIT 1',[s.conversation.id])).rows[0]!;
    await assert.rejects(db.query('UPDATE agent_messages SET conversation_id=$1 WHERE id=$2',[other.id,message.id]),{code:'23503'});
    await assert.rejects(db.query('UPDATE agent_drafts SET user_id=$1 WHERE conversation_id=$2',[bob,s.conversation.id]),{code:'23503'});
  });
  test('a failing second financial insert rolls back the entire batch and receipt',async()=>{
    const s=await proposal();const rows=s.draft!.rows.map((r,i)=>({...r,description:i?'Reject fictional row':'Accept fictional row'}));
    await db.query("ALTER TABLE transactions ADD CONSTRAINT agent_test_reject CHECK (description <> 'Reject fictional row') NOT VALID");
    try {
      const before=await db.query<{count:string}>('SELECT count(*) FROM transactions WHERE user_id=$1',[alice]);
      await assert.rejects(store.confirmDraft(alice,s.conversation.id,Object.assign({version:s.draft!.version,rowIds:rows.map(r=>r.id),requestId:randomUUID()},{rows})),{code:'23514'});
      assert.equal((await db.query<{count:string}>('SELECT count(*) FROM transactions WHERE user_id=$1',[alice])).rows[0]!.count,before.rows[0]!.count);
      const unchanged=await store.getConversation(alice,s.conversation.id);
      assert.equal(unchanged.receipts.length,0);assert.deepEqual(unchanged.draft,s.draft);
    } finally {await db.query('ALTER TABLE transactions DROP CONSTRAINT agent_test_reject');}
  });
  test('history and conversation limits are bounded and run cleanup preserves messages',async()=>{
    const c=await store.createConversation(bob,settings);const runId=randomUUID();
    await store.beginTurn(bob,c.id,{...settings,requestId:runId,content:'Fictional history'});await store.finishTurn(bob,c.id,runId,{text:'Recorded context'});
    await db.query("INSERT INTO agent_messages(id,conversation_id,user_id,role,content,status,created_at) SELECT gen_random_uuid(),$1,$2,'user',repeat('x',1000),'complete',now()+n*interval '1 millisecond' FROM generate_series(1,196) n",[c.id,bob]);
    const next=randomUUID();const started=await store.beginTurn(bob,c.id,{...settings,requestId:next,content:'Next'});
    assert.ok(started.history.length<=30);assert.ok(started.history.reduce((n,m)=>n+m.content.length,0)<=24000);
    await store.finishTurn(bob,c.id,next,{text:'Finished'});
    await assert.rejects(store.beginTurn(bob,c.id,{...settings,requestId:randomUUID(),content:'Over cap'}),{code:'agent_conversation_full'});
    await db.query("UPDATE agent_runs SET created_at=now()-interval '31 days' WHERE conversation_id=$1",[c.id]);
    await store.cleanupAgentData();assert.equal((await store.getConversation(bob,c.id)).messages.length,200);
  });
  test('conversation admission caps at 100 and deletion frees capacity',async()=>{
    const user=(await db.query<{id:number}>("INSERT INTO users(email,password_hash,first_name,last_name) VALUES($1,'x','Capacity','Test') RETURNING id",[`agent-${randomUUID()}@example.invalid`])).rows[0]!.id;users.push(user);
    await db.query("INSERT INTO agent_conversations(id,user_id,currency,timezone,language) SELECT gen_random_uuid(),$1,'CAD','UTC','auto' FROM generate_series(1,99)",[user]);
    const attempts=await Promise.allSettled([store.createConversation(user,settings),store.createConversation(user,settings)]);
    const accepted=attempts.filter(result=>result.status==='fulfilled');const refused=attempts.filter(result=>result.status==='rejected');
    assert.equal(accepted.length,1);assert.equal(refused.length,1);
    assert.equal((refused[0] as PromiseRejectedResult).reason.code,'agent_conversation_limit');
    assert.equal((refused[0] as PromiseRejectedResult).reason.status,409);
    const conversations=await store.listConversations(user);assert.equal(conversations.length,100);
    await store.deleteConversation(user,conversations[0]!.id);
    await store.createConversation(user,settings);assert.equal((await store.listConversations(user)).length,100);
  });
  test('history deletion cannot reset the hourly admission budget',async()=>{
    const user=(await db.query<{id:number}>("INSERT INTO users(email,password_hash,first_name,last_name) VALUES($1,'x','Rate','Test') RETURNING id",[`agent-${randomUUID()}@example.invalid`])).rows[0]!.id;users.push(user);
    await db.query('INSERT INTO agent_admissions(id,user_id) SELECT gen_random_uuid(),$1 FROM generate_series(1,19)',[user]);
    const c=await store.createConversation(user,settings);await store.beginTurn(user,c.id,{...settings,requestId:randomUUID(),content:'Twentieth'});await store.deleteConversations(user);
    const next=await store.createConversation(user,settings);
    await assert.rejects(store.beginTurn(user,next.id,{...settings,requestId:randomUUID(),content:'Twenty first'}),{code:'agent_rate_limited'});
  });
  test('the daily budget counts a rolling 24 hours per user, past the hourly window',async()=>{
    const user=(await db.query<{id:number}>("INSERT INTO users(email,password_hash,first_name,last_name) VALUES($1,'x','Daily','Test') RETURNING id",[`agent-${randomUUID()}@example.invalid`])).rows[0]!.id;users.push(user);
    await db.query("INSERT INTO agent_admissions(id,user_id,created_at) SELECT gen_random_uuid(),$1,now()-interval '25 hours' FROM generate_series(1,60)",[user]);
    const c=await store.createConversation(user,settings);
    const first=randomUUID();await store.beginTurn(user,c.id,{...settings,requestId:first,content:'Older than a day does not count'});
    await store.finishTurn(user,c.id,first,{text:'Noted.'});
    await db.query("INSERT INTO agent_admissions(id,user_id,created_at) SELECT gen_random_uuid(),$1,now()-interval '2 hours' FROM generate_series(1,59)",[user]);
    const refused=store.beginTurn(user,c.id,{...settings,requestId:randomUUID(),content:'Sixty first today'});
    await assert.rejects(refused,{code:'agent_daily_limit',status:429});
  });
  // The all-users daily budget is tested in agentAdmissionCapacity.test.ts, in
  // its own schema: here other test files change the shared count mid-test.
  test('concurrent confirmations with different nonces on one version write exactly one batch',async()=>{
    const s=await proposal();const rowIds=s.draft!.rows.map(r=>r.id);
    const before=Number((await db.query<{count:string}>('SELECT count(*) FROM transactions WHERE user_id=$1',[alice])).rows[0]!.count);
    const attempts=await Promise.allSettled([randomUUID(),randomUUID()].map(requestId=>store.confirmDraft(alice,s.conversation.id,{version:s.draft!.version,rowIds,requestId})));
    const accepted=attempts.filter(a=>a.status==='fulfilled');const refused=attempts.filter(a=>a.status==='rejected');
    assert.equal(accepted.length,1);assert.equal(refused.length,1);
    assert.equal((refused[0] as PromiseRejectedResult).reason.code,'agent_version_conflict');
    const after=Number((await db.query<{count:string}>('SELECT count(*) FROM transactions WHERE user_id=$1',[alice])).rows[0]!.count);
    assert.equal(after-before,rowIds.length);
    assert.equal((await db.query('SELECT id FROM agent_receipts WHERE conversation_id=$1',[s.conversation.id])).rowCount,1);
  });
  test('edits and confirmation wait for an active run in the conversation',async()=>{
    const s=await proposal();const runId=randomUUID();
    const count=async()=>(await db.query<{count:string}>('SELECT count(*) FROM transactions WHERE user_id=$1',[alice])).rows[0]!.count;const before=await count();
    await store.beginTurn(alice,s.conversation.id,{...settings,requestId:runId,content:'Fictional correction'});
    try {
      await assert.rejects(store.editDraft(alice,s.conversation.id,s.draft!.version,s.draft!.rows),{code:'agent_busy'});
      await assert.rejects(store.cancelDraft(alice,s.conversation.id,s.draft!.version),{code:'agent_busy'});
      await assert.rejects(store.confirmDraft(alice,s.conversation.id,{version:s.draft!.version,rowIds:[s.draft!.rows[0]!.id],requestId:randomUUID()}),{code:'agent_busy'});
      assert.equal(await count(),before);
    } finally {await store.cancelRun(alice,s.conversation.id,runId);}
  });
  test('undo after the database-clock window is refused and deletes nothing',async()=>{
    const s=await proposal();const receipt=(await store.confirmDraft(alice,s.conversation.id,{version:1,rowIds:s.draft!.rows.map(r=>r.id),requestId:randomUUID()})).receipts[0]!;
    await db.query("UPDATE agent_receipts SET undo_until=now()-interval '1 second' WHERE id=$1",[receipt.id]);
    await assert.rejects(store.undoReceipt(alice,receipt.id),{code:'agent_expired'});
    assert.equal((await db.query('SELECT id FROM transactions WHERE id=ANY($1::int[])',[receipt.transaction_ids])).rowCount,2);
  });
  test('undo after one saved transaction was deleted conflicts and deletes nothing',async()=>{
    const s=await proposal();const receipt=(await store.confirmDraft(alice,s.conversation.id,{version:1,rowIds:s.draft!.rows.map(r=>r.id),requestId:randomUUID()})).receipts[0]!;
    await db.query('DELETE FROM transactions WHERE id=$1',[receipt.transaction_ids[0]]);
    await assert.rejects(store.undoReceipt(alice,receipt.id),{code:'agent_undo_conflict'});
    assert.equal((await db.query('SELECT id FROM transactions WHERE id=ANY($1::int[])',[receipt.transaction_ids])).rowCount,1);
    assert.equal((await store.getConversation(alice,s.conversation.id)).receipts[0]!.undone_at,null);
  });
  test('model history excludes cancelled and failed user turns',async()=>{
    const c=await store.createConversation(bob,settings);
    const kept=randomUUID();await store.beginTurn(bob,c.id,{...settings,requestId:kept,content:'Fictional kept turn'});await store.finishTurn(bob,c.id,kept,{text:'Kept reply'});
    const cancelled=randomUUID();await store.beginTurn(bob,c.id,{...settings,requestId:cancelled,content:'Fictional cancelled turn'});await store.cancelRun(bob,c.id,cancelled);
    const failed=randomUUID();await store.beginTurn(bob,c.id,{...settings,requestId:failed,content:'Fictional failed turn'});await store.failTurn(bob,c.id,failed,'agent_provider_error');
    const next=randomUUID();const started=await store.beginTurn(bob,c.id,{...settings,requestId:next,content:'Fictional next turn'});
    assert.deepEqual(started.history.map(m=>m.content),['Fictional kept turn','Kept reply']);
    // The exact replay of the running turn is bounded the same way.
    const replay=await store.beginTurn(bob,c.id,{...settings,requestId:next,content:'Fictional next turn'});
    assert.deepEqual(replay.history.map(m=>m.content),['Fictional kept turn','Kept reply','Fictional next turn']);
    await store.cancelRun(bob,c.id,next);
  });
  test('a failed run keeps the counts the runtime reported, and stays null without them',async()=>{
    const c=await store.createConversation(bob,settings);
    const limited=randomUUID();await store.beginTurn(bob,c.id,{...settings,requestId:limited,content:'Fictional limited turn'});
    await store.failTurn(bob,c.id,limited,'agent_limit_exceeded',{inputTokens:24319,outputTokens:5392,toolCalls:8});
    const plain=randomUUID();await store.beginTurn(bob,c.id,{...settings,requestId:plain,content:'Fictional plain failure'});
    await store.failTurn(bob,c.id,plain,'agent_provider_error');
    const rows=(await db.query<{id:string;status:string;error_code:string;input_tokens:number|null;output_tokens:number|null;tool_calls:number|null}>('SELECT id,status,error_code,input_tokens,output_tokens,tool_calls FROM agent_runs WHERE id=ANY($1::uuid[])',[[limited,plain]])).rows;
    const byId=new Map(rows.map(r=>[r.id,r]));
    assert.deepEqual({...byId.get(limited)!,id:undefined},{id:undefined,status:'failed',error_code:'agent_limit_exceeded',input_tokens:24319,output_tokens:5392,tool_calls:8});
    assert.deepEqual({...byId.get(plain)!,id:undefined},{id:undefined,status:'failed',error_code:'agent_provider_error',input_tokens:null,output_tokens:null,tool_calls:null});
    // Values the columns cannot hold become null instead of failing the UPDATE and stranding the run as running.
    const oversized=randomUUID();await store.beginTurn(bob,c.id,{...settings,requestId:oversized,content:'Fictional oversized counts'});
    await store.failTurn(bob,c.id,oversized,'agent_limit_exceeded',{inputTokens:2_147_483_648,outputTokens:2_147_483_647,toolCalls:9});
    const row=(await db.query<{status:string;input_tokens:number|null;output_tokens:number|null;tool_calls:number|null}>('SELECT status,input_tokens,output_tokens,tool_calls FROM agent_runs WHERE id=$1',[oversized])).rows[0]!;
    assert.deepEqual({...row},{status:'failed',input_tokens:null,output_tokens:2147483647,tool_calls:null});
  });
  test('without a provider key, replays answer from saved state and new runs are refused',async()=>{
    const c=await store.createConversation(bob,settings);const requestId=randomUUID();const input={...settings,requestId,content:'Fictional replay'};
    await store.beginTurn(bob,c.id,input);await store.finishTurn(bob,c.id,requestId,{text:'Replay reply'});
    const replay=await store.beginTurn(bob,c.id,input,false);
    assert.equal(replay.started,false);assert.equal(replay.state.run!.id,requestId);
    const fresh=randomUUID();
    await assert.rejects(store.beginTurn(bob,c.id,{...input,requestId:fresh},false),{code:'agent_unavailable',status:503});
    assert.equal((await db.query('SELECT id FROM agent_admissions WHERE id=$1',[fresh])).rowCount,0);
  });
  test('expired drafts cannot confirm and expired leases cannot finish',async()=>{
    const s=await proposal();await db.query("UPDATE agent_drafts SET expires_at=now()-interval '1 second' WHERE conversation_id=$1",[s.conversation.id]);
    await assert.rejects(store.confirmDraft(alice,s.conversation.id,{version:1,rowIds:[s.draft!.rows[0]!.id],requestId:randomUUID()}),{code:'agent_expired'});
    const c=await store.createConversation(alice,settings);const id=randomUUID();await store.beginTurn(alice,c.id,{...settings,requestId:id,content:'Fictional'});
    await db.query("UPDATE agent_runs SET lease_until=now()-interval '1 second' WHERE id=$1",[id]);
    await assert.rejects(store.finishTurn(alice,c.id,id,{text:'late',proposedRows:[row()]}),{code:'agent_timeout'});
  });
});
