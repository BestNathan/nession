#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableInbox} from './acceptance-event-relay-core.mjs';
import {selectFailedAppDeliveries,listAppDeliveries,requestAppRedelivery,
  auditFailedAppDeliveries,createWebhookRecovery} from './acceptance-webhook-recovery.mjs';

const now=Date.parse('2026-10-29T13:15:00Z');
const repoId=987,installationId=456;
const GUID=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const row=(n,opts={})=>({
  id:n,guid:GUID(n),repository_id:repoId,installation_id:installationId,
  event:'workflow_run',action:'completed',delivered_at:'2026-10-29T13:12:00Z',
  status:'Service Unavailable',status_code:503,...opts,
});
const failed=row(1);
const recovered=row(2,{status:'OK',status_code:202});
const repeatedlyFailed=row(3);
const repaired=row(4,{guid:GUID(3),status:'OK',status_code:202});
const wrongRepo=row(5,{repository_id:123});
const wrongApp=row(6,{installation_id:999});
const irrelevant=row(7,{event:'issues'});
const expired=row(8,{delivered_at:'2026-10-25T00:00:00Z'});
const rows=[failed,recovered,repeatedlyFailed,repaired,wrongRepo,wrongApp,
  irrelevant,expired];
const selected=selectFailedAppDeliveries(rows,{
  repositoryId:repoId,installationId,now});
assert.deepEqual(selected.map(x=>x.guid),[GUID(1)]);
assert.throws(()=>selectFailedAppDeliveries([row(9,{guid:'invalid'})],{
  repositoryId:repoId,installationId,now}),/malformed/);
assert.deepEqual(selectFailedAppDeliveries([row(10,{status:'OK',status_code:200})],{
  repositoryId:repoId,installationId,now}),[]);
assert.deepEqual(selectFailedAppDeliveries([row(11,{status_code:0})],{
  repositoryId:repoId,installationId,now}).map(x=>x.guid),[GUID(11)]);

const api='https://api.github.com/app/hook/deliveries';
const auth='test-jwt';
const twoPages=async(url,options)=>{
  assert.equal(options.method,'GET');
  assert.equal(options.headers.Authorization,'Bearer '+auth);
  if(url===api+'?per_page=100')
    return {ok:true,json:async()=>rows.slice(0,4),
      headers:{get:k=>k==='link'?
        '<'+api+'?per_page=100&cursor=next>; rel="next"':null}};
  if(url===api+'?per_page=100&cursor=next')
    return {ok:true,json:async()=>rows.slice(4),
      headers:{get:()=>null}};
  throw Error('unexpected URL '+url);
};
assert.equal((await listAppDeliveries(auth,twoPages,{now})).length,8);
await assert.rejects(()=>listAppDeliveries(auth,async()=>({
  ok:true,json:async()=>[failed],headers:{get:()=>'<https://evil.test/>; rel="next"'},
}),{now}),/untrusted/);
await assert.rejects(()=>listAppDeliveries(auth,async()=>({
  ok:true,json:async()=>[failed],
  headers:{get:()=>'<'+api+'?cursor=again>; rel="next"'},
}),{now,maxPages:1}),/bounded pagination/);
assert.equal(await requestAppRedelivery(auth,44,async(url,options)=>{
  assert.equal(url,api+'/44/attempts');
  assert.equal(options.method,'POST');
  return {status:202};
}),true);
assert.equal(await requestAppRedelivery(auth,44,async()=>({status:503})),false);
await assert.rejects(()=>requestAppRedelivery(auth,0,async()=>({status:202})),/invalid delivery/);

const dir=mkdtempSync(join(tmpdir(),'nession-app-webhook-'));
try{
  const file=join(dir,'app-deliveries.sqlite');
  let inbox=new DurableInbox(file);
  let sent=0;
  const mock=async(url,options)=>{
    if(url.includes('/attempts')){sent++;return {status:202}}
    return {ok:true,json:async()=>rows,
      headers:{get:()=>null}};
  };
  const opts={repositoryId:repoId,installationId,jwt:auth,fetcher:mock,now};
  const first=await auditFailedAppDeliveries(inbox,opts);
  assert.deepEqual({missed:first.failed_guids,reserved:first.reserved,
    requested:first.requested},{missed:1,reserved:1,requested:1});
  assert.equal(sent,1);
  assert.equal(inbox.getWebhookRedelivery(GUID(1)).attempts,1);
  assert.equal(inbox.getWebhookRedelivery(GUID(1)).last_result,'accepted');
  const duplicate=await auditFailedAppDeliveries(inbox,opts);
  assert.equal(duplicate.requested,0,'same failed GUID has durable backoff');
  assert.equal(sent,1);
  inbox.close();

  inbox=new DurableInbox(file);
  assert.equal(inbox.getWebhookRedelivery(GUID(1)).attempts,1,
    'reservation survives a restart');
  const delayed=await auditFailedAppDeliveries(inbox,{
    ...opts,now:now+3600001,fetcher:async(url,options)=>{
      if(url.includes('/attempts')){sent++;throw Error('timeout after POST')}
      return {ok:true,json:async()=>rows,
        headers:{get:()=>null}};
    },
  });
  assert.equal(delayed.requested,0,'ambiguous API timeout is not a success');
  assert.equal(inbox.getWebhookRedelivery(GUID(1)).last_result,'uncertain');
  assert.equal(sent,2);
  assert.equal((await auditFailedAppDeliveries(inbox,{
    ...opts,now:now+3600002})).requested,0,
    'a crashed/ambiguous request cannot be immediately replayed');
  assert.equal(sent,2);
  // GitHub eventually records the successful delivery of this GUID.
  assert.equal((await auditFailedAppDeliveries(inbox,{
    ...opts,fetcher:async(url)=>({
      ok:true,json:async()=>[...rows,row(12,{
        guid:GUID(1),status:'OK',status_code:202})],
      headers:{get:()=>null}
    })})).requested,0);
  assert.equal(sent,2);
  inbox.close();
}finally{rmSync(dir,{force:true,recursive:true})}
assert.throws(()=>createWebhookRecovery({ACCEPTANCE_WEBHOOK_RECOVERY_MODE:'shadow'}),/opt-in/);
console.log('GitHub App webhook recovery: exact repo/install/event, success-before-redelivery, 3-day cutoff, bounded JWT pagination, durable reservation, timeout uncertainty, restart, forged-source exclusion passed');
