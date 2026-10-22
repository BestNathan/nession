#!/usr/bin/env node
// #1664: READ-ONLY pre-model Worker admission. The Worker never receives a
// Store writer key or the Controller HMAC signing secret. Its exact GitHub
// run_id MUST already be acknowledged in an authenticated orphan Store state.
// The HMAC dispatch Ticket is authenticated through its persisted SHA-256 in
// an earlier immutable prepared state, not by sharing the signer secret.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readIssueWorkflowState,issueStatePath} from './state-store.mjs';
import {validateDevelopmentState} from './outbox.mjs';
import {resolveIdentity} from '../harness/contract.mjs';
import {verifyCommittedCheckpoint} from '../store/remote.mjs';

const REPO='BestNathan/nession',HEX40=/^[a-f0-9]{40}$/,HEX64=/^[a-f0-9]{64}$/;
const WORKFLOWS={
  developer:'Agent / Development',
  reviewer:'Agent / Review',
};
const ACTIONS={
  developer:['implement','repair'],
  reviewer:['review'],
};
function deny(s){throw Error('Agent Worker preflight: '+s);}
const sha256=s=>createHash('sha256').update(s).digest('hex');
const positive=n=>Number.isSafeInteger(n)&&n>0;
const canon=value=>JSON.stringify(Object.fromEntries(
  Object.keys(value).sort().map(k=>[k,value[k]])));
