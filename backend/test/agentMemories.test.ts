import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { packageRoot } from '../utils/packageRoot';
import type { MemoryFields, MemoryProposalDraft, ConversationState } from '../services/agent/types';

const url = process.env.TEST_DATABASE_URL;
const schema = `memory_lifecycle_${randomUUID().replaceAll('-', '')}`;
if (url) { process.env.DATABASE_URL = url; process.env.DB_SCHEMA = schema; process.env.NODE_ENV = 'test'; }
describe('approved memory lifecycle', { skip: !url }, () => {
  let db: typeof import('../db/connection');
  let store: typeof import('../services/agent/store');
  let alice: number; let bob: number; let demo: number;
  const admin = new Pool({ connectionString: url });
  const settings = { currency: 'CAD', timezone: 'America/Toronto', language: 'auto' as const };
  const fields: MemoryFields = { kind: 'expense', text: 'Fictional rent', amount: '950.00', currency: 'CAD', cadence: 'month' };
  const draft = (text = fields.text): MemoryProposalDraft => ({action:'remember',kind:'expense',memory_id:null,expected_updated_at:null,before:null,after:{...fields,text}});
  const count = async () => Number((await db.query<{n:string}>('SELECT count(*) AS n FROM agent_memories WHERE user_id=$1',[alice])).rows[0]!.n);
  async function propose(d: MemoryProposalDraft = draft(), user=alice, id?:string) {
    id ??= (await store.createConversation(user, settings)).id;
    const requestId=randomUUID();
    await store.beginTurn(user,id,{...settings,requestId,content:'Fictional memory request'});
    return store.finishTurn(user,id,requestId,{text:'Review this fact.',memoryProposal:d});
  }
  const confirm = (s:ConversationState,user=alice,requestId=randomUUID()) => store.confirmMemoryProposal(user,s.conversation.id,{proposalId:s.memoryProposal!.id,requestId});
  async function change(s:ConversationState,action:'update'|'forget'):Promise<MemoryProposalDraft> {
    const fact=(await store.getMemories(alice)).memories.find(f=>f.id===s.memoryProposal!.result_memory_id)!;
    return {action,kind:fact.kind,memory_id:fact.id,expected_updated_at:fact.version,before:{...fields,text:fact.text},after:action==='forget'?null:{...fields,text:'Updated fictional rent'}};
  }
  before(async()=>{
    const setup=await admin.connect();
    try { await setup.query(`CREATE SCHEMA ${schema}`);await setup.query(`SET search_path TO ${schema}`);await setup.query(readFileSync(path.join(packageRoot(__dirname),'db/schema.sql'),'utf8')); }
    finally { setup.release(); }
    db=require('../db/connection');store=require('../services/agent/store');
  });
  beforeEach(async()=>{
    await db.query('DELETE FROM users');
    const users=await db.query<{id:number}>("INSERT INTO users(email,password_hash,first_name,last_name) VALUES ('alice@example.invalid','x','Alice','Test'),('bob@example.invalid','x','Bob','Test'),('demo@example.invalid','x','Demo','Test') RETURNING id");
    [alice,bob,demo]=users.rows.map(r=>r.id) as [number,number,number];
    await db.query('UPDATE users SET is_demo=true WHERE id=$1',[demo]);
  });
  after(async()=>{if(db)await db.getPool().end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
  test('a proposal persists without saving a fact; explicit confirmation and retries save exactly once',async()=>{
    const s=await propose();assert.equal(s.memoryProposal?.status,'pending');assert.equal(await count(),0);
    const requestId=randomUUID();const saved=await confirm(s,alice,requestId);assert.equal(saved.memoryProposal!.status,'confirmed');assert.equal(await count(),1);
    assert.equal((await confirm(s,alice,requestId)).memoryProposal!.result_memory_id,saved.memoryProposal!.result_memory_id);
    assert.equal(await count(),1);
    const next=await propose(draft('Another'));await assert.rejects(confirm(next,alice,requestId),{code:'agent_request_conflict'});
    await assert.rejects(confirm(s),{code:'agent_version_conflict'});
  });
  test('concurrent confirmations and cap admissions are serialized per owner',async()=>{
    const s=await propose();const requestId=randomUUID();await Promise.all([confirm(s,alice,requestId),confirm(s,alice,requestId)]);assert.equal(await count(),1);
    const other=await propose();const both=await Promise.allSettled([confirm(other),confirm(other)]);assert.equal(both.filter(r=>r.status==='fulfilled').length,1);
    await db.query("INSERT INTO agent_memories(id,user_id,kind,text) SELECT gen_random_uuid(),$1,'other','Fictional seed' FROM generate_series(1,27)",[alice]);
    const a=await propose(draft('Cap A'));const b=await propose(draft('Cap B'));
    const attempts=await Promise.allSettled([confirm(a),confirm(b)]);assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(await count(),30);
    const rejected=attempts.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(rejected.reason.code,'agent_memory_full');
    const full=await propose(draft('Full'));const req=randomUUID();await assert.rejects(confirm(full,alice,req),{code:'agent_memory_full'});await assert.rejects(confirm(full,alice,req),{code:'agent_memory_full'});
    const p=(await store.getConversation(alice,full.conversation.id)).memoryProposal!;assert.equal(p.status,'conflict');assert.equal(p.after,null);assert.ok(p.redacted_at);
    const saved=await store.getConversation(alice,s.conversation.id);await confirm(await propose(await change(saved,'update')));assert.equal(await count(),30);
    await confirm(await propose(await change(saved,'forget')));assert.equal(await count(),29);
  });
  test('a kind-changing update changes the stored kind, and the next turn recalls the new version',async()=>{
    const saved=await confirm(await propose());const d=await change(saved,'update');
    const reserve:MemoryProposalDraft={...d,kind:'reserve',after:{kind:'reserve',text:'Keep 950 in chequing',amount:'950.00',currency:'CAD',cadence:null}};
    const s=await propose(reserve);assert.equal(s.memoryProposal!.kind,'reserve');
    await confirm(s);
    const facts=(await store.getMemories(alice)).memories;assert.equal(facts.length,1);
    assert.equal(facts[0]!.kind,'reserve');assert.equal(facts[0]!.cadence,null);assert.notEqual(facts[0]!.version,d.expected_updated_at);
    const begun=await store.beginTurn(alice,s.conversation.id,{...settings,requestId:randomUUID(),content:'What is my reserve?'});
    assert.deepEqual(begun.memories!.map(f=>[f.id,f.kind,f.version]),[[facts[0]!.id,'reserve',facts[0]!.version]]);
    assert.equal(begun.state.memoryProposal!.status,'confirmed');
  });
  test('the tool reads the owned fact through the real database and writes nothing',async()=>{
    const {prepareMemoryProposal}=require('../services/agent/memory') as typeof import('../services/agent/memory');
    const saved=await confirm(await propose());const fact=(await store.getMemories(alice)).memories[0]!;
    const before=(await db.query('SELECT count(*) AS n FROM agent_memory_proposals')).rows[0];
    const update=await prepareMemoryProposal(alice,{action:'update',memory_id:fact.id,expected_updated_at:fact.version,amount:'1000'});
    assert.equal(update.after!.amount,'1000.00');assert.deepEqual(update.before,{...fields});
    await assert.rejects(prepareMemoryProposal(bob,{action:'forget',memory_id:fact.id,expected_updated_at:fact.version}),{code:'agent_memory_not_found'});
    await assert.rejects(prepareMemoryProposal(alice,{action:'forget',memory_id:fact.id,expected_updated_at:'2000-01-01 00:00:00.000000'}),{code:'agent_memory_conflict'});
    await assert.rejects(prepareMemoryProposal(demo,{action:'remember',kind:'other',text:'x'}),{code:'agent_memory_demo'});
    assert.deepEqual((await db.query('SELECT count(*) AS n FROM agent_memory_proposals')).rows[0],before);assert.equal(saved.memoryProposal!.status,'confirmed');
  });
  test('stale, missing and foreign facts cannot be changed; conflict remains redacted and replayable',async()=>{
    const saved=await confirm(await propose());const d=await change(saved,'update');const s=await propose(d);
    await db.query("UPDATE agent_memories SET text='Changed elsewhere' WHERE id=$1",[d.memory_id]);
    const requestId=randomUUID();await assert.rejects(confirm(s,alice,requestId),{code:'agent_memory_conflict'});await assert.rejects(confirm(s,alice,requestId),{code:'agent_memory_conflict'});
    const p=(await store.getConversation(alice,s.conversation.id)).memoryProposal!;assert.equal(p.before,null);assert.equal(p.after,null);
    const foreign=await propose(await change(saved,'update'),bob);assert.equal(foreign.memoryProposal,null);
    await assert.rejects(confirm(saved,bob),{code:'agent_not_found'});
    await assert.rejects(store.cancelMemoryProposal(bob,s.conversation.id,s.memoryProposal!.id),{code:'agent_not_found'});
    const missing=await propose(await change(saved,'forget'));await db.query('DELETE FROM agent_memories WHERE id=$1',[d.memory_id]);await assert.rejects(confirm(missing),{code:'agent_memory_conflict'});
  });
  test('replacement, cancellation and expiry erase proposal bodies',async()=>{
    const first=await propose(draft('First offer secret'));const second=await propose(draft('Reworded offer secret'),alice,first.conversation.id);
    await assert.rejects(confirm(first),{code:'agent_version_conflict'});
    const old=(await db.query('SELECT * FROM agent_memory_proposals WHERE id=$1',[first.memoryProposal!.id])).rows[0]!;assert.equal(old.status,'superseded');assert.equal(old.after,null);assert.ok(old.redacted_at);
    const cancelled=await store.cancelMemoryProposal(alice,second.conversation.id,second.memoryProposal!.id);assert.equal(cancelled.memoryProposal!.status,'cancelled');assert.equal(cancelled.memoryProposal!.after,null);
    const expired=await propose();await db.query("UPDATE agent_memory_proposals SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.memoryProposal!.id]);
    const read=await store.getConversation(alice,expired.conversation.id);assert.equal(read.memoryProposal!.status,'expired');assert.equal(read.memoryProposal!.after,null);
    await assert.rejects(confirm(expired),{code:'agent_expired'});
    await store.cleanupAgentData();const row=(await db.query('SELECT * FROM agent_memory_proposals WHERE id=$1',[expired.memoryProposal!.id])).rows[0]!;assert.equal(row.status,'expired');assert.equal(row.after,null);
    await db.query("UPDATE agent_memory_proposals SET decided_at=now()-interval '31 days' WHERE status<>'pending'");await store.cleanupAgentData();assert.equal((await db.query('SELECT * FROM agent_memory_proposals')).rowCount,0);
  });
  test('each forget path removes saved and proposal copies, including superseded rewordings',async()=>{
    for(const mode of ['single','confirm','all'] as const) {
      const first=await propose(draft('Secret original '+mode));const revised=await propose(draft('Secret revised '+mode),alice,first.conversation.id);const saved=await confirm(revised);const id=saved.memoryProposal!.result_memory_id!;
      const pending=await propose(await change(saved,'update'));
      if(mode==='single')await store.forgetMemories(alice,[id]);
      if(mode==='all')await store.forgetMemories(alice,'all');
      if(mode==='confirm') {const forgotten=await propose(await change(saved,'forget'));const req=randomUUID();await confirm(forgotten,alice,req);await confirm(forgotten,alice,req);}
      assert.equal(await count(),0);
      const rows=(await db.query('SELECT before,after FROM agent_memory_proposals WHERE user_id=$1',[alice])).rows;assert.ok(rows.every(r=>r.before===null&&r.after===null));
      await assert.rejects(confirm(pending),{code:mode==='all'?'agent_memory_proposal_gone':'agent_version_conflict'});
    }
  });
  test('forget all invalidates pending remember and old confirmations; single delete is owned',async()=>{
    const saved=await propose();const requestId=randomUUID();const s=await confirm(saved,alice,requestId);const pending=await propose();
    await assert.rejects(store.forgetMemories(bob,[s.memoryProposal!.result_memory_id!]),{code:'agent_memory_not_found'});
    await store.forgetMemories(alice,'all');await assert.rejects(confirm(saved,alice,requestId),{code:'agent_memory_proposal_gone'});await assert.rejects(confirm(pending),{code:'agent_memory_proposal_gone'});
    await assert.rejects(store.cancelMemoryProposal(alice,pending.conversation.id,pending.memoryProposal!.id),{code:'agent_memory_proposal_gone'});
  });
  test('conversation deletion preserves facts, clears provenance and never exposes another owner',async()=>{
    const saved=await confirm(await propose());await store.deleteConversation(alice,saved.conversation.id);
    const facts=await store.getMemories(alice);assert.equal(facts.memories.length,1);assert.equal(facts.memories[0]!.source_conversation_id,null);assert.equal((await store.getMemories(bob)).memories.length,0);
  });
  test('running or cancelled turns cannot bypass proposal confirmation gates',async()=>{
    const s=await propose();const run=randomUUID();await store.beginTurn(alice,s.conversation.id,{...settings,content:'Change',requestId:run});
    await assert.rejects(confirm(s),{code:'agent_busy'});await assert.rejects(store.cancelMemoryProposal(alice,s.conversation.id,s.memoryProposal!.id),{code:'agent_busy'});
    await store.cancelRun(alice,s.conversation.id,run);await assert.rejects(store.finishTurn(alice,s.conversation.id,run,{text:'Late',memoryProposal:draft()}),{code:'agent_cancelled'});
    assert.equal((await store.getConversation(alice,s.conversation.id)).memoryProposal!.id,s.memoryProposal!.id);
  });
  test('forgotten facts cannot be republished by a turn that was already running',async()=>{
    for(const action of ['update','forget'] as const) {
      const saved=await confirm(await propose());const d=await change(saved,action);const id=saved.conversation.id;const run=randomUUID();
      await store.beginTurn(alice,id,{...settings,requestId:run,content:'A fictional update'});
      await store.forgetMemories(alice,[d.memory_id!]);
      await store.finishTurn(alice,id,run,{text:'Reply without an outdated offer.',memoryProposal:d});
      const copies=(await db.query('SELECT before,after FROM agent_memory_proposals WHERE user_id=$1',[alice])).rows;
      assert.ok(copies.every(r=>r.before===null&&r.after===null));assert.equal(await count(),0);
    }
    const saved=await confirm(await propose());const run=randomUUID();await store.beginTurn(alice,saved.conversation.id,{...settings,requestId:run,content:'Remember another fact'});
    await store.forgetMemories(alice,'all');
    await assert.rejects(store.finishTurn(alice,saved.conversation.id,run,{text:'Late offer',memoryProposal:draft()}),{code:'agent_cancelled'});
    assert.equal((await db.query('SELECT id FROM agent_memory_proposals WHERE user_id=$1',[alice])).rowCount,0);
  });
  test('failed confirmation rolls back the fact and proposal together',async()=>{
    const s=await propose();
    await db.query("CREATE FUNCTION reject_memory_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fictional failure'; END $$");
    await db.query("CREATE TRIGGER reject_memory_confirmation BEFORE UPDATE ON agent_memory_proposals FOR EACH ROW WHEN (NEW.status='confirmed') EXECUTE FUNCTION reject_memory_confirmation()");
    try {await assert.rejects(confirm(s));assert.equal(await count(),0);assert.equal((await store.getConversation(alice,s.conversation.id)).memoryProposal!.status,'pending');}
    finally {await db.query('DROP TRIGGER reject_memory_confirmation ON agent_memory_proposals');await db.query('DROP FUNCTION reject_memory_confirmation()');}
  });
  test('saved dates use requested timezone and facts remain in creation order',async()=>{
    await db.query("INSERT INTO agent_memories(id,user_id,kind,text,created_at,updated_at) VALUES($1,$2,'other','Earlier','2026-10-20T00:00:00Z','2026-10-23T01:00:00Z'),($3,$2,'other','Later','2026-10-21T00:00:00Z','2026-10-23T01:00:00Z')",[randomUUID(),alice,randomUUID()]);
    const local=(await store.getMemories(alice,'America/Toronto')).memories;assert.deepEqual(local.map(f=>f.text),['Earlier','Later']);assert.equal(local[0]!.saved_on,'2026-10-22');assert.equal(local[0]!.version,'2026-10-23 01:00:00.000000');
    assert.equal((await store.getMemories(alice,'Asia/Shanghai')).memories[0]!.saved_on,'2026-10-23');
  });
  test('demo cannot publish or confirm memory and reads no facts',async()=>{
    await db.query("INSERT INTO agent_memories(id,user_id,kind,text) VALUES($1,$2,'other','Hidden demo fact')",[randomUUID(),demo]);
    assert.deepEqual((await store.getMemories(demo)).memories,[]);
    // A demo turn's offer is dropped and its reply kept, as before 022.
    const dropped=await propose(draft(),demo);assert.equal(dropped.memoryProposal,null);assert.equal(dropped.messages.at(-1)!.content,'Review this fact.');
    assert.equal((await db.query('SELECT id FROM agent_memory_proposals WHERE user_id=$1',[demo])).rowCount,0);
    const begun=await store.beginTurn(demo,dropped.conversation.id,{...settings,requestId:randomUUID(),content:'Fictional demo turn'});assert.equal(begun.memories,undefined);
    const s=await propose();await db.query('UPDATE users SET is_demo=false WHERE id=$1',[demo]);await db.query('UPDATE users SET is_demo=true WHERE id=$1',[alice]);
    await assert.rejects(confirm(s),{code:'agent_memory_demo',status:403});
  });
});
