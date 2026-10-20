// Bounded, read-only #2010/#1997 evidence discovery. Issue text, a green Job,
// and a hash by themselves confer no authority. Join an authenticated trusted
// Ingest output with original Worker manifests and pinned orphan Git objects.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {validateDevelopmentState} from './lib/agent/orchestration/outbox.mjs';
import {issueStatePath} from './lib/agent/orchestration/state-store.mjs';
import {checkpointPath,checkpointPrefix} from './lib/agent/store/checkpoint.mjs';

const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/,DIGEST=/^[a-f0-9]{64}$/;
export const DEVELOPMENT_RECEIPT_PREFIX='AGENT_DEVELOPMENT_INGEST_V1 ';
const INGEST='.github/workflows/store-agent-development-ingest.yml';
const WORKER='.github/workflows/agent-develop.yml';
const STEP='Verify native ciphertext and publish committed Checkpoint and Yield';
const positive=n=>Number.isSafeInteger(n)&&n>0;
const hash=b=>createHash('sha256').update(b).digest('hex');
function fail(s){throw Error('Developer Acceptance readback: '+s);}
function requireIt(ok,s){if(!ok)fail(s);}
function runIdentity(run,path,name,events,actor,conclusions=['success']) {
  requireIt(positive(run?.id)&&positive(run.run_attempt)&&SHA.test(run.head_sha??'')&&
    run.path===path&&run.name===name&&events.includes(run.event)&&
    run.head_branch==='main'&&run.repository?.full_name===REPO&&
    run.head_repository?.full_name===REPO&&run.actor?.login===actor&&
    run.status==='completed'&&conclusions.includes(run.conclusion),'untrusted Run identity');
}
export function parseDevelopmentReceipt(log) {
  requireIt(typeof log==='string'&&log.length<2*1024*1024,'unbounded Ingest log');
  // Shell source lines (which may include echo/printf) are not emitted receipts.
  const rows=log.split(/\r?\n/).filter(s=>
    /^\d{4}-\d\d-\d\dT\S+Z AGENT_DEVELOPMENT_INGEST_V1 \{/.test(s));
  requireIt(rows.length===1,'missing/ambiguous emitted receipt');
  const text=rows[0].slice(rows[0].indexOf(DEVELOPMENT_RECEIPT_PREFIX)+DEVELOPMENT_RECEIPT_PREFIX.length);
  requireIt(text.length<8192,'oversized receipt');
  const r=JSON.parse(text);
  const fields=['schema_version','kind','status','issue','action_id','run_id','attempt',
    'worker_sha','source_sha','ingester_run_id','ingester_attempt','ingester_sha',
    'claim_artifact_id','claim_artifact_digest','result_artifact_id','result_artifact_digest',
    'checkpoint_version','checkpoint_commit_sha','ciphertext_sha256','session_id',
    'harness_digest','workflow_state_version','workflow_commit_sha'];
  requireIt(r&&Object.keys(r).length===fields.length&&
    fields.every(k=>Object.hasOwn(r,k))&&r.schema_version===1&&
    r.kind==='authenticated_development_checkpoint_receipt'&&
    ['yielded','replayed'].includes(r.status)&&r.issue===1997&&
    ['action_id','ciphertext_sha256','harness_digest'].every(k=>DIGEST.test(r[k]??''))&&
    ['worker_sha','source_sha','ingester_sha','checkpoint_commit_sha','workflow_commit_sha']
      .every(k=>SHA.test(r[k]??''))&&
    ['run_id','attempt','ingester_run_id','ingester_attempt','claim_artifact_id',
      'result_artifact_id','checkpoint_version','workflow_state_version'].every(k=>positive(r[k]))&&
    ['claim_artifact_digest','result_artifact_digest'].every(k=>/^sha256:[a-f0-9]{64}$/.test(r[k]??''))&&
    /^agent-[a-zA-Z0-9-]{4,100}$/.test(r.session_id??''),'invalid sanitized receipt');
  return r;
}
export function attestDevelopmentReceipt({receipt:r,ingest,jobs,worker,artifacts}) {
  runIdentity(ingest,INGEST,'Store / Agent Development Ingest',
    ['issue_comment','workflow_run'],'BestNathan');
  runIdentity(worker,WORKER,'Agent / Development',['workflow_dispatch'],'github-actions[bot]');
  requireIt(r.ingester_run_id===ingest.id&&r.ingester_attempt===ingest.run_attempt&&
    r.ingester_sha===ingest.head_sha&&r.run_id===worker.id&&r.attempt===worker.run_attempt&&
    r.worker_sha===worker.head_sha&&Date.parse(worker.updated_at)<=Date.parse(ingest.created_at),
    'receipt differs from actual Run/Attempt/order');
  requireIt(Array.isArray(jobs?.jobs)&&jobs.jobs.length<=100&&jobs.total_count<=100,
    'unbounded Ingest jobs');
  const owned=jobs.jobs.filter(j=>j.name==='ingest');
  requireIt(owned.length===1&&owned[0].run_id===ingest.id&&
    owned[0].run_attempt===ingest.run_attempt&&owned[0].head_sha===ingest.head_sha&&
    owned[0].status==='completed'&&owned[0].conclusion==='success'&&
    owned[0].steps?.filter(s=>s.name===STEP&&s.conclusion==='success').length===1,
    'no exact successful attestation job');
  requireIt(Array.isArray(artifacts?.artifacts)&&artifacts.artifacts.length<=100&&
    artifacts.total_count<=100,'unbounded Worker artifacts');
  for(const [stem,id,digest,max] of [
    ['development-worker-claim',r.claim_artifact_id,r.claim_artifact_digest,256*1024],
    ['development-worker',r.result_artifact_id,r.result_artifact_digest,32*1024*1024],
  ]) {
    const matches=artifacts.artifacts.filter(a=>a.name===stem+'-'+worker.id+'-'+worker.run_attempt);
    requireIt(matches.length===1&&matches[0].id===id&&matches[0].digest===digest&&
      matches[0].expired===false&&positive(matches[0].size_in_bytes)&&
      matches[0].size_in_bytes<=max&&matches[0].workflow_run?.id===worker.id&&
      matches[0].workflow_run?.head_sha===worker.head_sha,'untrusted/mismatched immutable Artifact');
  }
  return {job_id:owned[0].id};
}
function jsonBytes(doc,max=512*1024) {
  requireIt(doc?.type==='file'&&doc.encoding==='base64'&&typeof doc.content==='string'&&
    positive(doc.size)&&doc.size<=max,'unsafe Git object response');
  const b=Buffer.from(doc.content,'base64');
  requireIt(b.length===doc.size,'Git object size mismatch');
  return b;
}
function decode(doc,max){return JSON.parse(jsonBytes(doc,max).toString('utf8'));}
export function attestDevelopmentStore(r,{head,state,runRecord,checkpoint,checkpointHead,prepared,dispatched,pending}) {
  requireIt(head.version===r.workflow_state_version&&head.path===issueStatePath(1997,head.version)&&
    DIGEST.test(head.sha256??'')&&hash(state)===head.sha256,'Store state digest mismatch');
  const s=JSON.parse(state.toString('utf8'));
  validateDevelopmentState(s);
  requireIt(s.issue===1997&&s.version===head.version,'wrong immutable state');
  const identity={role:'developer',agent_id:'dev-cursor-01',issue:1997};
  const location=checkpointPath(identity,r.checkpoint_version);
  requireIt(runRecord.kind==='agent_checkpoint_run'&&runRecord.run_id===r.run_id&&
    runRecord.attempt===r.attempt&&runRecord.workflow===WORKER&&
    runRecord.workflow_sha===r.worker_sha&&runRecord.source_sha===r.source_sha&&
    runRecord.role===identity.role&&runRecord.agent_id===identity.agent_id&&runRecord.issue===1997&&
    runRecord.version===r.checkpoint_version&&runRecord.checkpoint_path===location&&
    runRecord.ciphertext_sha256===r.ciphertext_sha256&&runRecord.harness_digest===r.harness_digest,
    'wrong immutable Checkpoint Run');
  requireIt(checkpointHead.version===r.checkpoint_version&&checkpointHead.checkpoint_path===location&&
    checkpointHead.ciphertext_sha256===r.ciphertext_sha256&&
    checkpoint.schema_version===1&&checkpoint.kind==='encrypted_agent_checkpoint'&&checkpoint.path===location&&
    Object.keys(checkpoint).sort().join(',')==='ciphertext,ciphertext_sha256,encryption,identity,kind,metadata,path,schema_version,version'&&
    checkpoint.version===r.checkpoint_version&&checkpoint.identity?.role===identity.role&&
    checkpoint.identity?.agent_id===identity.agent_id&&checkpoint.identity?.issue===1997&&
    checkpoint.metadata?.provider==='cursor'&&checkpoint.metadata.session_id===r.session_id&&
    checkpoint.metadata.source_sha===r.source_sha&&checkpoint.metadata.harness_digest===r.harness_digest&&
    checkpoint.encryption?.algorithm==='aes-256-gcm'&&
    checkpoint.ciphertext_sha256===r.ciphertext_sha256&&
    typeof checkpoint.ciphertext==='string'&&checkpoint.ciphertext.length<24*1024*1024&&
    /^[A-Za-z0-9+/]+={0,2}$/.test(checkpoint.ciphertext)&&
    hash(Buffer.from(checkpoint.ciphertext,'base64'))===r.ciphertext_sha256,'wrong encrypted Checkpoint');
  for(const record of [pending,prepared,dispatched])validateDevelopmentState(record);
  const action=record=>record.outbox.find(a=>a.id===r.action_id);
  const p=action(pending),intent=action(prepared),dispatch=action(dispatched),yielded=action(s);
  requireIt(pending.issue===1997&&prepared.issue===1997&&dispatched.issue===1997&&
    pending.version<prepared.version&&prepared.version<dispatched.version&&dispatched.version<s.version&&
    p?.status==='pending'&&intent?.status==='dispatching'&&dispatch?.status==='dispatched'&&
    intent.receipt?.status==='prepared'&&DIGEST.test(intent.receipt.ticket_sha256??'')&&
    dispatch.receipt?.source_run_id===r.run_id&&dispatch.receipt.status==='verified'&&
    yielded?.status==='yielded'&&yielded.receipt?.source_run_id===r.run_id&&
    yielded.receipt.source_attempt===r.attempt&&yielded.receipt.checkpoint_version===r.checkpoint_version&&
    yielded.receipt.checkpoint_commit_sha===r.checkpoint_commit_sha&&
    yielded.receipt.ciphertext_sha256===r.ciphertext_sha256&&
    [p,intent,dispatch,yielded].every(a=>a.task.type==='dispatch'&&a.task.role==='developer'&&
      a.task.agent_id==='dev-cursor-01'&&a.task.task==='implement'&&a.task.sha===r.source_sha),
    'unbound pending/intent/dispatch/yield history');
  const children=s.outbox.filter(a=>a.task.continuation?.parent_action_id===r.action_id);
  requireIt(children.length===1,'missing/ambiguous committed continuation');
  return {state_version:s.version,dispatch_history:{
      action_id:r.action_id,source_sha:r.source_sha,
      pending_version:pending.version,dispatching_version:prepared.version,
      dispatched_version:dispatched.version,yielded_version:s.version,
      issuer_run_id:intent.receipt.issuer_run_id,ticket_sha256:intent.receipt.ticket_sha256,
      verified_worker_run_id:dispatch.receipt.source_run_id,worker_attempt:r.attempt,
      states_and_source_bindings_verified:true},recorded_continuation_status:children[0].status,
    continuation_action_id:children[0].id};
}
// Dispatch success and model success are separate facts. The historical
// original Worker failed before model work; never promote that to model proof.
export function attestOriginalDispatchHistory(history,sourceSha,oldRun,actionId){
  requireIt(Array.isArray(history)&&history.length<=16&&DIGEST.test(actionId??''),
    'invalid bounded original history');
  for(const s of history)validateDevelopmentState(s);
  const item=s=>s.outbox.find(a=>a.id===actionId);
  const find=status=>history.find(s=>item(s)?.status===status);
  const pending=find('pending'),prepared=find('dispatching'),dispatched=find('dispatched');
  requireIt(pending&&prepared&&dispatched,'incomplete original dispatch history');
  runIdentity(oldRun,WORKER,'Agent / Development',['workflow_dispatch'],'github-actions[bot]',['failure']);
  requireIt(pending.issue===1997&&prepared.issue===1997&&dispatched.issue===1997&&
    pending.version<prepared.version&&prepared.version<dispatched.version&&
    [pending,prepared,dispatched].every(s=>item(s).task.sha===sourceSha&&
      item(s).task.agent_id==='dev-cursor-01'&&item(s).task.role==='developer')&&
    item(prepared).receipt.status==='prepared'&&DIGEST.test(item(prepared).receipt.ticket_sha256??'')&&
    item(dispatched).receipt.status==='verified'&&item(dispatched).receipt.source_run_id===oldRun.id,
    'original dispatch history source binding failed');
  return {action_id:actionId,pending_version:pending.version,
    dispatching_version:prepared.version,dispatched_version:dispatched.version,
    worker_run_id:oldRun.id,worker_attempt:oldRun.run_attempt,worker_control_sha:oldRun.head_sha,
    issuer_run_id:item(prepared).receipt.issuer_run_id,ticket_sha256:item(prepared).receipt.ticket_sha256,
    worker_conclusion:oldRun.conclusion,source_sha:sourceSha,
    dispatch_verified:true,model_success_verified:false};
}
// Only the existing controlled initial #1997 fixture is supported. Extending
// proofs to another action/provider requires its independently tested contract.
export async function collectDevelopmentReadback({repo,issue,stage,targetSha,workspace,get,readLog}) {
  if(repo!==REPO||Number(issue)!==2010||
    !['staging','post-merge'].includes(stage))return [];
  requireIt(SHA.test(targetSha??''),'invalid target');
  const runs=await get('/repos/'+repo+'/actions/workflows/store-agent-development-ingest.yml/runs?status=success&per_page=10');
  requireIt(Array.isArray(runs.workflow_runs)&&runs.workflow_runs.length<=10,'unbounded discovery');
  for(const hint of runs.workflow_runs.slice(0,3)) {
    if(hint.name!=='Store / Agent Development Ingest'||hint.path!==INGEST)continue;
    const ingest=await get('/repos/'+repo+'/actions/runs/'+hint.id);
    const jobs=await get('/repos/'+repo+'/actions/runs/'+ingest.id+'/attempts/'+ingest.run_attempt+'/jobs?per_page=100');
    const job=jobs.jobs?.find(j=>j.name==='ingest');
    if(!job||!positive(job.id))continue;
    const log=await readLog('/repos/'+repo+'/actions/jobs/'+job.id+'/logs',2*1024*1024);
    if(!log.split(/\r?\n/).some(s=>/^\d{4}-\d\d-\d\dT\S+Z AGENT_DEVELOPMENT_INGEST_V1 \{/.test(s)))continue;
    const r=parseDevelopmentReceipt(log);
    const worker=await get('/repos/'+repo+'/actions/runs/'+r.run_id);
    const artifacts=await get('/repos/'+repo+'/actions/runs/'+worker.id+'/artifacts?per_page=100');
    const attested=attestDevelopmentReceipt({receipt:r,ingest,jobs,worker,artifacts});
    // An ancestor SHA alone is insufficient when proof-owning code changed.
    // Reusing earlier native execution is valid only with identical Worker,
    // adapter, native transport and current admission code at this target.
    for(const sha of [r.worker_sha,r.source_sha,r.ingester_sha]) {
      execFileSync('git',['-C',workspace,'merge-base','--is-ancestor',sha,targetSha],{stdio:'pipe',timeout:10000});
    }
    const owners=['.github/workflows/agent-develop.yml',
      'scripts/lib/agent/orchestration/development-worker.mjs',
      'scripts/lib/agent/orchestration/worker-preflight.mjs',
      'scripts/lib/agent/providers','scripts/lib/agent/harness','scripts/lib/agent/store',
      'scripts/lib/agent/orchestration/outbox.mjs','scripts/lib/agent/orchestration/github-dispatch.mjs',
      'scripts/lib/agent/orchestration/state-store.mjs',
      'automation/agents/registry.json'];
    execFileSync('git',['-C',workspace,'diff','--quiet',r.worker_sha,targetSha,'--',...owners],
      {stdio:'pipe',timeout:10000});
    execFileSync('git',['-C',workspace,'diff','--quiet',r.ingester_sha,targetSha,'--',
      INGEST,'scripts/lib/agent/orchestration/development-ingest.mjs'],
      {stdio:'pipe',timeout:10000});
    const reachable=await get('/repos/'+repo+'/compare/'+r.workflow_commit_sha+'...agent-store');
    const checkpointReachable=await get('/repos/'+repo+'/compare/'+r.checkpoint_commit_sha+'...'+r.workflow_commit_sha);
    requireIt(['ahead','identical'].includes(reachable.status)&&
      ['ahead','identical'].includes(checkpointReachable.status),'Store history/ref not reachable');
    const read=async(commit,filename,max)=>{
      const doc=await get('/repos/'+repo+'/contents/'+filename+'?ref='+commit);
      requireIt(doc.path===filename,'Git response path mismatch');
      return max===0?jsonBytes(doc):decode(doc,max);
    };
    const prefix=checkpointPrefix({role:'developer',agent_id:'dev-cursor-01',issue:1997});
    const head=await read(r.workflow_commit_sha,'workflows/issues/1997/head.json');
    const state=await read(r.workflow_commit_sha,issueStatePath(1997,r.workflow_state_version),0);
    // Bounded immutable predecessor search: at most 16 versions. No polling or
    // head mutation; action identity rather than version assumptions owns proof.
    requireIt(r.workflow_state_version<=64,'unsupported long history');
    const history=[],historyObjects=[];
    for(let v=r.workflow_state_version-1;v>=Math.max(1,r.workflow_state_version-16);v--){
      const path=issueStatePath(1997,v);
      const bytes=await read(r.workflow_commit_sha,path,0);
      const state=JSON.parse(bytes.toString('utf8'));
      validateDevelopmentState(state);
      history.push(state);
      historyObjects.push({version:v,path,sha256:hash(bytes)});
    }
    const find=status=>history.find(s=>s.outbox?.some(a=>a.id===r.action_id&&a.status===status));
    const store=attestDevelopmentStore(r,{head,state,
      runRecord:await read(r.checkpoint_commit_sha,prefix+'/runs/'+r.run_id+'-'+r.attempt+'.json'),
      checkpoint:await read(r.checkpoint_commit_sha,checkpointPath({role:'developer',agent_id:'dev-cursor-01',issue:1997},r.checkpoint_version),32*1024*1024),
      checkpointHead:await read(r.checkpoint_commit_sha,prefix+'/head.json'),
      prepared:find('dispatching'),dispatched:find('dispatched'),pending:find('pending')});
    const controller=await get('/repos/'+repo+'/actions/runs/'+store.dispatch_history.issuer_run_id);
    runIdentity(controller,'.github/workflows/agent-controller-dispatch.yml',
      'Agent / Controller Dispatch',['issue_comment','workflow_dispatch'],'BestNathan');
    execFileSync('git',['-C',workspace,'merge-base','--is-ancestor',controller.head_sha,targetSha],
      {stdio:'pipe',timeout:10000});
    const originalId='95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae';
    const oldFind=status=>history.find(s=>s.outbox.some(a=>a.id===originalId&&a.status===status));
    const oldPending=oldFind('pending'),oldPrepared=oldFind('dispatching'),oldDispatched=oldFind('dispatched');
    let original_dispatch_history=null;
    if(oldPending&&oldPrepared&&oldDispatched){
      const item=s=>s.outbox.find(a=>a.id===originalId);
      const oldRun=await get('/repos/'+repo+'/actions/runs/'+item(oldDispatched).receipt.source_run_id);
      original_dispatch_history=attestOriginalDispatchHistory(history,r.source_sha,oldRun,originalId);
      execFileSync('git',['-C',workspace,'merge-base','--is-ancestor',oldRun.head_sha,targetSha],
        {stdio:'pipe',timeout:10000});

    }
    return [{...r,...attested,...store,schema_version:1,kind:'verified_development_checkpoint_readback',
      immutable_state_objects:historyObjects,original_dispatch_history,
      verified_dispatch_controller:{run_id:controller.id,attempt:controller.run_attempt,
        sha:controller.head_sha,path:controller.path,conclusion:controller.conclusion},
      target_sha:targetSha,fixture_issue:1997,
      verified_worker_execution:{run_id:worker.id,attempt:worker.run_attempt,
        control_sha:worker.head_sha,task_source_sha:r.source_sha,
        status:worker.status,conclusion:worker.conclusion,
        real_native_read_edit_verified_by_trusted_ingest:true,
        scope:'bounded disposable Developer file edit; not PR publication or full Review/repair'},
      native_execution_owners_unchanged:true,source_ancestry_verified:true,
      store_reachable_verified:true,native_resume_verified:false,
      pr_publication_verified:false,full_review_repair_cycle_verified:false,
      provider_metric_comparability_verified:false,
      establishes_sc_verdict:false}];
  }
  return [];
}
