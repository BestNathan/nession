// #2137: trusted-main read-only source attestation for a future Publisher.
// Caller must provide independently fetched GitHub REST Run/Artifacts, original
// signed Claim/Result ZIP bytes and a read-only orphan Store remote. No token,
// secret, PR writer or external side effect is created by this module.
import {createHash} from 'node:crypto';
import {authenticateWorkerClaimRun,inspectWorkerClaimZip,verifyWorkerClaimForAck}
  from '../orchestration/worker-reconcile.mjs';
import {matchingResult,readConfirmedDevelopmentState}
  from '../orchestration/development-ingest.mjs';
import {readWorkerZipMember} from '../orchestration/worker-zip.mjs';
import {verifyCommittedCheckpoint} from '../store/remote.mjs';
import {CONTROLLED_1997_POLICY,prepareControlled1997PublisherProposal}
  from './controlled-proposal.mjs';

const REPO='BestNathan/nession', POLICY=CONTROLLED_1997_POLICY;
const sha=b=>createHash('sha256').update(b).digest('hex');
function reject(s){throw Error('Trusted Publisher source: '+s);}
const ok=(v,expected,name)=>{if(v!==expected)reject('untrusted '+name);};
const positive=v=>Number.isSafeInteger(v)&&v>0;
const HASH=/^sha256:[0-9a-f]{64}$/;
function readExactZipMember(zip,name){
  let obj;
  try{obj=JSON.parse(new TextDecoder('utf-8',{fatal:true})
    .decode(readWorkerZipMember(zip,name)));}
  catch{reject('untrusted Worker ZIP member '+name);}
  if(!obj||typeof obj!=='object'||Array.isArray(obj))
    reject('untrusted Worker JSON shape');
  return obj;
}
export function assertControlledPublisherSourceRun(run,ingesterRun,artifacts){
  if(run?.id!==POLICY.run_id||run?.run_attempt!==POLICY.attempt||
     run.head_sha!==POLICY.worker_sha||
     run.path!=='.github/workflows/agent-develop.yml'||
     run.name!=='Agent / Development'||run.event!=='workflow_dispatch'||
     run.head_branch!=='main'||run.actor?.login!=='github-actions[bot]'||
     run.repository?.full_name!==REPO||
     run.head_repository?.full_name!==REPO||
     run.status!=='completed'||run.conclusion!=='success')
    reject('wrong authenticated Developer source Run/Attempt/SHA');
  if(ingesterRun?.id!==POLICY.ingester_run_id||
     ingesterRun.run_attempt!==POLICY.ingester_attempt||
     ingesterRun.head_sha!==POLICY.ingester_sha||
     ingesterRun.path!=='.github/workflows/store-agent-development-ingest.yml'||
     ingesterRun.name!=='Store / Agent Development Ingest'||
     ingesterRun.event!=='issue_comment'||
     ingesterRun.head_branch!=='main'||
     ingesterRun.actor?.login!=='BestNathan'||
     ingesterRun.repository?.full_name!==REPO||
     ingesterRun.head_repository?.full_name!==REPO||
     ingesterRun.status!=='completed'||ingesterRun.conclusion!=='success')
    reject('wrong independently authenticated Ingest source');
  if(!Array.isArray(artifacts?.artifacts)||
     !positive(artifacts.total_count)||artifacts.total_count!==artifacts.artifacts.length||
     artifacts.total_count>100)reject('incomplete/paginated source artifact list');
  const artifact=(name,id,digest)=>{
    const found=artifacts.artifacts.filter(x=>x.name===name);
    if(found.length!==1||found[0].id!==id||
       found[0].digest!==digest||!HASH.test(found[0].digest)||
       found[0].workflow_run?.id!==run.id||
       found[0].workflow_run?.head_sha!==run.head_sha||
       found[0].expired!==false||
       !positive(found[0].size_in_bytes)||
       found[0].size_in_bytes>32*1024*1024)
      reject('missing or altered original Run-bound Artifact '+name);
    return found[0];
  };
  const base=run.id+'-'+run.run_attempt;
  return {
    claim:artifact('development-worker-claim-'+base,POLICY.claim_artifact_id,
      POLICY.claim_artifact_digest),
    result:artifact('development-worker-'+base,POLICY.result_artifact_id,
      POLICY.result_artifact_digest),
  };
}
export function assertControlledPublisherStore(admission,run){
  if(!admission||admission.already_yielded!==true||
     admission.state_version<POLICY.workflow_state_version||
     admission.previous_version!==POLICY.checkpoint_version-1||
     admission.next_version!==POLICY.checkpoint_version)
    reject('missing committed source Slice Yield or native version');
  const action=admission.action,checkpoint=admission.existing_checkpoint;
  if(action?.id!==POLICY.action_id||
     action?.status!=='yielded'||action.task?.role!=='developer'||
     action.task?.agent_id!=='dev-cursor-01'||
     action.task?.sha!==POLICY.source_sha||
     action.receipt?.source_run_id!==run.id||
     action.receipt?.source_attempt!==run.run_attempt||
     action.receipt?.checkpoint_version!==POLICY.checkpoint_version||
     action.receipt?.checkpoint_commit_sha!==POLICY.checkpoint_commit_sha||
     action.receipt?.ciphertext_sha256!==POLICY.checkpoint_ciphertext_sha256||
     checkpoint?.version!==POLICY.checkpoint_version||
     checkpoint.commit_sha!==POLICY.checkpoint_commit_sha||
     checkpoint.ciphertext_sha256!==POLICY.checkpoint_ciphertext_sha256||
     checkpoint.metadata?.session_id!==POLICY.native_session_id||
     checkpoint.metadata?.harness_digest!==POLICY.harness_digest||
     checkpoint.metadata?.source_sha!==POLICY.source_sha||
     checkpoint.metadata?.provider!=='cursor')
    reject('Store Yield conflicts with original Worker and v3 ciphertext');
  return checkpoint;
}
// Exact original Worker Run/Attempt and signed Ticket must be authenticated,
// not reconstructed from model-supplied Run metadata or the PR body.
export async function attestControlled1997PublisherSource({
  run,ingesterRun,artifacts,claimZip,resultZip,key,reader,
  remote,checkout,
}){
  const selected=assertControlledPublisherSourceRun(run,ingesterRun,artifacts);
  if(!Buffer.isBuffer(claimZip)||claimZip.length!==selected.claim.size_in_bytes||
     'sha256:'+sha(claimZip)!==selected.claim.digest)
    reject('authenticated claim ZIP bytes mismatch');
  if(!Buffer.isBuffer(resultZip)||resultZip.length!==selected.result.size_in_bytes||
     'sha256:'+sha(resultZip)!==selected.result.digest)
    reject('authenticated result ZIP bytes mismatch');
  const claim=inspectWorkerClaimZip(claimZip,selected.claim.digest,run);
  const attested=await verifyWorkerClaimForAck({run,claim,key,reader});
  ok(attested.issue,POLICY.issue,'Worker ticket issue');
  ok(attested.action_id,POLICY.action_id,'Worker ticket action');
  ok(attested.source_run_id,POLICY.run_id,'Worker ticket run');
  ok(attested.attempt,POLICY.attempt,'Worker ticket attempt');
  ok(claim.inputs?.input_sha,POLICY.source_sha,'signed exact input SHA');
  const result=readExactZipMember(resultZip,'result.json');
  const proof=readExactZipMember(resultZip,'proof.json');
  const ciphertext=readExactZipMember(resultZip,'ciphertext.json');
  const metadata=matchingResult(result,proof,ciphertext,claim,run);
  ok(metadata.agent_id,POLICY.native_session_id,'Cursor native Session');
  ok(metadata.harness_digest,POLICY.harness_digest,'Cursor effective Harness');
  ok(metadata.run_id,POLICY.run_id,'native proof run');
  ok(metadata.attempt,POLICY.attempt,'native proof attempt');
  const admission=readConfirmedDevelopmentState(remote,claim,run);
  assertControlledPublisherStore(admission,run);
  verifyCommittedCheckpoint({remote,
    identity:{role:'developer',agent_id:'dev-cursor-01',issue:POLICY.issue},
    commit_sha:POLICY.checkpoint_commit_sha,
    version:POLICY.checkpoint_version,
    ciphertext_sha256:POLICY.checkpoint_ciphertext_sha256});
  // The validated Store and original signed Artifact commitments, not Worker
  // JSON, are the only origin of the sanitized trusted Ingest receipt.
  const receipt={
    schema_version:1,kind:'authenticated_development_checkpoint_receipt',
    status:'yielded',issue:POLICY.issue,action_id:POLICY.action_id,
    run_id:POLICY.run_id,attempt:POLICY.attempt,
    worker_sha:POLICY.worker_sha,source_sha:POLICY.source_sha,
    ingester_run_id:POLICY.ingester_run_id,
    ingester_attempt:POLICY.ingester_attempt,
    ingester_sha:POLICY.ingester_sha,
    claim_artifact_id:selected.claim.id,
    claim_artifact_digest:selected.claim.digest,
    result_artifact_id:selected.result.id,
    result_artifact_digest:selected.result.digest,
    checkpoint_version:POLICY.checkpoint_version,
    checkpoint_commit_sha:POLICY.checkpoint_commit_sha,
    ciphertext_sha256:POLICY.checkpoint_ciphertext_sha256,
    session_id:metadata.agent_id,
    harness_digest:metadata.harness_digest,
    workflow_state_version:POLICY.workflow_state_version,
    workflow_commit_sha:POLICY.workflow_commit_sha,
  };
  const proposal=prepareControlled1997PublisherProposal({checkout,result,receipt});
  return {
    ...proposal,source_authentication:'independently_verified',
    // Only identifiers: never expose signed claim, native ciphertext, keys
    // or model trace into the future GitHub PR body or Issue comment.
    provenance:{
      worker_run_id:run.id,worker_attempt:run.run_attempt,
      claim_artifact_id:selected.claim.id,result_artifact_id:selected.result.id,
      checkpoint_commit_sha:POLICY.checkpoint_commit_sha,
      checkpoint_ciphertext_sha256:POLICY.checkpoint_ciphertext_sha256,
      source_sha:POLICY.source_sha,
    },
  };
}
