import express, { type Request, type Response, type NextFunction } from 'express';
import auth = require('../middleware/auth');
import config = require('../config');
import logger = require('../utils/logger');
import { errorSummary } from '../utils/errorSummary';
import store = require('../services/agent/store');
import runtime = require('../services/agent/runtime');
import { recordsFor } from '../services/agent/investigation';
import { AgentError } from '../services/agent/types';
import { validateUuid, validateSettings, validateMessage } from '../services/agent/validation';
import { onAccountDeleted } from '../services/accountService';

const router = express.Router();
router.use(auth);
router.use((_req, res, next) => { res.setHeader('Cache-Control','no-store'); next(); });
const available = () => config.agent.enabled && Boolean(config.agent.apiKey);
router.get('/status', (_req,res) => { res.json({available:available(),storage:config.agent.enabled}); });
router.use((_req,_res,next) => { next(config.agent.enabled ? undefined : new AgentError('agent_unavailable',503)); });

// No background worker or polling: a request owns the model execution. PostgreSQL
// is the final admission/cancellation authority across processes. This map only
// bounds local model requests and makes local cancellation prompt.
const active = new Map<string,{userId:number;conversationId:string;controller:AbortController}>();
let slots = 0;
/** Slots held per user, from the moment one is taken: `active` is filled only once a run is admitted. */
const holders = new Map<number,number>();
const key = (userId:number,runId:string) => `${userId}:${runId}`;
function abortOwned(userId:number,conversationId?:string) {
  for (const run of active.values()) if (run.userId===userId && (!conversationId || run.conversationId===conversationId)) run.controller.abort();
}
// A deleted account's turns in this process stop now rather than at their next check.
onAccountDeleted((userId)=>abortOwned(userId));
function object(value:unknown, keys:string[]):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new AgentError('agent_invalid_input');
  const body=value as Record<string,unknown>;
  if(Object.keys(body).some(k=>!keys.includes(k))) throw new AgentError('agent_invalid_input');
  return body;
}
function version(value:unknown):number {
  if(typeof value!=='number' || !Number.isSafeInteger(value) || value<1) throw new AgentError('agent_invalid_input');
  return value;
}
function dayInZone(timezone:string):string {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const part=(name:string)=>parts.find(p=>p.type===name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function route(handler:(req:Request,res:Response)=>Promise<void>) {
  return (req:Request,res:Response,next:NextFunction) => { void handler(req,res).catch(next); };
}
// Memory changes are button-only server operations. No model execution is needed.
// ?timezone= dates each fact's saved_on in the viewer's zone (UTC when absent);
// the store answers a zone neither Intl nor PostgreSQL accepts with a 400.
router.get('/memories',route(async(req,res)=>{
  if(Object.keys(req.query).some(k=>k!=='timezone')) throw new AgentError('agent_invalid_input');
  res.json(await store.getMemories(req.user.userId,req.query.timezone??'UTC'));
}));
router.delete('/memories/:id',route(async(req,res)=>{
  await store.forgetMemories(req.user.userId,[validateUuid(req.params.id)]);res.json({deleted:true});
}));
router.delete('/memories',route(async(req,res)=>{
  await store.forgetMemories(req.user.userId,'all');abortOwned(req.user.userId);res.json({deleted:true});
}));
router.post('/conversations/:id/memory-proposal/confirm',route(async(req,res)=>{
  const body=object(req.body,['proposalId','requestId']);
  res.json(await store.confirmMemoryProposal(req.user.userId,validateUuid(req.params.id),{proposalId:validateUuid(body.proposalId),requestId:validateUuid(body.requestId)}));
}));
router.delete('/conversations/:id/memory-proposal',route(async(req,res)=>{
  const body=object(req.body,['proposalId']);
  res.json(await store.cancelMemoryProposal(req.user.userId,validateUuid(req.params.id),validateUuid(body.proposalId)));
}));
router.get('/conversations',route(async(req,res)=>{res.json({conversations:await store.listConversations(req.user.userId)});}));
router.post('/conversations',route(async(req,res)=>{
  const settings=validateSettings(object(req.body,['currency','timezone','language']));
  res.status(201).json({conversation:await store.createConversation(req.user.userId,settings)});
}));
router.delete('/conversations',route(async(req,res)=>{
  await store.deleteConversations(req.user.userId);abortOwned(req.user.userId);res.json({deleted:true});
}));
router.get('/conversations/:id',route(async(req,res)=>{res.json(await store.getConversation(req.user.userId,validateUuid(req.params.id)));}));
router.delete('/conversations/:id',route(async(req,res)=>{
  const id=validateUuid(req.params.id);await store.deleteConversation(req.user.userId,id);abortOwned(req.user.userId,id);res.json({deleted:true});
}));
router.post('/conversations/:id/messages',route(async(req,res)=>{
  const conversationId=validateUuid(req.params.id);const userId=req.user.userId;
  const body=object(req.body,['requestId','content','currency','timezone','language','input']);
  // How the message was entered: absent or 'typed' by default, 'voice' for the composer's dictation (docs/VOICE.md).
  if(body.input!==undefined && body.input!=='typed' && body.input!=='voice') throw new AgentError('agent_invalid_input');
  const input={requestId:validateUuid(body.requestId),content:validateMessage(body.content),...validateSettings(body)};
  // Every slot in this process is taken. When one of them is this user's own
  // turn (a second tab, a double send) that is agent_busy, as beginTurn would
  // say; only other users' turns make it agent_server_busy.
  if(slots>=config.agent.maxConcurrentRuns) throw holders.has(userId)?new AgentError('agent_busy',409):new AgentError('agent_server_busy',429);
  slots++;holders.set(userId,(holders.get(userId)??0)+1);
  const controller=new AbortController();let started=false;let timedOut=false;
  const close=()=>{if(!res.writableEnded) controller.abort();};res.on('close',close);
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},config.agent.timeoutMs);timer.unref();
  const runKey=key(userId,input.requestId);
  try {
    // Without a provider key an exact replay still returns saved state; only a
    // new run is refused, inside the same transaction that would admit it.
    const begin=await store.beginTurn(userId,conversationId,input,available());
    if(!begin.started) { res.json(begin.state);return; }
    started=true;active.set(runKey,{userId,conversationId,controller});
    if(controller.signal.aborted) throw new AgentError('agent_cancelled',409);
    await store.assertRunActive(userId,conversationId,input.requestId);
    const result=await runtime.runAgent({
      content:input.content,history:begin.history,pendingRows:begin.pendingRows,
      currency:input.currency,timezone:input.timezone,language:input.language,
      today:dayInZone(input.timezone),dictated:body.input==='voice',signal:controller.signal,
      assertActive:()=>store.assertRunActive(userId,conversationId,input.requestId),
      // Bound to the authenticated user here; no tool argument can name another.
      records:recordsFor(userId),
      // Every remembered fact and the latest offer, read when the run was
      // admitted (none for the demo account or before migration 022).
      memories:begin.memories,memoryProposal:begin.state.memoryProposal,
    });
    if(controller.signal.aborted) throw new AgentError(timedOut?'agent_timeout':'agent_cancelled',409);
    // finishTurn locks and rechecks the run; late output after a remote
    // cancellation or conversation deletion can never recreate state.
    const state=await store.finishTurn(userId,conversationId,input.requestId,result);
    if(!res.destroyed) res.json(state);
  } catch(error) {
    // The route's own deadline replaces the runtime's error but keeps the counts it carried.
    const failure=timedOut?new AgentError('agent_timeout',504,error instanceof AgentError?error.usage:undefined):controller.signal.aborted?new AgentError('agent_cancelled',409):error instanceof AgentError?error:new AgentError('agent_provider_error',502);
    if(started) {
      try {
        if(failure.code==='agent_cancelled') await store.cancelRun(userId,conversationId,input.requestId);
        else await store.failTurn(userId,conversationId,input.requestId,failure.code,failure.usage);
      } catch(persistError) {
        if(!(persistError instanceof AgentError && persistError.code==='agent_not_found')) logger.error('Agent terminal state failed',{userId,...errorSummary(persistError)});
      }
    }
    throw failure;
  } finally {
    clearTimeout(timer);res.off('close',close);if(started)active.delete(runKey);slots--;
    const held=(holders.get(userId)??1)-1;if(held>0)holders.set(userId,held);else holders.delete(userId);
  }
}));
router.post('/conversations/:id/runs/:runId/cancel',route(async(req,res)=>{
  const conversationId=validateUuid(req.params.id), runId=validateUuid(req.params.runId);
  await store.cancelRun(req.user.userId,conversationId,runId);
  const local=active.get(key(req.user.userId,runId));if(local?.conversationId===conversationId)local.controller.abort();
  res.json({cancelled:true});
}));
router.patch('/conversations/:id/draft',route(async(req,res)=>{
  const body=object(req.body,['version','rows']);
  res.json(await store.editDraft(req.user.userId,validateUuid(req.params.id),version(body.version),body.rows));
}));
router.delete('/conversations/:id/draft',route(async(req,res)=>{
  const body=object(req.body,['version']);res.json(await store.cancelDraft(req.user.userId,validateUuid(req.params.id),version(body.version)));
}));
router.post('/conversations/:id/confirm',route(async(req,res)=>{
  const body=object(req.body,['version','rowIds','requestId','rows']);
  if(!Array.isArray(body.rowIds)||body.rowIds.length===0||body.rowIds.length>config.agent.maxRows)throw new AgentError('agent_invalid_input');
  const rowIds=body.rowIds.map(validateUuid);if(new Set(rowIds).size!==rowIds.length)throw new AgentError('agent_invalid_input');
  res.json(await store.confirmDraft(req.user.userId,validateUuid(req.params.id),{version:version(body.version),rowIds,requestId:validateUuid(body.requestId),...(body.rows!==undefined?{rows:body.rows}:{})}));
}));
// Goal proposals: only these buttons create or change a savings goal. They need
// storage (AGENT_ENABLED) but not the provider key, like draft confirmation.
router.post('/conversations/:id/goal-proposal/confirm',route(async(req,res)=>{
  const body=object(req.body,['proposalId','requestId']);
  res.json(await store.confirmGoalProposal(req.user.userId,validateUuid(req.params.id),{proposalId:validateUuid(body.proposalId),requestId:validateUuid(body.requestId)}));
}));
router.delete('/conversations/:id/goal-proposal',route(async(req,res)=>{
  const body=object(req.body,['proposalId']);
  res.json(await store.cancelGoalProposal(req.user.userId,validateUuid(req.params.id),validateUuid(body.proposalId)));
}));
router.post('/receipts/:id/undo',route(async(req,res)=>{
  await store.undoReceipt(req.user.userId,validateUuid(req.params.id));res.json({undone:true});
}));
router.use((error:unknown,req:Request,res:Response,_next:NextFunction)=>{
  const known=error instanceof AgentError;
  if(!known)logger.error('Agent request failed',{userId:req.user.userId,...errorSummary(error)});
  if(!res.headersSent && !res.destroyed)res.status(known?error.status:500).json({error:known?error.code:'agent_request_failed',code:known?error.code:'agent_request_failed'});
});
export = router;
