import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import config = require('../config');
import store = require('../services/agent/store');
import runtime = require('../services/agent/runtime');
import { AgentError } from '../services/agent/types';
import agentRoutes = require('../routes/agent');
import db = require('../db/connection');
const app = express(); app.use(express.json()); app.use('/agent', agentRoutes);
const conversationId = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';
const secret = 'fictional-agent-route-secret';
const token = jwt.sign({ userId: 77, email: 'fictional@example.invalid' }, secret);
const originalSecret = config.jwt.secret;
let originalAgent: typeof config.agent;
const body = { requestId, content: '昨天买菜三十八块五', currency: 'CAD', timezone: 'America/Toronto', language: 'auto' };
const state = { conversation: {id:conversationId,currency:'CAD',timezone:'America/Toronto',language:'auto'}, messages:[], draft:null,receipts:[],run:{id:requestId,status:'complete',error_code:null},goalProposal:null };
let financialWrites: number; let printed: unknown[][];
beforeEach(() => {
  originalAgent = {...config.agent}; config.agent.enabled = true; config.agent.apiKey = 'fictional-not-used'; config.jwt.secret = secret;
  financialWrites = 0; printed = [];
  mock.method(console, 'error', (...args:unknown[]) => printed.push(args));
  // Mirrors the store contract: a new run is refused when it cannot start.
  mock.method(store, 'beginTurn', async (_user:number,_id:string,_input:unknown,canStart=true) => { if(!canStart) throw new AgentError('agent_unavailable',503); return { started:true,state,history:[],pendingRows:[] }; });
  mock.method(store, 'assertRunActive', async () => {});
  mock.method(store, 'finishTurn', async () => state);
  mock.method(store, 'failTurn', async () => state);
  mock.method(store, 'cancelRun', async () => state);
  mock.method(store, 'confirmDraft', async () => { financialWrites++; return state; });
  mock.method(runtime, 'runAgent', async () => ({ text:'Please review the draft.',usage:{inputTokens:10,outputTokens:8},toolCalls:1 }));
});
afterEach(() => { Object.assign(config.agent,originalAgent); config.jwt.secret=originalSecret; mock.restoreAll(); });
const post = (payload:object=body) => request(app).post(`/agent/conversations/${conversationId}/messages`).auth(token,{type:'bearer'}).send(payload);
test('status and conversation routes require login', async () => {
  assert.equal((await request(app).get('/agent/status')).status,401);
  assert.equal((await request(app).post('/agent/conversations').send({})).status,401);
});
test('disabled agent does not touch persistence or runtime', async () => {
  config.agent.enabled=false;
  mock.method(store,'beginTurn',async()=>assert.fail('database queried'));
  assert.deepEqual((await request(app).get('/agent/status').auth(token,{type:'bearer'})).body,{available:false,storage:false});
  const res=await post();assert.equal(res.status,503);assert.equal(res.body.code,'agent_unavailable');
});
test('conversational agreement never invokes financial confirmation',async()=>{
  for(const content of ['yes','okay','好的']) assert.equal((await post({...body,content})).status,200);
  assert.equal(financialWrites,0);
});
test('identity comes from login, never from request or model',async()=>{
  let seen=false;
  mock.method(store,'beginTurn',async(userId:number,id:string)=>{assert.equal(userId,77);assert.equal(id,conversationId);seen=true;return {started:true,state,history:[],pendingRows:[]};});
  assert.equal((await post()).status,200);assert.equal(seen,true);
  assert.equal((await post({...body,user_id:99})).status,400);
});
test('malformed IDs, preferences and messages fail before admission',async()=>{
  mock.method(store,'beginTurn',async()=>assert.fail('admitted invalid input'));
  for(const invalid of [{...body,requestId:'no'},{...body,content:''},{...body,content:'x'.repeat(4001)},{...body,timezone:'No/SuchZone'},{...body,currency:'XYZ'},{...body,language:'fr'}])assert.equal((await post(invalid)).status,400);
});
test('input is typed by default, voice only when asked, and anything else fails before admission',async()=>{
  const seen:unknown[]=[];
  mock.method(runtime,'runAgent',async(input:{dictated?:boolean})=>{seen.push(input.dictated);return {text:'Please review the draft.',usage:{inputTokens:1,outputTokens:1},toolCalls:0};});
  for(const payload of [body,{...body,input:'typed'},{...body,input:'voice'}]) assert.equal((await post(payload)).status,200);
  assert.deepEqual(seen,[false,false,true]);
  mock.method(store,'beginTurn',async()=>assert.fail('admitted invalid input'));
  for(const input of ['dictated','VOICE',true,null,1]) assert.equal((await post({...body,input})).status,400);
});
test('exact replay does not call provider again',async()=>{
  mock.method(store,'beginTurn',async()=>({started:false,state,history:[],pendingRows:[]}));
  mock.method(runtime,'runAgent',async()=>assert.fail('duplicate provider call'));
  assert.equal((await post()).status,200);
});
test('provider errors remain safe and never confirm writes',async()=>{
  mock.method(runtime,'runAgent',async()=>{throw new Error('secret financial description and credential');});
  const res=await post();assert.equal(res.status,502);assert.equal(res.body.code,'agent_provider_error');
  assert.doesNotMatch(JSON.stringify([res.body,printed]),/secret financial|credential/);assert.equal(financialWrites,0);
});
test('other-user resources keep indistinguishable not-found response',async()=>{
  mock.method(store,'beginTurn',async()=>{throw new AgentError('agent_not_found',404);});
  assert.equal((await post()).status,404);
});
test('confirmation accepts only reviewed version, selection and nonce',async()=>{
  const url=`/agent/conversations/${conversationId}/confirm`;const good={version:1,rowIds:[requestId],requestId};
  assert.equal((await request(app).post(url).auth(token,{type:'bearer'}).send({...good,amount:'900.00'})).status,400);assert.equal(financialWrites,0);
  assert.equal((await request(app).post(url).auth(token,{type:'bearer'}).send(good)).status,200);assert.equal(financialWrites,1);
});
test('confirmation forwards the reviewed edits with server-derived identity',async()=>{
  const rows=[{id:requestId,amount:'18.50',description:'Fictional lunch',category:'Dining Out',type:'expense',date:'2026-10-25',currency:'CAD'}];
  let received:unknown;
  mock.method(store,'confirmDraft',async(userId:number,id:string,input:unknown)=>{received={userId,id,input};return state;});
  const body={version:1,rowIds:[requestId],requestId,rows};
  const res=await request(app).post(`/agent/conversations/${conversationId}/confirm`).auth(token,{type:'bearer'}).send(body);
  assert.equal(res.status,200);
  assert.deepEqual(received,{userId:77,id:conversationId,input:body});
});
test('saved history remains readable when only the provider key is missing',async()=>{
  config.agent.apiKey=undefined;
  mock.method(store,'getConversation',async()=>state);
  assert.equal((await request(app).get(`/agent/conversations/${conversationId}`).auth(token,{type:'bearer'})).status,200);
  const refused=await post();assert.equal(refused.status,503);assert.equal(refused.body.code,'agent_unavailable');
});
test('status distinguishes storage from model availability',async()=>{
  const status=async()=>(await request(app).get('/agent/status').auth(token,{type:'bearer'})).body;
  assert.deepEqual(await status(),{available:true,storage:true});
  config.agent.apiKey=undefined;assert.deepEqual(await status(),{available:false,storage:true});
  config.agent.enabled=false;config.agent.apiKey='fictional-not-used';assert.deepEqual(await status(),{available:false,storage:false});
});
test('an exact replay returns saved state even when the provider key is missing',async()=>{
  config.agent.apiKey=undefined;let canStartSeen:boolean|undefined;
  mock.method(store,'beginTurn',async(_user:number,_id:string,_input:unknown,canStart:boolean)=>{canStartSeen=canStart;return {started:false,state,history:[],pendingRows:[]};});
  mock.method(runtime,'runAgent',async()=>assert.fail('provider called without a key'));
  const res=await post();assert.equal(res.status,200);assert.equal(res.body.run.id,requestId);assert.equal(canStartSeen,false);
});
test('explicit cancellation aborts a running provider and never publishes its draft',async()=>{
  let announce:()=>void=()=>{};const entered=new Promise<void>(resolve=>{announce=resolve;});
  mock.method(runtime,'runAgent',async(input:runtime.AgentInput)=>{announce();return new Promise<runtime.AgentResult>((_resolve,reject)=>input.signal.addEventListener('abort',()=>reject(new AgentError('agent_cancelled',409)),{once:true}));});
  mock.method(store,'finishTurn',async()=>assert.fail('late proposal persisted'));
  const pending=post().then(res=>res);await entered;
  const cancelled=await request(app).post(`/agent/conversations/${conversationId}/runs/${requestId}/cancel`).auth(token,{type:'bearer'});
  assert.equal(cancelled.status,200);assert.equal((await pending).body.code,'agent_cancelled');assert.equal(financialWrites,0);
});
test('application deadline aborts a provider and persists a safe timeout',async()=>{
  config.agent.timeoutMs=25;let failed='';
  mock.method(runtime,'runAgent',async(input:runtime.AgentInput)=>new Promise<runtime.AgentResult>((_resolve,reject)=>input.signal.addEventListener('abort',()=>reject(new AgentError('agent_cancelled',409)),{once:true})));
  mock.method(store,'failTurn',async(_user:number,_conversation:string,_run:string,code:string)=>{failed=code;return state;});
  const result=await post();assert.equal(result.status,504);assert.equal(failed,'agent_timeout');assert.equal(financialWrites,0);
});
test('a runtime limit persists the failed run with the counts it used, and answers only the code',async()=>{
  let failed:unknown[]=[];
  mock.method(runtime,'runAgent',async()=>{throw new AgentError('agent_limit_exceeded',429,{inputTokens:24000,outputTokens:900,toolCalls:3});});
  mock.method(store,'failTurn',async(...args:unknown[])=>{failed=args.slice(3);return state;});
  const result=await post();assert.equal(result.status,429);assert.deepEqual(result.body,{error:'agent_limit_exceeded',code:'agent_limit_exceeded'});
  assert.deepEqual(failed,['agent_limit_exceeded',{inputTokens:24000,outputTokens:900,toolCalls:3}]);assert.equal(financialWrites,0);
});
test('the route deadline keeps the counts the runtime reported',async()=>{
  config.agent.timeoutMs=25;let failed:unknown[]=[];
  mock.method(runtime,'runAgent',async(input:runtime.AgentInput)=>new Promise<runtime.AgentResult>((_resolve,reject)=>input.signal.addEventListener('abort',()=>reject(new AgentError('agent_cancelled',409,{inputTokens:9000,outputTokens:300,toolCalls:2})),{once:true})));
  mock.method(store,'failTurn',async(...args:unknown[])=>{failed=args.slice(3);return state;});
  const result=await post();assert.equal(result.status,504);
  assert.deepEqual(failed,['agent_timeout',{inputTokens:9000,outputTokens:300,toolCalls:2}]);assert.equal(financialWrites,0);
});
test('a full process answers agent_busy to the slot\'s own user, agent_server_busy to others, and releases the slot after cancellation',async()=>{
  config.agent.maxConcurrentRuns=1;
  let announce:()=>void=()=>{};const entered=new Promise<void>(resolve=>{announce=resolve;});
  mock.method(runtime,'runAgent',async(input:runtime.AgentInput)=>{announce();return new Promise<runtime.AgentResult>((_resolve,reject)=>input.signal.addEventListener('abort',()=>reject(new AgentError('agent_cancelled',409)),{once:true}));});
  const pending=post().then(res=>res);await entered;
  // The slot is this user's own turn: the same answer beginTurn gives, not "server busy".
  const own=await post();assert.equal(own.status,409);assert.equal(own.body.code,'agent_busy');
  const other=jwt.sign({ userId: 78, email: 'other@example.invalid' }, secret);
  const full=await request(app).post(`/agent/conversations/${conversationId}/messages`).auth(other,{type:'bearer'}).send(body);
  assert.equal(full.status,429);assert.equal(full.body.code,'agent_server_busy');
  await request(app).post(`/agent/conversations/${conversationId}/runs/${requestId}/cancel`).auth(token,{type:'bearer'});await pending;
  mock.method(runtime,'runAgent',async()=>({text:'Ready',usage:{inputTokens:1,outputTokens:1},toolCalls:0}));assert.equal((await post()).status,200);
});
test('record tools are bound to the login user, never to anything the request carries',async()=>{
  const bound:unknown[]=[];
  mock.method(db,'query',async(_text:string,params:unknown[])=>{bound.push(params[0]);return {rowCount:0,rows:[]};});
  mock.method(runtime,'runAgent',async(input:runtime.AgentInput)=>{
    await input.records.spendingSummary({start:'2026-09-01',end_exclusive:'2026-10-15',currency:'CAD'});
    await input.records.transactionDetails({start:'2026-09-01',end_exclusive:'2026-10-15'});
    return {text:'Ready',usage:{inputTokens:1,outputTokens:1},toolCalls:2};
  });
  // A forged identity in the body is refused by the allowlist before anything runs.
  assert.equal((await post({...body,userId:99})).status,400);
  assert.deepEqual(bound,[]);
  assert.equal((await post()).status,200);
  assert.deepEqual(bound,[77,77]);
});
test('goal proposal confirm and cancel accept only their keys and bind the login user',async()=>{
  const proposalId='00000000-0000-4000-8000-000000000003';
  const seen:unknown[]=[];
  mock.method(store,'confirmGoalProposal',async(userId:number,id:string,input:unknown)=>{seen.push(['confirm',userId,id,input]);return state;});
  mock.method(store,'cancelGoalProposal',async(userId:number,id:string,proposal:string)=>{seen.push(['cancel',userId,id,proposal]);return state;});
  const confirm=(payload:object)=>request(app).post(`/agent/conversations/${conversationId}/goal-proposal/confirm`).auth(token,{type:'bearer'}).send(payload);
  const cancel=(payload:object)=>request(app).delete(`/agent/conversations/${conversationId}/goal-proposal`).auth(token,{type:'bearer'}).send(payload);
  for(const bad of [{proposalId,requestId,userId:99},{proposalId,requestId,target_amount:'9999.00'},{proposalId},{requestId},{proposalId:'nope',requestId}]) assert.equal((await confirm(bad)).status,400);
  for(const bad of [{proposalId,requestId},{},{proposalId:'nope'}]) assert.equal((await cancel(bad)).status,400);
  assert.deepEqual(seen,[]);
  assert.equal((await request(app).post(`/agent/conversations/${conversationId}/goal-proposal/confirm`).send({proposalId,requestId})).status,401);
  assert.equal((await confirm({proposalId,requestId})).status,200);
  assert.equal((await cancel({proposalId})).status,200);
  assert.deepEqual(seen,[['confirm',77,conversationId,{proposalId,requestId}],['cancel',77,conversationId,proposalId]]);
});
test('goal proposal buttons work without a provider key but not without storage',async()=>{
  const proposalId='00000000-0000-4000-8000-000000000003';
  mock.method(store,'confirmGoalProposal',async()=>state);
  config.agent.apiKey=undefined;
  assert.equal((await request(app).post(`/agent/conversations/${conversationId}/goal-proposal/confirm`).auth(token,{type:'bearer'}).send({proposalId,requestId})).status,200);
  config.agent.enabled=false;
  mock.method(store,'confirmGoalProposal',async()=>assert.fail('storage touched while disabled'));
  const off=await request(app).post(`/agent/conversations/${conversationId}/goal-proposal/confirm`).auth(token,{type:'bearer'}).send({proposalId,requestId});
  assert.equal(off.status,503);assert.equal(off.body.code,'agent_unavailable');
});
test('goal conflicts surface as stable codes',async()=>{
  mock.method(store,'confirmGoalProposal',async()=>{throw new AgentError('agent_goal_conflict',409);});
  const res=await request(app).post(`/agent/conversations/${conversationId}/goal-proposal/confirm`).auth(token,{type:'bearer'}).send({proposalId:'00000000-0000-4000-8000-000000000003',requestId});
  assert.equal(res.status,409);assert.deepEqual(res.body,{error:'agent_goal_conflict',code:'agent_goal_conflict'});
});
