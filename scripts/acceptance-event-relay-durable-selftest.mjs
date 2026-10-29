#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableInbox,attestSource} from './acceptance-event-relay-core.mjs';
import {processDueWebhook,retryDelay} from './acceptance-event-relay-worker.mjs';
import {resolveDurableWebhook,createRelay} from './acceptance-event-relay.mjs';

const repo='BestNathan/nession',sha='a'.repeat(40),secret='s'.repeat(40);
const live={id:48,run_attempt:1,name:'E2E / Tests',
  path:'.github/workflows/e2e-tests.yml',event:'push',head_branch:'main',
  head_sha:sha,status:'completed',conclusion:'success',
  repository:{full_name:repo},head_repository:{full_name:repo}};
const payload={action:'completed',repository:{full_name:repo},installation:{id:12},
  workflow_run:{...live}};
const raw=Buffer.from(JSON.stringify(payload));
const source=attestSource(payload,live);
const selected=[{issue:19,contract_digest:'b'.repeat(64)}];
const ids=Array.from({length:12},(_,i)=>
  '00000000-0000-4000-8000-'+String(i+100).padStart(12,'0'));
const tmp=mkdtempSync(join(tmpdir(),'acceptance-durable-inbox-'));
try{
  const file=join(tmp,'events.sqlite');
  let inbox=new DurableInbox(file);
  assert.equal(inbox.nextDeliveryAt(),null);
  assert.deepEqual(inbox.receive(ids[0],raw,'workflow_run',12,1000),{duplicate:false});
  assert.deepEqual(inbox.receive(ids[0],raw,'workflow_run',12,1001),{duplicate:true});
  assert.equal(inbox.nextDeliveryAt(),1000);
  assert.throws(()=>inbox.receive(ids[0],Buffer.from('{}'),'workflow_run',12,1002),/conflicting/);
  assert.throws(()=>inbox.receive(ids[1],raw,'issues',12),/envelope/);
  assert.equal(inbox.count(),0,'receiving a signed webhook must not dispatch or infer any SC');
  const claimed=inbox.claimDelivery(1000,10000);
  assert.equal(claimed.state,'processing');
  assert.equal(inbox.claimDelivery(1001,10000),null,'parallel selector cannot claim same event');
  assert.equal(inbox.nextDeliveryAt(),11000,'processing lease survives restart');
  inbox.close();
  inbox=new DurableInbox(file);
  assert.equal(inbox.claimDelivery(10999,10000),null);
  assert.equal(inbox.claimDelivery(11000,10000).id,ids[0],
    'interrupted selector is safely reclaimed after its read-only lease');
  assert.deepEqual(inbox.completeDelivery(ids[0],source,selected,11001),{added:1,eligible:1});
  assert.equal(inbox.getDelivery(ids[0]).state,'done');
  assert.equal(inbox.count(),1);
  assert.throws(()=>inbox.completeDelivery(ids[0],source,selected,11002),/untrusted claim/);
  inbox.receive(ids[1],raw,'workflow_run',12,12000);
  const none=await processDueWebhook(inbox,async()=>({source:null,eligible:[]}),
    {now:()=>12000});
  assert.equal(none.status,'done');
  assert.equal(inbox.count(),1,'no matching Issue -> no Actions transition');
  inbox.receive(ids[2],raw,'workflow_run',12,13000);
  const retry=await processDueWebhook(inbox,async()=>{
    throw Object.assign(Error('HTTP 429'),{retryAfterMs:150000});
  },{now:()=>13000});
  assert.equal(retry.status,'retry');
  assert.equal(inbox.getDelivery(ids[2]).state,'received');
  assert.ok(inbox.getDelivery(ids[2]).next_at>=163000);
  inbox.close();
  inbox=new DurableInbox(file);
  assert.equal(inbox.claimDelivery(162999),null);
  const due=inbox.getDelivery(ids[2]).next_at;
  const recovered=await processDueWebhook(inbox,async()=>({source,eligible:selected}),
    {now:()=>due});
  assert.equal(recovered.status,'done');
  assert.equal(recovered.added,0,'duplicate source/Issue/contract converges');
  inbox.receive(ids[3],raw,'workflow_run',12,200000);
  const invalid=await processDueWebhook(inbox,async()=>({source:null,eligible:selected}),
    {now:()=>200000});
  assert.equal(invalid.status,'retry','missing source must never produce work');
  assert.equal(inbox.count(),1);
  assert.equal(retryDelay(1,300000),300000,'Retry-After is honored');
  assert.equal(retryDelay(12,1e12),86400000,'retry delay is bounded');
  assert.throws(()=>createRelay({ACCEPTANCE_RELAY_MODE:'live'}),/shadow-only/);
  // Live readback must bind the exact stored source identity; no Issue API
  // calls when a fully authenticated completed Run is inapplicable.
  const ignored=await resolveDurableWebhook({...payload,workflow_run:{...live,conclusion:'failure'}},
    {event_name:'workflow_run',installation_id:12},
    async(path)=>{assert.match(path,/actions\/runs\/48$/);return live});
  assert.deepEqual(ignored,{source:null,eligible:[]});
  inbox.close();
}catch(err){throw err}finally{rmSync(tmp,{force:true,recursive:true})}
