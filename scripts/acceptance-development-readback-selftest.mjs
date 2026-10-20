import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {parseDevelopmentReceipt,attestDevelopmentReceipt,attestDevelopmentStore,
  DEVELOPMENT_RECEIPT_PREFIX,collectDevelopmentReadback} from './acceptance-development-readback.mjs';
import {startDevelopment,recordDispatchIntent,recordDispatch,recordSliceYield} from './lib/agent/orchestration/outbox.mjs';
import {developmentIngestReceipt} from './lib/agent/orchestration/development-ingest.mjs';

export async function selfTestDevelopmentReadback(){
  const repo='BestNathan/nession',full={full_name:repo};
  const sha='a'.repeat(40),source='b'.repeat(40),commit='c'.repeat(40);
  const digest=b=>createHash('sha256').update(b).digest('hex');
  const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
  const pending=startDevelopment(registry,{issue:1997,sha:source,
    developer:'dev-cursor-01',reviewer:'review-cursor-01',acceptor:'accept-cursor-01'},
    {repository:repo,event:'workflow_dispatch',permission:'write',ref:'refs/heads/main',run_id:81});
  const action=pending.outbox[0].id;
  const prepared=recordDispatchIntent(pending,pending.version,action,
    {status:'prepared',dispatch_id:action,issuer_run_id:81,ticket_sha256:'d'.repeat(64)});
  const dispatched=recordDispatch(prepared,prepared.version,action,
    {status:'verified',dispatch_id:action,source_run_id:82});
  const ciphertext=Buffer.from('synthetic ciphertext');
  const cp={version:1,commit_sha:commit,ciphertext_sha256:digest(ciphertext)};
  const yielded=recordSliceYield(dispatched,dispatched.version,action,cp,
    {verified:true,repository:repo,workflow_path:'.github/workflows/agent-develop.yml',
      workflow_name:'Agent / Development',role:'developer',agent_id:'dev-cursor-01',
      issue:1997,run_id:82,attempt:1,action_id:action,input_sha:source});
  const worker={id:82,run_attempt:1,head_sha:sha,path:'.github/workflows/agent-develop.yml',
    name:'Agent / Development',actor:{login:'github-actions[bot]'},event:'workflow_dispatch',
    head_branch:'main',repository:full,head_repository:full,status:'completed',conclusion:'success',
    updated_at:'2026-10-20T00:00:00Z'};
  const ingest={...worker,id:83,path:'.github/workflows/store-agent-development-ingest.yml',
    name:'Store / Agent Development Ingest',actor:{login:'BestNathan'},event:'issue_comment',
    created_at:'2026-10-20T00:01:00Z'};
  const jobs={total_count:1,jobs:[{id:84,name:'ingest',run_id:83,run_attempt:1,head_sha:sha,
    status:'completed',conclusion:'success',steps:[{
      name:'Verify native ciphertext and publish committed Checkpoint and Yield',conclusion:'success'}]}]};
  const artifact=(id,name)=>({id,name:name+'-82-1',expired:false,size_in_bytes:100,
    digest:'sha256:'+'e'.repeat(64),workflow_run:{id:82,head_sha:sha}});
  const artifacts={total_count:2,artifacts:[artifact(85,'development-worker-claim'),artifact(86,'development-worker')]};
  const meta={agent_id:'agent-native-82',harness_digest:'f'.repeat(64)};
  const receipt=developmentIngestReceipt({status:'replayed',run:worker,
    claim:{inputs:{action_id:action,input_sha:source}},metadata:meta,
    claimArtifact:{artifact_id:85,digest:artifacts.artifacts[0].digest},resultArtifact:artifacts.artifacts[1],
    checkpoint:cp,stateVersion:yielded.version,storeCommit:commit,
    environment:{GITHUB_RUN_ID:'83',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:sha}});
  const log='2026-10-20T00:01:02.123Z '+DEVELOPMENT_RECEIPT_PREFIX+JSON.stringify(receipt)+'\n';
  assert.deepEqual(parseDevelopmentReceipt(log),receipt);
  const params={receipt,ingest,jobs,worker,artifacts};
  assert.equal(attestDevelopmentReceipt(params).job_id,84);
  for(const bad of [
    {worker:{...worker,conclusion:'failure'}},
    {worker:{...worker,path:'.github/workflows/untrusted.yml'}},
    {worker:{...worker,head_repository:{full_name:'fork/repo'}}},
    {ingest:{...ingest,actor:{login:'attacker'}}},
    {ingest:{...ingest,run_attempt:2}},
    {receipt:{...receipt,run_id:999}},
    {receipt:{...receipt,result_artifact_digest:'sha256:'+'0'.repeat(64)}},
    {artifacts:{...artifacts,artifacts:[...artifacts.artifacts,artifacts.artifacts[1]]}},
    {jobs:{...jobs,jobs:[{...jobs.jobs[0],conclusion:'failure'}]}},
    {jobs:{...jobs,jobs:[{...jobs.jobs[0],run_attempt:2}]}},
  ])assert.throws(()=>attestDevelopmentReceipt({...params,...bad}),/Developer Acceptance/);
  for(const bad of [log+log,'echo '+DEVELOPMENT_RECEIPT_PREFIX+JSON.stringify(receipt),
    log.replace('"issue":1997','"issue":1998'),
    log.replace('"kind":"authenticated_development_checkpoint_receipt"','"kind":"SC Pass"'),
    log.replace('"status":"replayed"','"status":"replayed","private_key":"secret"')])
    assert.throws(()=>parseDevelopmentReceipt(bad));
  const state=Buffer.from(JSON.stringify(yielded,null,2)+'\n');
  const prefix='roles/developer/dev-cursor-01/issues/1997';
  const location=prefix+'/checkpoints/00000001.json';
  const store={head:{version:yielded.version,path:'workflows/issues/1997/states/00000004.json',sha256:digest(state)},
    state,pending,prepared,dispatched,
    runRecord:{kind:'agent_checkpoint_run',run_id:82,attempt:1,workflow:worker.path,
      workflow_sha:sha,source_sha:source,role:'developer',agent_id:'dev-cursor-01',issue:1997,
      version:1,checkpoint_path:location,ciphertext_sha256:cp.ciphertext_sha256,harness_digest:meta.harness_digest},
    checkpointHead:{version:1,checkpoint_path:location,ciphertext_sha256:cp.ciphertext_sha256},
    checkpoint:{schema_version:1,kind:'encrypted_agent_checkpoint',path:location,version:1,
      identity:{role:'developer',agent_id:'dev-cursor-01',issue:1997},
      metadata:{provider:'cursor',session_id:meta.agent_id,source_sha:source,harness_digest:meta.harness_digest},
      encryption:{algorithm:'aes-256-gcm'},ciphertext:ciphertext.toString('base64'),ciphertext_sha256:cp.ciphertext_sha256}};
  assert.equal(attestDevelopmentStore(receipt,store).recorded_continuation_status,'pending');
  for(const bad of [
    {head:{...store.head,sha256:'0'.repeat(64)}},
    {state:Buffer.from(JSON.stringify({...yielded,issue:1998},null,2)+'\n')},
    {runRecord:{...store.runRecord,run_id:999}},
    {runRecord:{...store.runRecord,workflow_sha:'0'.repeat(40)}},
    {checkpoint:{...store.checkpoint,ciphertext:Buffer.from('modified').toString('base64')}},
    {checkpoint:{...store.checkpoint,metadata:{...store.checkpoint.metadata,session_id:'agent-other'}}},
    {checkpointHead:{...store.checkpointHead,version:2}},
    {checkpoint:{...store.checkpoint,plaintext:'forbidden'}},
    {prepared:pending},{dispatched:prepared},
  ])assert.throws(()=>attestDevelopmentStore(receipt,{...store,...bad}));
  let calls=0;
  assert.deepEqual(await collectDevelopmentReadback({repo,issue:123,stage:'staging',
    get:()=>{calls++;}}),[]);
  assert.equal(calls,0,'unrelated Issues must not query historical fixture');
  console.log('Developer readback: source/attempt/Artifact/Git-state/continuation binding and forgery negatives passed');
}
if(process.argv[1]?.endsWith('/acceptance-development-readback-selftest.mjs'))await selfTestDevelopmentReadback();
