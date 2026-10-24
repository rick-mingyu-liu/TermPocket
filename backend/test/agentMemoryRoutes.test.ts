import {test,beforeEach,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import config = require('../config');
import store = require('../services/agent/store');
import routes = require('../routes/agent');
import {AgentError} from '../services/agent/types';
const app=express();app.use(express.json());app.use('/agent',routes);
const id='00000000-0000-4000-8000-000000000001',proposalId='00000000-0000-4000-8000-000000000002',requestId='00000000-0000-4000-8000-000000000003';
const secret='fictional-memory-route-secret',token=jwt.sign({userId:77,email:'fictional@example.invalid'},secret);
const oldSecret=config.jwt.secret;let oldAgent:typeof config.agent;let printed:unknown[];
beforeEach(()=>{oldAgent={...config.agent};config.agent.enabled=true;config.agent.apiKey='';config.jwt.secret=secret;printed=[];mock.method(console,'error',(...args:unknown[])=>printed.push(args));});
afterEach(()=>{Object.assign(config.agent,oldAgent);config.jwt.secret=oldSecret;mock.restoreAll();});
test('memory routes require JWT and feature storage, never a provider key',async()=>{
  mock.method(store,'getMemories',async(user:number)=>{assert.equal(user,77);return {available:true,memories:[]};});
  assert.equal((await request(app).get('/agent/memories')).status,401);
  const ok=await request(app).get('/agent/memories').auth(token,{type:'bearer'});assert.equal(ok.status,200);assert.equal(ok.headers['cache-control'],'no-store');
  config.agent.enabled=false;assert.equal((await request(app).get('/agent/memories').auth(token,{type:'bearer'})).status,503);
});
test('confirm only accepts proposal ID and nonce, binds server identity, cancellation only ID',async()=>{
  const url=`/agent/conversations/${id}/memory-proposal`;let writes=0;
  mock.method(store,'confirmMemoryProposal',async(user:number,conversation:string,input:unknown)=>{assert.equal(user,77);assert.equal(conversation,id);assert.deepEqual(input,{proposalId,requestId});writes++;return {};});
  mock.method(store,'cancelMemoryProposal',async(user:number,conversation:string,p:string)=>{assert.equal(user,77);assert.equal(conversation,id);assert.equal(p,proposalId);return {};});
  for(const body of [{proposalId},{proposalId,requestId,user_id:5},{proposalId,requestId,text:'injected'},{proposalId:'bad',requestId},{proposalId,requestId:1},{}])assert.equal((await request(app).post(url+'/confirm').auth(token,{type:'bearer'}).send(body)).status,400);
  assert.equal(writes,0);assert.equal((await request(app).post(url+'/confirm').auth(token,{type:'bearer'}).send({proposalId,requestId})).status,200);assert.equal(writes,1);
  assert.equal((await request(app).delete(url).auth(token,{type:'bearer'}).send({proposalId,text:'x'})).status,400);
  assert.equal((await request(app).delete(url).auth(token,{type:'bearer'}).send({proposalId})).status,200);
});
test('forget routes use only owned IDs and reject malformed ones before deletion',async()=>{
  const calls:unknown[]=[];mock.method(store,'forgetMemories',async(user:number,ids:unknown)=>{calls.push([user,ids]);});
  assert.equal((await request(app).delete('/agent/memories/bad').auth(token,{type:'bearer'})).status,400);
  assert.equal((await request(app).delete('/agent/memories/'+id).auth(token,{type:'bearer'})).status,200);
  assert.equal((await request(app).delete('/agent/memories').auth(token,{type:'bearer'})).status,200);assert.deepEqual(calls,[[77,[id]],[77,'all']]);
});
test('memory error responses preserve known codes and never log fact text',async()=>{
  for(const code of ['agent_unavailable','agent_memory_demo','agent_memory_proposal_gone']) {
    mock.method(store,'getMemories',async()=>{throw new AgentError(code,code==='agent_unavailable'?503:code==='agent_memory_demo'?403:404);});
    const res=await request(app).get('/agent/memories').auth(token,{type:'bearer'});assert.equal(res.body.code,code);
  }
  mock.method(store,'getMemories',async()=>{throw Object.assign(new Error('Private rent 950 CAD'),{code:'22001'});});
  const res=await request(app).get('/agent/memories').auth(token,{type:'bearer'});assert.equal(res.status,500);assert.doesNotMatch(JSON.stringify([res.body,printed]),/Private rent|950/);assert.match(JSON.stringify(printed),/22001/);
});
