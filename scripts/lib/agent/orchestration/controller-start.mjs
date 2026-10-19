#!/usr/bin/env node
// #1664: trusted, one-shot Controller root in the existing agent-store.
// This process MUST run outside Provider tools; it never spawns a model,
// dispatches a Worker, approves a PR or writes an Issue comment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
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
          version:previous.version,commit_sha:git(work,['rev-parse','HEAD']),
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
function validatedEvent(){
  if(process.env.GITHUB_ACTIONS!=='true'||
      process.env.GITHUB_REPOSITORY!==REPO||
      process.env.GITHUB_REF!=='refs/heads/main'||
      process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
      process.env.GITHUB_WORKFLOW!=='Acceptance / Agent Controller'||
      !SHA.test(process.env.GITHUB_SHA??'')||
      !Number.isSafeInteger(Number(process.env.GITHUB_RUN_ID))||
      Number(process.env.GITHUB_RUN_ID)<1)fail('trusted main-only GitHub Controller required');
  let event;
  try{event=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));}
  catch{fail('trusted workflow_dispatch event unavailable');}
  if(!event||typeof event.inputs!=='object'||!event.inputs)fail('invalid Controller input event');
  const raw=event.inputs;
  const allowed=['issue_number','input_sha','developer','reviewer','acceptor'];
  if(Object.keys(raw).some(x=>!allowed.includes(x)))fail('unexpected dispatch input');
  const issue=Number(raw.issue_number);
  if(!Number.isSafeInteger(issue)||issue<1||!SHA.test(raw.input_sha??''))
    fail('invalid Issue or source SHA');
  if(!['developer','reviewer','acceptor'].every(x=>typeof raw[x]==='string'&&
       /^[a-z][a-z0-9-]{1,80}$/.test(raw[x])))fail('invalid Agent assignment');
  return {request:{issue,sha:raw.input_sha,
      developer:raw.developer,reviewer:raw.reviewer,acceptor:raw.acceptor},
    authority:{repository:REPO,event:'workflow_dispatch',
      permission:'write',ref:'refs/heads/main',run_id:Number(process.env.GITHUB_RUN_ID)}};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  try {
    if(process.argv[2]!=='--apply'||process.argv.length!==3)
      fail('usage: --apply (trusted main workflow_dispatch only)');
    const {request,authority}=validatedEvent();
    const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
    const remote=process.env.AGENT_STORE_CONTROLLER_REMOTE;
    const result=initializeIssueController({remote,registry,request,authority});
    console.log(JSON.stringify(result));
  }catch(e){console.error('::error::'+e.message);process.exitCode=1;}
}