function clone(remote){
  if(typeof remote!=='string'||!remote||remote.length>2000||
      /\s/.test(remote))deny('invalid read-only Store remote');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-worker-preflight-'));
  const dir=path.join(temp,'agent-store');
  try{
    execFileSync('git',['clone','--no-tags','--single-branch','--branch',
      'agent-store','--',remote,dir],{
      encoding:'utf8',timeout:45000,stdio:['ignore','pipe','pipe'],
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
    });
    return {temp,dir};
  }catch{
    fs.rmSync(temp,{recursive:true,force:true});
    deny('trusted Store read unavailable');
  }
}
function strictInput(input,role){
  const names=['action_id','issue_number','agent_id','task','input_sha',
    'dispatch_ticket','resume_from'];
  if(!input||typeof input!=='object'||Array.isArray(input)||
      Object.keys(input).some(k=>!names.includes(k))||
      Object.keys(input).length<6||Object.keys(input).length>7||
      !HEX64.test(input.action_id??'')||
      !/^[1-9]\d*$/.test(input.issue_number??'')||
      !/^[a-z][a-z0-9-]{1,80}$/.test(input.agent_id??'')||
      !ACTIONS[role]?.includes(input.task)||
      !HEX40.test(input.input_sha??'')||
      typeof input.dispatch_ticket!=='string'||
      input.dispatch_ticket.length>1800||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.dispatch_ticket)) {
    deny('invalid or extra Worker input');
  }
  if(Object.hasOwn(input,'resume_from')&&
      (typeof input.resume_from!=='string'||input.resume_from.length>600||
       !/^[A-Za-z0-9_-]+$/.test(input.resume_from)))
    deny('invalid signed native continuation input');
  const ticketBytes=Buffer.from(input.dispatch_ticket.split('.')[0],'base64url');
  let ticket;
  try{ticket=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(ticketBytes));}
  catch{deny('invalid native Dispatch Ticket');}
  if(![1,2].includes(ticket.schema_version)||
      ticket.issue!==Number(input.issue_number)||
      ticket.action_id!==input.action_id||
      ticket.agent_id!==input.agent_id||
      ticket.role!==role||ticket.task!==input.task||
      ticket.input_sha!==input.input_sha||
      (ticket.schema_version===1&&Object.hasOwn(input,'resume_from'))||
      (ticket.schema_version===2&&!Object.hasOwn(input,'resume_from'))) {
    deny('Worker inputs differ from canonical Ticket identity');
  }
  if(ticket.schema_version===2&&
      input.resume_from!==Buffer.from(canon(ticket.resume_from))
        .toString('base64url'))deny('Worker native continuation differs from Ticket');
  return ticket;
}
function historicalPrepared(root,issue,actionId,ticketDigest,headVersion){
  // Keep reading bounded; a live outstanding Dispatch must be acknowledged
  // immediately after preparation. If older than 64 state steps, fail closed
  // rather than accepting a mismatched/orphaned work request.
  for(let v=headVersion;v>=Math.max(1,headVersion-64);v--){
    const file=path.join(root,issueStatePath(issue,v));
    if(!fs.existsSync(file))continue;
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>512*1024)
      deny('unsafe immutable Dispatch history');
    let history;
    try{history=JSON.parse(fs.readFileSync(file,'utf8'));}
    catch{deny('corrupt immutable Dispatch history');}
    validateDevelopmentState(history);
    const event=history.outbox.find(x=>x.id===actionId);
    if(event?.status==='dispatching'){
      if(event.receipt?.ticket_sha256!==ticketDigest||
          event.receipt?.status!=='prepared')deny('conflicting historic Ticket digest');
      return event;
    }
  }
  deny('no immutable committed write-ahead Dispatch history');
}
export function authorizeWorkerFromStore({remote,registry,role,runId,input}) {
  if(!ACTIONS[role]||!positive(runId))deny('unsupported Worker role/Run');
  const ticket=strictInput(input,role);
  const issue=Number(input.issue_number);
  const {temp,dir}=clone(remote);
  try{
    const record=readIssueWorkflowState(dir,issue);
    if(!record.state)deny('Issue has no persisted Controller state');
    const state=record.state;
    const action=state.outbox.find(x=>x.id===input.action_id);
    if(!action||action.status!=='dispatched'||
        action.receipt?.status!=='verified'||
        action.receipt.source_run_id!==runId||
        action.receipt.dispatch_id!==input.action_id||
        action.task.type!=='dispatch'||action.task.role!==role||
        action.task.task!==input.task||action.task.agent_id!==input.agent_id||
        action.task.sha!==input.input_sha||
        state.assignments[role]!==input.agent_id||
        ticket.state_version>=record.version)
      deny('no exact authenticated run-bound Store dispatch receipt');
    const registered=registry?.instances?.[input.agent_id];
    if(!registered||registered.role!==role)deny('unregistered Worker identity');
    const identity=resolveIdentity(registry,input.agent_id,input.task,
      registered.environment);
    const prior=historicalPrepared(dir,issue,action.id,
      sha256(input.dispatch_ticket),record.version);
    if(prior.task.role!==action.task.role||
       prior.task.agent_id!==action.task.agent_id||
       prior.task.task!==action.task.task||
       prior.task.sha!==action.task.sha)
      deny('immutable prepared and acknowledged Worker identities diverge');
    const c=action.task.continuation;
    if(c){
      if(ticket.schema_version!==2||
          canon(c)!==canon(ticket.resume_from))deny('native continuation mismatch');
      verifyCommittedCheckpoint({remote,
        identity:{role,agent_id:input.agent_id,issue},
        commit_sha:c.checkpoint_commit_sha,version:c.checkpoint_version,
        ciphertext_sha256:c.ciphertext_sha256});
    }else if(ticket.schema_version!==1)deny('unexpected resume for initial Worker');
    return Object.freeze({authorized:true,issue,role,agent_id:input.agent_id,
      provider:registered.provider,environment:registered.environment,
      action_id:action.id,run_id:runId,input_sha:input.input_sha,
      state_version:record.version,task:input.task,
      ...(c?{resume_from:c}:{}),capability_digest:identity.digest??null});
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
function main(){
  if(process.argv.length!==4||process.argv[2]!=='verify')deny('usage: verify OUTPUT_JSON');
  const expectedRole=Object.entries(WORKFLOWS).find(([,name])=>
    name===process.env.GITHUB_WORKFLOW)?.[0];
  if(process.env.GITHUB_ACTIONS!=='true'||
      process.env.GITHUB_REPOSITORY!==REPO||
      process.env.GITHUB_REF!=='refs/heads/main'||
      process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
      !expectedRole)deny('not a trusted main Worker workflow_dispatch');
  const input=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')).inputs;
  if(input?.resume_from==='')delete input.resume_from;
  const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
  const result=authorizeWorkerFromStore({
    remote:'https://github.com/BestNathan/nession.git',registry,
    role:expectedRole,runId:Number(process.env.GITHUB_RUN_ID),input,
  });
  fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n',
    {flag:'wx',mode:0o600});
  console.log('Authenticated Worker '+result.action_id+' for exact trusted Run '+result.run_id);
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  try{main();}catch(e){console.error('::error::'+e.message);process.exitCode=1;}
}
