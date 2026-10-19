#!/usr/bin/env node
// #2010. Main-owned independent read/attest/decrypt/CAS checkpoint ingester.
// Decryption private key and Store App writer remain in this process, NEVER
// the model Worker. Only a verified successful GitHub Worker Run's unique
// Artifact, signed dispatch Ticket, and run-bound persisted Outbox are admitted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hkdfSync,createHash} from 'node:crypto';
import {readWorkerZipMember} from './worker-zip.mjs';
import {authenticateWorkerClaimRun,inspectWorkerClaimZip,
  verifyWorkerClaimForAck} from './worker-reconcile.mjs';
import {createGitHubRunReader} from './github-dispatch.mjs';
import {deriveDispatchKey} from './controller-dispatch.mjs';
import {commitAttestedSliceYield} from './dispatch-store.mjs';
import {readIssueWorkflowState} from './state-store.mjs';
import {failedDeveloperRetryActionId} from './outbox.mjs';
import {sealCheckpoint} from '../store/checkpoint.mjs';
import {publishEncryptedAgentCheckpoint,verifyCommittedCheckpoint} from '../store/remote.mjs';
import {openCursorNativeStore} from '../providers/cursor-native-store.mjs';

const REPO='BestNathan/nession',HEX40=/^[a-f0-9]{40}$/,HEX64=/^[a-f0-9]{64}$/;
const FILES=['agents.ndjson','checkpoints.ndjson','runs.ndjson','run_events.ndjson'];
function fail(s){throw Error('trusted Developer checkpoint ingest: '+s);}
const hash=x=>createHash('sha256').update(x).digest('hex');
function readJsonFromZip(zip,name,max=32*1024*1024) {
  if(!Buffer.isBuffer(zip)||zip.length<1||zip.length>max)fail('unsafe Artifact ZIP bytes');
  let raw,doc;
  try{raw=readWorkerZipMember(zip,name);doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}
  catch{fail('untrusted Artifact JSON: '+name);}
  if(!doc||typeof doc!=='object'||Array.isArray(doc))fail('invalid Artifact schema');
  return doc;
}
export function matchingResult(result,proof,sealed,claim,run) {
  const ticket=claim.inputs;
  const valid=doc=>doc?.issue===Number(ticket.issue_number)&&
    doc.action_id===ticket.action_id&&doc.source_sha===ticket.input_sha&&
    doc.run_id===run.id&&doc.attempt===run.run_attempt;
  if(run.status!=='completed'||run.conclusion!=='success'||
      !valid(result)||!valid(proof)||
      result.schema_version!==1||result.kind!=='developer_proposal'||
      result.status!=='proposed_not_published'||
      result.native_read_edit_verified!==true||
      result.file!=='e2e/fixtures/agent-development/1997-canary.txt'||
      result.content_sha256!==hash('Durable Worker fixture: complete\n')||
      proof.schema_version!==1||
      proof.kind!=='bounded-development-native-session'||
      sealed.schema_version!==1||
      sealed.kind!=='cursor-native-encrypted-snapshot'||
      proof.ciphertext_sha256!==sealed.ciphertext_sha256||
      !HEX64.test(sealed.ciphertext_sha256??'')||
      JSON.stringify(proof.metadata)!==JSON.stringify(sealed.metadata)||
      proof.metadata?.agent_id!==sealed.metadata?.agent_id||
      proof.metadata?.run_id!==run.id||
      proof.metadata?.attempt!==run.run_attempt||
      proof.metadata?.source_sha!==ticket.input_sha||
      !HEX64.test(proof.metadata?.harness_digest??''))
    fail('no authentic real bounded Cursor edit + encrypted native checkpoint');
  return proof.metadata;
}
function git(...args) {
  try{return execFileSync('git',args,{encoding:'utf8',timeout:45000,
    stdio:['ignore','pipe','pipe'],maxBuffer:2*1024*1024}).trim();}
  catch{fail('read-only Store Git access failed');}
}
export function readConfirmedDevelopmentState(remote,claim,run) {
  if(!remote||typeof remote!=='string'||/\s/.test(remote))
    fail('authenticated Store remote missing');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'trusted-development-reader-'));
  try{
    const dir=path.join(root,'store');
    git('clone','--no-tags','--single-branch','--branch','agent-store','--',remote,dir);
    const issue=Number(claim.inputs.issue_number);
    const record=readIssueWorkflowState(dir,issue);
    const action=record.state?.outbox.find(x=>x.id===claim.inputs.action_id);
    if(!action||action.task.type!=='dispatch'||action.task.role!=='developer'||
        action.task.task!=='implement'||action.task.agent_id!=='dev-cursor-01'||
        action.task.sha!==claim.inputs.input_sha||
        action.receipt?.source_run_id!==run.id||
        action.receipt?.dispatch_id!==claim.inputs.action_id||
        !['dispatched','yielded'].includes(action.status))
      fail('no authenticated exact Run-bound persisted dispatch to ingest');
    const prefix='roles/developer/dev-cursor-01/issues/'+issue;
    const runPath=prefix+'/runs/'+run.id+'-'+run.run_attempt+'.json';
    const checkpointPath=prefix+'/checkpoints/00000001.json';
    const runFile=path.join(dir,runPath),checkpointFile=path.join(dir,checkpointPath);
    let existing_checkpoint=null;
    if(fs.existsSync(runFile)||fs.existsSync(checkpointFile)){
      if(!fs.existsSync(runFile)||!fs.existsSync(checkpointFile))
        fail('partial or corrupted committed Run checkpoint');
      const receipt=JSON.parse(fs.readFileSync(runFile,'utf8'));
      const sealed=JSON.parse(fs.readFileSync(checkpointFile,'utf8'));
      if(receipt.run_id!==run.id||receipt.attempt!==run.run_attempt||
          receipt.source_sha!==claim.inputs.input_sha||
          receipt.workflow_sha!==run.head_sha||
          receipt.checkpoint_path!==checkpointPath||
          receipt.version!==1||sealed.path!==checkpointPath||
          sealed.ciphertext_sha256!==receipt.ciphertext_sha256)
        fail('conflicting immutable Run checkpoint replay');
      const commit_sha=git('-C',dir,'log','-1','--format=%H',
        'HEAD','--',checkpointPath);
      if(!HEX40.test(commit_sha))fail('checkpoint commit unavailable');
      existing_checkpoint={version:1,commit_sha,
        ciphertext_sha256:sealed.ciphertext_sha256,
        metadata:sealed.metadata};
    }
    return {state_version:record.version,action,
      already_yielded:action.status==='yielded',existing_checkpoint};
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
function deriveStoreAesKey(privateKey) {
  if(typeof privateKey!=='string'||privateKey.length<200)
    fail('missing trusted Store key seed');
  return Buffer.from(hkdfSync('sha256',Buffer.from(privateKey),
    Buffer.from(REPO),Buffer.from('nession-agent-native-checkpoint-store-v1'),32));
}
async function api(token,endpoint){
  const r=await fetch('https://api.github.com/repos/'+REPO+endpoint,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2026-03-10'}});
  if(!r.ok)fail('independent source GitHub API rejected request: '+r.status);
  return r.json();
}
const PINNED_RECOVERY_SOURCE_RUN=39288961865;
const PINNED_RECOVERY_COMMAND='/nession ingest issue=1997 worker_run=39288961865';
// The lack of a workflow_run delivery must not allow a result to be promoted
// by editing a Store file or by supplying an arbitrary Run ID. This manual
// recovery still re-reads GitHub, both Artifact digests, the HMAC Ticket and
// the original committed Store Run receipt before any writer operation.
export function resolveTrustedIngestSource({environment,event}){
  if(environment?.GITHUB_ACTIONS!=='true'||
      environment.GITHUB_REPOSITORY!==REPO||
      environment.GITHUB_REF!=='refs/heads/main'||
      environment.GITHUB_WORKFLOW!=='Store / Agent Development Ingest'||
      !HEX40.test(environment.GITHUB_SHA??''))
    fail('invalid main-owned trusted Ingest authority');
  if(environment.GITHUB_EVENT_NAME==='workflow_run'){
    const source=event?.workflow_run;
    if(event.action!=='completed'||source?.conclusion!=='success'||
        !Number.isSafeInteger(source?.id)||source.id<1)
      fail('only completed successful Worker may publish a checkpoint');
    return {run_id:source.id,source};
  }
  if(environment.GITHUB_EVENT_NAME==='issue_comment'){
    if(environment.GITHUB_ACTOR!=='BestNathan'||
        event?.action!=='created'||
        event.repository?.full_name!==REPO||
        event.issue?.number!==1997||
        event.issue?.pull_request||
        event.comment?.user?.login!=='BestNathan'||
        event.comment?.body!==PINNED_RECOVERY_COMMAND||
        !Number.isSafeInteger(event.comment.id)||event.comment.id<1)
      fail('manual checkpoint recovery requires exact owner/main Issue comment');
    return {run_id:PINNED_RECOVERY_SOURCE_RUN,source:null};
  }
  fail('unsupported Ingest trigger');
}

async function main(){
  if(process.argv.length!==5||process.argv[2]!=='ingest')fail('usage: ingest CLAIM_ZIP RESULT_ZIP');
  const env=process.env,token=env.ACTIONS_READ_TOKEN;
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPO||
      !['workflow_run','issue_comment'].includes(env.GITHUB_EVENT_NAME)||
      env.GITHUB_WORKFLOW!=='Store / Agent Development Ingest'||
      env.GITHUB_REF!=='refs/heads/main'||
      !HEX40.test(env.GITHUB_SHA??'')||
      typeof token!=='string'||token.length<8||
      !env.AGENT_STORE_CONTROLLER_REMOTE?.startsWith('https://x-access-token:')||
      typeof env.STORE_WRITER_PRIVATE_KEY!=='string'||!env.CURSOR_RESUME_PRIVATE_KEY_B64)
    fail('independent main-owned Store checkpoint Ingest required');
  const event=JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH,'utf8'));
  const authority=resolveTrustedIngestSource({environment:env,event});
  const reader=createGitHubRunReader(token);
  const run=await reader.getRun(authority.run_id);
  if(authority.source &&
     (run.id!==authority.source.id||
      run.run_attempt!==authority.source.run_attempt||
      run.head_sha!==authority.source.head_sha))
    fail('GitHub webhook/source Run mismatch');
  if(!authority.source &&
      (run.id!==PINNED_RECOVERY_SOURCE_RUN||run.run_attempt!==1||
       run.head_sha!=='e6e64eb84663f2bb935b9c0628d9ab787523186b'||
       run.conclusion!=='success'||run.status!=='completed'))
    fail('manual replay is not the exact successful isolated Worker');
  const artifacts=await api(token,'/actions/runs/'+run.id+'/artifacts?per_page=100');
  const verifiedClaim=authenticateWorkerClaimRun(run,artifacts);
  const matching=artifacts.artifacts.filter(a=>a.name===
    'development-worker-'+run.id+'-'+run.run_attempt);
  if(matching.length!==1||matching[0].expired!==false||
      matching[0].workflow_run?.id!==run.id||
      matching[0].workflow_run?.head_sha!==run.head_sha||
      !/^sha256:[a-f0-9]{64}$/.test(matching[0].digest??'')||
      matching[0].size_in_bytes<=0||
      matching[0].size_in_bytes>32*1024*1024)
    fail('missing/duplicate/unsafe encrypted Worker Artifact');
  const claimZip=fs.readFileSync(process.argv[3]);
  const claim=inspectWorkerClaimZip(claimZip,verifiedClaim.digest,run);
  const resultZip=fs.readFileSync(process.argv[4]);
  if(matching[0].digest!=='sha256:'+hash(resultZip))
    fail('encrypted Worker Artifact ZIP digest mismatch');
  const result=readJsonFromZip(resultZip,'result.json');
  const proof=readJsonFromZip(resultZip,'proof.json');
  const wrapped=readJsonFromZip(resultZip,'ciphertext.json');
  const metadata=matchingResult(result,proof,wrapped,claim,run);
  const rootKey=deriveDispatchKey(env.STORE_WRITER_PRIVATE_KEY);
  const aesKey=deriveStoreAesKey(env.STORE_WRITER_PRIVATE_KEY);
  try{
    const verified=await verifyWorkerClaimForAck({run,claim,key:rootKey,reader});
    if(verified.source_run_id!==run.id||verified.issue!==1997||
        ![
          '95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae',
          failedDeveloperRetryActionId(1997,
            '95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae',
            39267659650),
        ].includes(verified.action_id))
      fail('Developer scope not yet authorized outside #1997 fixture');
    const store=env.AGENT_STORE_CONTROLLER_REMOTE;
    const admission=readConfirmedDevelopmentState(store,claim,run);
    if(admission.already_yielded) {
      const receipt=admission.action.receipt;
      if(receipt?.source_run_id!==run.id||
          receipt.source_attempt!==run.run_attempt)fail('conflicting Slice replay');
      verifyCommittedCheckpoint({remote:store,
        identity:{role:'developer',agent_id:'dev-cursor-01',issue:1997},
        commit_sha:receipt.checkpoint_commit_sha,
        version:receipt.checkpoint_version,
        ciphertext_sha256:receipt.ciphertext_sha256});
      console.log(JSON.stringify({status:'replayed',run_id:run.id,
        state_version:admission.state_version}));
      return;
    }
    let published,encryptedDigest;
    const identity={role:'developer',agent_id:'dev-cursor-01',issue:1997};
    if(admission.existing_checkpoint) {
      // Recover a crash after checkpoint CAS but before Yield CAS WITHOUT
      // generating a new ciphertext or forging a new committed Run.
      const prior=admission.existing_checkpoint;
      if(prior.metadata?.provider!=='cursor'||
          prior.metadata.session_id!==metadata.agent_id||
          prior.metadata.source_sha!==claim.inputs.input_sha||
          prior.metadata.harness_digest!==metadata.harness_digest)
        fail('replayed Artifact conflicts with immutable native Session identity');
      verifyCommittedCheckpoint({remote:store,identity,
        commit_sha:prior.commit_sha,version:prior.version,
        ciphertext_sha256:prior.ciphertext_sha256});
      published={version:prior.version,commit_sha:prior.commit_sha};
      encryptedDigest=prior.ciphertext_sha256;
    }else{
      const temp=fs.mkdtempSync(path.join(os.tmpdir(),'trusted-development-unseal-'));
      let native;
      try{
        const nativeDir=path.join(temp,'native');
        const pem=Buffer.from(env.CURSOR_RESUME_PRIVATE_KEY_B64,'base64').toString('utf8');
        openCursorNativeStore({record:wrapped,expected:metadata,
          privateKeyPem:pem,directory:nativeDir});
        native=Buffer.from(JSON.stringify({schema_version:1,kind:'cursor-native-files',
          files:Object.fromEntries(FILES.map(name=>[
            name,fs.readFileSync(path.join(nativeDir,name)).toString('base64')]))}));
        const checkpointMetadata={provider:'cursor',
          session_id:metadata.agent_id,source_sha:claim.inputs.input_sha,
          harness_digest:metadata.harness_digest};
        const sealed=sealCheckpoint(identity,1,native,aesKey,checkpointMetadata);
        const source={repository:REPO,run_id:run.id,attempt:run.run_attempt,
          issue:1997,workflow_sha:run.head_sha,target_sha:claim.inputs.input_sha,
          head_branch:'main',path:run.path,workflow_name:run.name,
          role:'developer',agent_id:'dev-cursor-01',task:'implement',
          environment:'agent-dev-cursor-01',provider:'cursor',event:run.event};
        published=publishEncryptedAgentCheckpoint({
          remote:store,source,sealed,registry:JSON.parse(fs.readFileSync(
            'automation/agents/registry.json','utf8')),key:aesKey,expectedVersion:0});
        encryptedDigest=sealed.ciphertext_sha256;
      }finally{
        if(native)native.fill(0);
        fs.rmSync(temp,{recursive:true,force:true});
      }
    }
      // Second CAS advances canonical state only after the committed checkpoint
      // is independently verified against the remote Git commit.
      const advanced=await commitAttestedSliceYield({remote:store,issue:1997,
        dispatchTicket:claim.inputs.dispatch_ticket,keyring:{'main-controller':rootKey},
        reader,checkpoint:{version:published.version,commit_sha:published.commit_sha,
          ciphertext_sha256:encryptedDigest,run_id:run.id,
          attempt:run.run_attempt},verifiedMainSha:run.head_sha});
      console.log(JSON.stringify({status:advanced.status,run_id:run.id,
        checkpoint_version:published.version,
        checkpoint_commit_sha:published.commit_sha,
        workflow_state_version:advanced.state_version,
        workflow_commit_sha:advanced.store_commit_sha}));
  }finally{rootKey.fill(0);aesKey.fill(0);}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
