#!/usr/bin/env node
// #1664 SC-05: authenticate a projected Reviewer Issue comment against the
// latest signed Store transition BEFORE resuming the same Qwen Developer.
// The model receives the comment as context, never as authorization.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readIssueWorkflowState} from './state-store.mjs';
import {formatReviewerIssueReceipt,authenticateReviewerRun}
  from './reviewer-result-ingest.mjs';
import {createGitHubRunReader} from './github-dispatch.mjs';
import {createGitHubResultArtifactReader,readAuthenticatedReviewerVerdict}
  from './result-artifact.mjs';

const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/,HEX=/^[a-f0-9]{64}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const marker=/^<!-- nession-review-result:v1:([1-9][0-9]*):([a-f0-9]{64}):([1-9][0-9]*):1 -->\n/;
const fail=s=>{throw Error('Qwen Reviewer Issue context: '+s);};
function read(file,max){
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size<1||st.size>max)
    fail('missing or unsafe bounded source');
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch{fail('invalid bounded source JSON');}
}
function git(dir,...args){
  try{return execFileSync('git',['-C',dir,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,
    maxBuffer:1024*1024,env:{...process.env,
      GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'}}).trim();}
  catch{fail('immutable canonical Store Git proof unavailable');}
}
export function attestQwenRepairIssueReview({
  admission,state,comments,readReceipt,readCommitState,verdict,
}){
  const latest=state?.transitions?.at(-1);
  const actions=state?.outbox?.filter(x=>x.id===admission?.action_id);
  const action=actions?.length===1?actions[0]:null;
  if(admission?.authorized!==true||admission.role!=='developer'||
      admission.task!=='repair'||admission.agent_id!=='dev-qwen-01'||
      admission.provider!=='claude-code'||
      admission.environment!=='dev-claude-qwen'||
      !positive(admission.issue)||!positive(admission.run_id)||
      !HEX.test(admission.action_id??'')||
      !SHA.test(admission.input_sha??'')||
      state?.issue!==admission.issue||state.phase!=='repair'||
      state.target_sha!==admission.input_sha||
      state.assignments?.developer!=='dev-qwen-01'||
      state.assignments?.reviewer!=='review-qwen-01'||
      latest?.kind!=='reviewer'||latest.outcome!=='changes_requested'||
      latest.target_sha!==admission.input_sha||!positive(latest.run_id)||
      latest.attempt!==1||!action||action.status!=='dispatched'||
      action.task?.role!=='developer'||action.task.task!=='repair'||
      action.task.agent_id!=='dev-qwen-01'||
      action.task.sha!==admission.input_sha||action.task.resume!==true||
      action.task.repair_checkpoint==null||
      action.receipt?.status!=='verified'||
      action.receipt.dispatch_id!==admission.action_id||
      action.receipt.source_run_id!==admission.run_id)
    fail('no authenticated current same-Developer Repair dispatch');
  if(!Array.isArray(comments)||comments.length>2000||
      typeof readReceipt!=='function'||typeof readCommitState!=='function')
    fail('bounded Issue comments and immutable Store readers required');
  const matches=comments.filter(c=>{
    if(c?.user?.login!=='github-actions[bot]'||
        typeof c.body!=='string'||Buffer.byteLength(c.body)>8192)return false;
    const m=marker.exec(c.body);
    return m&&Number(m[1])===admission.issue&&Number(m[3])===latest.run_id;
  });
  if(matches.length!==1)
    fail('missing or duplicated latest bot-authored Reviewer projection');
  const comment=matches[0],actionId=marker.exec(comment.body)[2];
  if(!positive(comment.id)||
      comment.issue_url!=='https://api.github.com/repos/'+REPO+
        '/issues/'+admission.issue||
      !Number.isFinite(Date.parse(comment.created_at??'')))
    fail('Reviewer Issue comment is not a GitHub source object');
  const receipt=readReceipt(latest.run_id,actionId);
  if(receipt?.issue!==admission.issue||receipt.action_id!==actionId||
      receipt.result?.kind!=='reviewer'||
      receipt.result.run_id!==latest.run_id||
      receipt.result.run_attempt!==1||
      receipt.result.outcome!=='changes_requested'||
      receipt.result.target_sha!==admission.input_sha||
      receipt.source?.agent_id!=='review-qwen-01'||
      receipt.source.input_sha!==admission.input_sha||
      receipt.source.task_id!==actionId||
      !positive(receipt.implementing_pr?.number))
    fail('no authenticated Store Reviewer Result matching Issue projection');
  const source=comment.body.match(
    /- Committed Store: \x60([a-f0-9]{40})\x60, workflow state v([1-9][0-9]*)\n/);
  if(!source)fail('unattributed Reviewer Store commit');
  const storeSha=source[1],version=Number(source[2]);
  const historical=readCommitState(storeSha,version);
  const signed=historical?.transitions?.at(-1);
  if(historical?.phase!=='repair'||
      historical.target_sha!==admission.input_sha||
      signed?.kind!=='reviewer'||signed.outcome!=='changes_requested'||
      signed.run_id!==latest.run_id||signed.attempt!==1||
      signed.target_sha!==admission.input_sha)
    fail('Review comment points to unrelated committed Store state');
  if(comment.body!==formatReviewerIssueReceipt(receipt,storeSha,version,verdict))
    fail('Issue comment differs from canonical Reviewer receipt bytes');
  return Object.freeze({schema_version:1,
    kind:'authenticated_qwen_repair_issue_review_context',
    issue:admission.issue,source_sha:admission.input_sha,
    developer_action_id:admission.action_id,
    reviewer_action_id:actionId,reviewer_run_id:latest.run_id,
    comment_id:comment.id,store_commit_sha:storeSha,
    store_version:version,body:comment.body});
}
async function main(){
  if(process.argv.length!==6||process.argv[2]!=='verify')
    fail('usage: verify ADMISSION_JSON COMMENTS_JSON OUTPUT_JSON');
  const env=process.env,admission=read(process.argv[3],8192);
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPO||
      env.GITHUB_REF!=='refs/heads/main'||
      env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
      env.GITHUB_WORKFLOW!=='Agent / Development'||
      env.GITHUB_ACTOR!=='github-actions[bot]'||
      env.GITHUB_RUN_ATTEMPT!=='1'||
      Number(env.GITHUB_RUN_ID)!==admission.run_id||
      admission.task!=='repair')
    fail('only the authenticated Qwen main Repair Worker may read context');
  const comments=read(process.argv[4],2*1024*1024);
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-review-context-'));
  try{
    const dir=path.join(tmp,'store');
    try{execFileSync('git',['clone','--quiet','--no-tags','--single-branch',
      '--branch','agent-store','--','https://github.com/'+REPO+'.git',dir],{
      timeout:45000,stdio:['ignore','pipe','pipe'],
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'}});}
    catch{fail('read-only agent-store clone unavailable');}
    const state=readIssueWorkflowState(dir,admission.issue).state;
    const receipt=(run,actionId)=>read(path.join(dir,'workflows/issues/'+
      admission.issue+'/results/'+run+'-1-'+actionId+'.json'),65536);
    const historical=(sha,version)=>{
      git(dir,'merge-base','--is-ancestor',sha,'HEAD');
      const prefix='workflows/issues/'+admission.issue;
      const head=JSON.parse(git(dir,'show',sha+':'+prefix+'/head.json'));
      if(head.version!==version||
          head.path!==prefix+'/states/'+String(version).padStart(8,'0')+'.json')
        fail('review comment refers to wrong Store state version');
      return JSON.parse(git(dir,'show',sha+':'+head.path));
    };
    // The bot comment only selects a candidate; the committed Reviewer
    // result and independently authenticated original ZIP decide its meaning.
    const latest=state?.transitions?.at(-1);
    const markerMatch=comments.filter(c=>
      c?.user?.login==='github-actions[bot]'&&
      typeof c.body==='string'&&
      marker.exec(c.body)?.[3]===String(latest?.run_id));
    if(markerMatch.length!==1)fail('missing unique latest Review comment');
    const actionId=marker.exec(markerMatch[0].body)?.[2];
    const storedReceipt=receipt(latest.run_id,actionId);
    const reader=createGitHubRunReader(env.GH_TOKEN);
    const run=await reader.getRun(latest.run_id);
    authenticateReviewerRun(run,latest.run_id,1);
    const artifactReader=createGitHubResultArtifactReader(env.GH_TOKEN);
    const verdict=await readAuthenticatedReviewerVerdict({
      artifactReader,run,receipt:storedReceipt});
    const verified=attestQwenRepairIssueReview({
      admission,state,comments,readReceipt:receipt,
      readCommitState:historical,verdict});
    fs.writeFileSync(process.argv[5],JSON.stringify(verified)+'\n',
      {flag:'wx',mode:0o600});
    console.log('Latest Qwen Reviewer Issue comment authenticated from Store');
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
