#!/usr/bin/env node
// #2010 Trusted independent Worker Run claim reconciliation. Only a main-owned
// workflow_run job reads the GitHub API, checks an exact Artifact digest, HMAC,
// immutable prepared Ticket hash, Controller issuer and real Worker Run, then
// performs a Git CAS ACK. Never re-POST workflow_dispatch.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readWorkerZipMember} from './worker-zip.mjs';
import {canonicalJson} from '../harness/contract.mjs';
import {createWorkerClaim} from './worker-claim.mjs';
import {verifyDispatchTicket,createGitHubRunReader} from './github-dispatch.mjs';
import {acknowledgeCommittedDispatch} from './dispatch-store.mjs';
import {deriveDispatchKey} from './controller-dispatch.mjs';

const REPO='BestNathan/nession',PATH='.github/workflows/agent-develop.yml';
const ISSUER='.github/workflows/agent-controller-dispatch.yml';
const HEX40=/^[a-f0-9]{40}$/,HEX64=/^[a-f0-9]{64}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
function fail(s){throw Error('Agent Worker Run reconcile: '+s);}
const sha256=b=>createHash('sha256').update(b).digest('hex');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function authenticateWorkerClaimRun(run,artifacts){
  if(!positive(run?.id)||!positive(run?.run_attempt)||
      run?.path!==PATH||run?.name!=='Agent / Development'||
      run?.event!=='workflow_dispatch'||run?.head_branch!=='main'||
      run?.repository?.full_name!==REPO||
      run?.head_repository?.full_name!==REPO||
      run?.actor?.login!=='github-actions[bot]'||!HEX40.test(run.head_sha??'')||
      run?.status!=='completed'||!['success','failure'].includes(run.conclusion)||
      !Number.isFinite(Date.parse(run.created_at??'')))
    fail('untrusted Worker GitHub Run');
  const matches=artifacts?.artifacts?.filter(x=>
    x.name==='development-worker-claim-'+run.id+'-'+run.run_attempt);
  if(!Array.isArray(matches)||matches.length!==1||!positive(matches[0].id)||
      matches[0].expired!==false||
      !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest??'')||
      !positive(matches[0].size_in_bytes)||matches[0].size_in_bytes>256*1024||
      matches[0].workflow_run?.id!==run.id||
      matches[0].workflow_run?.head_sha!==run.head_sha)
    fail('missing, duplicate or untrusted claim Artifact');
  return {artifact_id:matches[0].id,digest:matches[0].digest};
}
export function inspectWorkerClaimZip(zip,digest,run) {
  if(!Buffer.isBuffer(zip)||zip.length<1||zip.length>256*1024||
      digest!=='sha256:'+sha256(zip))
    fail('claim ZIP SHA-256 does not match authenticated Artifact digest');
  let claim;
  try{claim=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(
    readWorkerZipMember(zip,'development-worker-claim.json')));}
  catch{fail('invalid bounded Worker claim Artifact');}
  const context={repository:REPO,ref:'refs/heads/main',
    event:'workflow_dispatch',workflow:'Agent / Development',
    actor:'github-actions[bot]',head_sha:run.head_sha,
    run_id:run.id,attempt:run.run_attempt};
  const canonical=createWorkerClaim(claim?.inputs,context);
  if(!equal(claim,canonical))fail('claim identity diverged from authenticated GitHub Run');
  return claim;
}
export async function verifyWorkerClaimForAck({run,claim,key,reader}) {
  if(!Buffer.isBuffer(key)||key.length!==32||typeof reader?.getRun!=='function')
    fail('missing trusted Ticket verifier');
  const ticket=verifyDispatchTicket(claim?.inputs?.dispatch_ticket,
    {'main-controller':key},{allowExpired:true});
  if(ticket.role!=='developer'||ticket.task!==claim.inputs.task||
      ticket.issue!==Number(claim.inputs.issue_number)||
      ticket.action_id!==claim.inputs.action_id||
      ticket.agent_id!==claim.inputs.agent_id||
      ticket.input_sha!==claim.inputs.input_sha||
      ticket.repository!==REPO||
      ticket.schema_version===2 !== Object.hasOwn(claim.inputs,'resume_from')||
      (ticket.schema_version===2&&claim.inputs.resume_from!==
        Buffer.from(canonicalJson(ticket.resume_from)).toString('base64url')))
    fail('claim does not match signed Developer dispatch');
  const created=Date.parse(run.created_at??'');
  if(!Number.isFinite(created)||created<ticket.issued_at-30000||
      created>ticket.expires_at+30000)
    fail('downstream Run created outside signed dispatch window');
  const issuer=await reader.getRun(ticket.issuer_run_id);
  if(issuer?.id!==ticket.issuer_run_id||
      issuer.path!==ISSUER||issuer.name!=='Agent / Controller Dispatch'||
      !['workflow_dispatch','issue_comment'].includes(issuer.event)||issuer.head_branch!=='main'||
      issuer.actor?.login!=='BestNathan'||issuer.run_attempt!==1||
      issuer.repository?.full_name!==REPO||
      issuer.head_repository?.full_name!==REPO||
      issuer.head_sha!==run.head_sha)
    fail('signed issuer does not match main-owned Controller Run');
  return Object.freeze({issue:ticket.issue,action_id:ticket.action_id,
    ticket_sha256:sha256(claim.inputs.dispatch_ticket),
    source_run_id:run.id,attempt:run.run_attempt});
}
// A failure after model execution must NEVER trigger another model call.
// Only the exact pre-model admission gate failure can safely rerun the SAME
// GitHub Run ID (attempt 2), after its Store Run receipt has been committed.
export function eligiblePreflightRerun(run,jobs) {
  if(run?.conclusion!=='failure'||run?.run_attempt!==1||
      jobs?.total_count!==1||!Array.isArray(jobs?.jobs)||
      jobs.jobs.length!==1)return false;
  const job=jobs.jobs[0],steps=job?.steps;
  if(job?.run_id!==run.id||job.status!=='completed'||
      job.conclusion!=='failure'||job.name!=='developer'||
      !Array.isArray(steps))return false;
  const exact=name=>steps.filter(s=>s.name===name);
  const gate=exact('Require exact authenticated Run ID from immutable Store receipt');
  const claim=exact('Upload Worker claim for independent HMAC and Store reconciliation');
  const model=exact('Execute authenticated bounded real Developer slice');
  if(gate.length!==1||gate[0].conclusion!=='failure'||
      claim.length!==1||claim[0].conclusion!=='success'||
      model.length>1)return false;
  // A denied preflight is the only condition eligible for retry. Never rerun
  // a Run that started the model, uploaded an outcome, or reached checkpoint IO.
  if(model.length===1 && ![null,'skipped'].includes(model[0].conclusion))
    return false;
  return true;
}
async function api(token,resource){
  const r=await fetch('https://api.github.com/repos/'+REPO+resource,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2026-03-10'}});
  if(!r.ok)fail('trusted GitHub read failed ('+r.status+')');
  return r.json();
}
async function main(){
  if(process.argv.length!==4||process.argv[2]!=='reconcile')
    fail('usage: reconcile CLAIM_ZIP_PATH (only main-owned workflow_run)');
  const env=process.env;
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPO||
      env.GITHUB_EVENT_NAME!=='workflow_run'||
      env.GITHUB_REF!=='refs/heads/main'||
      env.GITHUB_WORKFLOW!=='Store / Agent Dispatch Reconcile'||
      !HEX40.test(env.GITHUB_SHA??'')||
      typeof env.ACTIONS_DISPATCH_TOKEN!=='string'||
      typeof env.STORE_WRITER_PRIVATE_KEY!=='string'||
      !env.AGENT_STORE_CONTROLLER_REMOTE?.startsWith('https://x-access-token:'))
    fail('reconciliation is not running in the trusted Controller credential boundary');
  const event=JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH,'utf8'));
  const source=event.workflow_run;
  if(event.action!=='completed'||source?.path!==PATH||
      source?.repository?.full_name!==REPO||
      source?.head_repository?.full_name!==REPO||
      source?.actor?.login!=='github-actions[bot]')
    fail('untrusted workflow_run source');
  const reader=createGitHubRunReader(env.ACTIONS_DISPATCH_TOKEN);
  // Independent API read, never use payload-controlled claim as GitHub evidence.
  const run=await reader.getRun(source.id);
  if(source.id!==run.id||source.run_attempt!==run.run_attempt||
      source.head_sha!==run.head_sha||source.conclusion!==run.conclusion)
    fail('workflow_run webhook differs from independent GitHub API read');
  const artifacts=await api(env.ACTIONS_DISPATCH_TOKEN,
    '/actions/runs/'+run.id+'/artifacts?per_page=100');
  const auth=authenticateWorkerClaimRun(run,artifacts);
  const zip=fs.readFileSync(process.argv[3]);
  const claim=inspectWorkerClaimZip(zip,auth.digest,run);
  const key=deriveDispatchKey(env.STORE_WRITER_PRIVATE_KEY);
  try{
    const attested=await verifyWorkerClaimForAck({run,claim,key,reader});
    const result=acknowledgeCommittedDispatch({
      remote:env.AGENT_STORE_CONTROLLER_REMOTE,
      issue:attested.issue,actionId:attested.action_id,
      ticketSha256:attested.ticket_sha256,
      receipt:{status:'verified',dispatch_id:attested.action_id,
        source_run_id:attested.source_run_id},
    });
    const jobs=run.conclusion==='failure'&&run.run_attempt===1
      ?await api(env.ACTIONS_DISPATCH_TOKEN,
        '/actions/runs/'+run.id+'/jobs?per_page=100'):null;
    const mayRerun=eligiblePreflightRerun(run,jobs);
    console.log(JSON.stringify({status:result.status,issue:attested.issue,
      action_id:attested.action_id,run_id:run.id,attempt:run.run_attempt,
      state_version:result.state_version,
      store_commit_sha:result.store_commit_sha,
      needs_rerun:mayRerun}));
  }finally{key.fill(0);}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
}
