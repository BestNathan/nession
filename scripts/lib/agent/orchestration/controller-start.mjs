#!/usr/bin/env node
// #1664: trusted, one-shot Controller root in the existing agent-store.
// This process MUST run outside Provider tools; it never spawns a model,
// dispatches a Worker, approves a PR or writes an Issue comment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startDevelopment,validateDevelopmentState} from './outbox.mjs';
import {readIssueWorkflowState,writeIssueWorkflowState} from './state-store.mjs';
import {auditStagedRunStore} from '../../../run-store-integrity.mjs';
import {publish} from '../../../run-store-cas-push.mjs';

const REPO='BestNathan/nession',REF='agent-store',SHA=/^[a-f0-9]{40}$/;
function fail(reason){throw Error('Agent Controller start: '+reason);}
function git(root,args){
  try{
    return execFileSync('git',['-C',root,...args],{encoding:'utf8',
      stdio:['ignore','pipe','pipe'],timeout:45000,maxBuffer:2*1024*1024,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'}}).trim();
  }catch(e){fail('Git '+args[0]+' failed ('+(e.status??'unknown')+')');}
}
function repository(remote) {
  if(typeof remote!=='string'||remote.length>2000||!remote.length||/\s/.test(remote))
    fail('invalid trusted Store remote');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-controller-start-'));
  const work=path.join(temp,'store');
  try{
    execFileSync('git',['clone','--no-tags','--single-branch','--branch',REF,
      '--',remote,work],{encoding:'utf8',stdio:['ignore','pipe','pipe'],
      timeout:45000,maxBuffer:2*1024*1024,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'}});
    if(git(work,['symbolic-ref','--short','HEAD'])!==REF)fail('not an agent-store checkout');
    return {temp,work};
  }catch(e){
    fs.rmSync(temp,{recursive:true,force:true});
    if(e.message?.startsWith('Agent Controller start:'))throw e;
    fail('pre-bootstrapped agent-store ref unavailable');
  }
}
function exactRoot(state,expected) {
  validateDevelopmentState(state);
  const a=state.outbox?.[0];
  return state.version===1&&state.phase==='ready'&&state.transitions.length===0&&
    state.target_sha===null&&state.outbox.length===1&&
    a?.status==='pending'&&a.task?.type==='dispatch'&&
    a.task.role==='developer'&&a.task.task==='implement'&&
    a.task.sha===expected.outbox[0].task.sha&&
    a.id===expected.outbox[0].id&&
    JSON.stringify(state.assignments)===JSON.stringify(expected.assignments)&&
    JSON.stringify(state)===JSON.stringify(expected);
}
function originalControllerCommit(work,expected){
  // A replay is evidence of the FIRST immutable Issue initialization, not
  // whichever unrelated Issue happened to advance agent-store most recently.
  // git log is read-only; the immutable v1 state path is never overwritten.
  const file='workflows/issues/'+expected.issue+'/states/00000001.json';
  const origin=git(work,['log','-1','--format=%H','HEAD','--',file]);
  if(!SHA.test(origin))fail('immutable Controller origin commit unavailable');
  let committed,head;
  try{
    committed=JSON.parse(git(work,['show',origin+':'+file]));
    head=JSON.parse(git(work,['show',origin+':workflows/issues/'+expected.issue+'/head.json']));
  }catch{fail('original Controller commit lacks canonical immutable state/head');}
  const expectedDigest=createHash('sha256').update(
    Buffer.from(JSON.stringify(expected,null,2)+'\n')).digest('hex');
  if(JSON.stringify(committed)!==JSON.stringify(expected)||
      head?.version!==1||head?.path!==file||
      head?.sha256!==expectedDigest)
    fail('original Controller commit differs from authenticated replay state');
  return origin;
}

export function initializeIssueController({
  remote,registry,request,authority,onCandidate=null,
}) {
  const expected=startDevelopment(registry,request,authority);
  const {temp,work}=repository(remote);
  try {
    const previous=readIssueWorkflowState(work,request.issue);
    if(previous.state!==null){
      if(exactRoot(previous.state,expected)){
        return {created:false,replayed:true,issue:request.issue,
          version:previous.version,commit_sha:originalControllerCommit(work,expected),
          first_action_id:expected.outbox[0].id};
      }
      fail('Issue already initialized or advanced; never reset an existing workflow');
    }
    writeIssueWorkflowState(work,expected,0);
    git(work,['add','-A']);
    const audit=auditStagedRunStore(work,REF);
    if(audit.checked_changes!==2)
      fail('Controller start expected one immutable state and one head pointer');
    git(work,['-c','user.name=nession-agent-controller',
      '-c','user.email=nession-agent-controller@users.noreply.github.com',
      'commit','-m','agent-store: initialize Issue '+request.issue+' controller state']);
    if(onCandidate!==null){
      if(process.env.NODE_ENV!=='test')fail('candidate injection prohibited outside tests');
      onCandidate();
    }
    // Existing no-force, linear remote CAS; disjoint Issue initializations
    // can rebase without rewriting history or sharing another message bus.
    const published=publish(REF,work,4);
    return {created:!published.replayed,replayed:published.replayed,
      issue:request.issue,version:1,commit_sha:published.commit_sha,
      first_action_id:expected.outbox[0].id};
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
function validatedAttestedRequest(filename){
  if(process.env.GITHUB_ACTIONS!=='true'||
      process.env.GITHUB_REPOSITORY!==REPO||
      process.env.GITHUB_REF!=='refs/heads/main'||
      process.env.GITHUB_EVENT_NAME!=='workflow_run'||
      process.env.GITHUB_WORKFLOW!=='Store / Agent Controller Ingest'||
      !SHA.test(process.env.GITHUB_SHA??'')) {
    fail('trusted main-only Store Ingest required');
  }
  let event,document;
  try{
    event=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
    const stat=fs.lstatSync(filename);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768)fail('unsafe authenticated request file');
    document=JSON.parse(fs.readFileSync(filename,'utf8'));
  }catch(e){
    if(e.message?.startsWith('Agent Controller start:'))throw e;
    fail('authenticated Controller request unavailable');
  }
  const source=event?.workflow_run;
  const run=document?.run;
  if(document.schema_version!==1||
      document.kind!=='agent_controller_start_request'||
      !run||run.repository!==REPO||
      run.workflow!=='Acceptance / Agent Controller'||
      run.workflow_path!=='.github/workflows/acceptance-agent-controller.yml'||
      run.event!=='workflow_dispatch'||run.ref!=='refs/heads/main'||
      run.actor!=='BestNathan'||!SHA.test(run.head_sha??'')||
      source?.id!==run.run_id||source?.run_attempt!==run.attempt||
      source?.head_sha!==run.head_sha||
      source?.head_repository?.full_name!==REPO||
      source?.repository?.full_name!==REPO||
      source?.head_branch!=='main'||source?.conclusion!=='success') {
    fail('untrusted Controller source Run/Attempt/Issue context');
  }
  const input=document.request;
  if(!input||!Number.isSafeInteger(input.issue)||input.issue<1||
      !SHA.test(input.sha??''))fail('invalid authenticated Issue/source SHA');
  return {request:input,authority:{repository:REPO,event:'workflow_dispatch',
    permission:'write',ref:'refs/heads/main',run_id:run.run_id}};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  try {
    if(process.argv[2]!=='--apply'||process.argv.length!==4)
      fail('usage: --apply AUTHENTICATED_REQUEST_JSON (trusted main workflow_run only)');
    const {request,authority}=validatedAttestedRequest(process.argv[3]);
    const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
    const remote=process.env.AGENT_STORE_CONTROLLER_REMOTE;
    const result=initializeIssueController({remote,registry,request,authority});
    console.log(JSON.stringify(result));
  }catch(e){console.error('::error::'+e.message);process.exitCode=1;}
}
