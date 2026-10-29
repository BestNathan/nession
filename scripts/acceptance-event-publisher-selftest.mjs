#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableInbox} from './acceptance-event-relay-core.mjs';
import {publishDueTask,dispatchConsumer,dispatchDueResult,
  listMatchingDispatches,verifyCreatedRunResponse,
  matchDispatchedRun,createPublisher} from './acceptance-event-publisher.mjs';

const repo='BestNathan/nession',sha='a'.repeat(40),digest='b'.repeat(64);
const source={repo,source_run_id:54,source_attempt:2,
  source_path:'.github/workflows/e2e-tests.yml',
  target_sha:sha,stage:'post-merge'};
const selected=[{issue:86,contract_digest:digest}];
const UUID=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0');
const dir=mkdtempSync(join(tmpdir(),'nession-publisher-'));
const createTask=(inbox,delivery,i,time)=>inbox.record(UUID(delivery),
  Buffer.from('source '+i),{...source,source_attempt:i},selected,time);
const fakeRun=task=>({
  id:888,name:'Acceptance / Event Consumer',
  path:'.github/workflows/acceptance-event-consumer.yml',
  display_title:'Acceptance task '+task.id,
  event:'workflow_dispatch',head_branch:'main',
  repository:{full_name:repo},head_repository:{full_name:repo},
});
try{
  const file=join(dir,'outbox.sqlite');
  let inbox=new DurableInbox(file);
  const now=Date.now();
  createTask(inbox,1,2,now);
  const good={
    authorize:async()=>({authorized:true}),
    dispatch:async()=>({kind:'receipt',runId:777}),
    lookup:async()=>[],
  };
  let result=await publishDueTask(inbox,good,{now:()=>now});
  assert.equal(result.kind,'submitted');
  assert.equal(result.run_id,777);
  let row=inbox.get(result.task_id);
  assert.equal(row.status,'confirmed');
  assert.equal(row.dispatch_run_id,777);
  assert.equal(row.suppression_reason,null);
  assert.equal(inbox.acknowledgeDispatch(result.task_id,777,now),true);
  assert.equal(inbox.acknowledgeDispatch(result.task_id,999,now),false);
  assert.equal(inbox.nextTaskDue(),null);
  inbox.close();

  inbox=new DurableInbox(file);
  assert.equal(inbox.get(result.task_id).dispatch_run_id,777,
    'the actual GitHub Run ID survives restart');
  createTask(inbox,2,3,now+100);
  result=await publishDueTask(inbox,{...good,
    dispatch:async()=>({kind:'rejected',httpStatus:429,retryAfterMs:120000})},{
    now:()=>now+100});
  assert.equal(result.kind,'quota-retry');
  row=inbox.get(result.task_id);
  assert.equal(row.status,'pending');
  assert.ok(row.due_at>=now+120100);
  assert.equal(inbox.nextTaskDue(),row.due_at);
  inbox.close();

  inbox=new DurableInbox(file);
  assert.equal((await publishDueTask(inbox,good,{now:()=>row.due_at-1})),null);
  const retried=await publishDueTask(inbox,good,{now:()=>row.due_at});
  assert.equal(retried.kind,'submitted');
  assert.equal(inbox.get(retried.task_id).attempts,2);
  createTask(inbox,3,4,row.due_at+100);
  const uncertain=await publishDueTask(inbox,{...good,
    dispatch:async()=>({kind:'uncertain',httpStatus:204})},{
    now:()=>row.due_at+100});
  assert.equal(uncertain.kind,'uncertain');
  let pending=inbox.get(uncertain.task_id);
  assert.equal(pending.status,'uncertain');
  const due=pending.due_at+1;
  let calls=0;
  const lookup={...good,lookup:async t=>{
    calls++;
    return [{...fakeRun(t),display_title:'wrong'},fakeRun(t)];
  }};
  const reconciled=await publishDueTask(inbox,lookup,{now:()=>due});
  assert.equal(reconciled.kind,'reconciled');
  assert.equal(reconciled.run_id,888);
  assert.equal(inbox.get(uncertain.task_id).dispatch_run_id,888);
  assert.equal(calls,1);
  assert.equal(inbox.nextTaskDue(),null);

  createTask(inbox,4,5,due+10);
  const ambiguous=await publishDueTask(inbox,{...good,
    dispatch:async()=>{throw Error('lost connection after POST')}},{
    now:()=>due+10});
  assert.equal(ambiguous.kind,'uncertain');
  const absent=inbox.get(ambiguous.task_id);
  assert.equal(absent.status,'uncertain');
  const checked=await publishDueTask(inbox,{...good,lookup:async()=>[]},{
    now:()=>absent.due_at+10});
  assert.equal(checked.kind,'uncertain',
    'bounded listing absence must not trigger a second POST');
  assert.equal(inbox.get(ambiguous.task_id).status,'uncertain');

  createTask(inbox,5,6,absent.due_at+50);
  let dispatchCalls=0;
  const suppressed=await publishDueTask(inbox,{
    ...good,authorize:async()=>({authorized:false}),dispatch:async()=>{
      dispatchCalls++;throw Error('must not dispatch stale Issue');
    }},
  {now:()=>absent.due_at+50});
  assert.equal(suppressed.kind,'suppressed');
  assert.equal(dispatchCalls,0);
  assert.equal(inbox.get(suppressed.task_id).dispatch_run_id,null);
  assert.equal(inbox.get(suppressed.task_id).suppression_reason,'no-current-eligible-SC');

  createTask(inbox,6,7,absent.due_at+60);
  const t1=await Promise.all([
    publishDueTask(inbox,{...good,authorize:async()=>{
      await new Promise(resolve=>setImmediate(resolve));
      return {authorized:true};
    }},{now:()=>absent.due_at+60}),
    publishDueTask(inbox,good,{now:()=>absent.due_at+60}),
  ]);
  assert.equal(t1.filter(x=>x?.kind==='submitted').length,1,
    'only one process can claim the same outbox task');

  // Legacy 204 and failure responses must never claim a Run receipt.
  assert.equal(dispatchDueResult({status:204}).kind,'uncertain');
  assert.equal(dispatchDueResult({status:503}).kind,'uncertain');
  assert.equal(dispatchDueResult({status:403,headers:{get:()=> '60'}}).kind,'rejected');
  const receipt={workflow_run_id:99,
    run_url:'https://api.github.com/repos/'+repo+'/actions/runs/99',
    html_url:'https://github.com/'+repo+'/actions/runs/99'};
  assert.equal(verifyCreatedRunResponse(receipt),99);
  assert.throws(()=>verifyCreatedRunResponse({...receipt,
    run_url:'https://api.github.com/repos/evil/actions/runs/99'}),/receipt/);
  const task=inbox.get(retried.task_id);
  assert.equal(matchDispatchedRun(task,fakeRun(task)),true);
  assert.equal(matchDispatchedRun(task,{...fakeRun(task),path:'evil'}),false);
  assert.equal(matchDispatchedRun(task,{...fakeRun(task),display_title:'other'}),false);
  const sent=await dispatchConsumer(task,'test-token',async(url,options)=>{
    assert.match(url,/acceptance-event-consumer.yml\/dispatches$/);
    assert.equal(options.method,'POST');
    const body=JSON.parse(options.body);
    assert.deepEqual({ref:body.ref,details:body.return_run_details},
      {ref:'main',details:true});
    assert.equal(body.inputs.task_id,task.id);
    return {status:200,json:async()=>receipt};
  });
  assert.deepEqual(sent,{kind:'receipt',runId:99});
  assert.equal((await dispatchConsumer(task,'token',async()=>({
    status:200,json:async()=>({workflow_run_id:0})
  }))).kind,'uncertain');
  const found=await listMatchingDispatches(task,'token',async()=>{
    return {ok:true,json:async()=>({workflow_runs:[
      {...fakeRun(task),head_branch:'other'},fakeRun(task),
    ]})};
  });
  assert.equal(found.length,1);
  assert.equal(found[0].id,888);
  assert.throws(()=>createPublisher({ACCEPTANCE_PUBLISHER_MODE:'shadow'}),/opt-in/);
  inbox.close();
}finally{rmSync(dir,{recursive:true,force:true})}
console.log('Acceptance publisher: 200 exact Run ID, 204/5xx ambiguity, 429 durable delay, restart/lease, reconciliation, stale Issue and singleflight fixtures passed');
