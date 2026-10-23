import {test,beforeEach,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import db = require('../db/connection');
import store = require('../services/agent/store');
const id='00000000-0000-4000-8000-000000000001';
const proposalId='00000000-0000-4000-8000-000000000002',requestId='00000000-0000-4000-8000-000000000003';
let present=false,fail=false;let statements:string[],printed:unknown[];
beforeEach(()=>{
  statements=[];printed=[];
  mock.method(console,'error',(...args:unknown[])=>printed.push(args));
  const query=async(sql:string)=>{
    statements.push(sql);
    if(sql.includes('to_regclass'))return {rowCount:1,rows:[{present:sql.includes('agent_memories')&&present}]};
    if(sql.includes('agent_memory_proposals')) {
      assert.ok(present,'queried missing memory table');
      if(fail&&sql.startsWith('UPDATE'))throw Object.assign(new Error('Secret rent amount'),{code:'57014'});
      return {rowCount:0,rows:[]};
    }
    if(sql.includes('FROM users'))return {rowCount:1,rows:[{id:7,is_demo:false}]};
    if(sql.includes('FROM agent_conversations'))return {rowCount:1,rows:[{id,user_id:7,currency:'CAD',timezone:'UTC',language:'auto'}]};
    if(sql.includes('FROM agent_runs WHERE id=$1'))return {rowCount:1,rows:[{id:requestId,status:'running',lease_expired:false}]};
    if(sql.startsWith('DELETE FROM agent_drafts'))return {rowCount:2,rows:[]};
    return {rowCount:0,rows:[]};
  };
  mock.method(db,'query',query);mock.method(db,'getPool',()=>({connect:async()=>({query,release:()=>{}})}));
});
afterEach(()=>mock.restoreAll());
test('before 022 reads degrade, mutations refuse, finish drops memory and cleanup never touches missing tables',async()=>{
  assert.deepEqual(await store.getMemories(7),{available:false,memories:[]});assert.equal((await store.getConversation(7,id)).memoryProposal,null);
  await assert.rejects(store.forgetMemories(7,'all'),{code:'agent_unavailable',status:503});await assert.rejects(store.forgetMemories(7,[proposalId]),{code:'agent_unavailable'});
  await assert.rejects(store.confirmMemoryProposal(7,id,{proposalId,requestId}),{code:'agent_unavailable'});await assert.rejects(store.cancelMemoryProposal(7,id,proposalId),{code:'agent_unavailable'});
  const memoryProposal={action:'remember',kind:'expense',memory_id:null,expected_updated_at:null,before:null,after:{kind:'expense',text:'Fictional rent',amount:'950.00',currency:'CAD',cadence:'month'}};
  assert.equal((await store.finishTurn(7,id,requestId,{text:'Reply',memoryProposal})).memoryProposal,null);
  assert.equal(await store.cleanupAgentData(),2);assert.ok(!statements.some(s=>s.includes('agent_memory_proposals')));
});
test('022 becomes available without restart, and cleanup failures preserve other maintenance and safe logs',async()=>{
  present=true;assert.deepEqual(await store.getMemories(7),{available:true,memories:[]});
  fail=true;assert.equal(await store.cleanupAgentData(),2);
  assert.ok(statements.includes('ROLLBACK TO SAVEPOINT memory_proposals'));assert.equal(statements.at(-1),'COMMIT');
  assert.match(JSON.stringify(printed),/Agent memory proposal cleanup failed/);assert.doesNotMatch(JSON.stringify(printed),/Secret rent/);
});
