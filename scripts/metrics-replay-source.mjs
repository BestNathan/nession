#!/usr/bin/env node
// #1690 SC-09: main-owned, read-only authorization of Metrics replay requests.
// A user-selected workflow_dispatch ref never receives any Store writer token.
// The *separate* scheduled Metrics writer receives a workflow_run wake, then
// verifies this source against GitHub's independent REST run + workflow + main
// ref identities BEFORE any health computation or privileged publish job.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

export const REPO='BestNathan/nession';
export const REQUEST_PATH='.github/workflows/metrics-replay-request.yml';
export const REQUEST_NAME='Metrics / Replay Request';
const HEX40=/^[a-f0-9]{40}$/;
const positive=v=>Number.isSafeInteger(v)&&v>0;
const no=m=>{throw Error('Metrics Replay refused: '+m);};
const pathOf=s=>String(s??'').replace(/@refs\/heads\/main$/,'');
export function attestReplay({ctx,event,source,workflow,main}){
  if(ctx?.repository!==REPO||ctx?.event!=='workflow_run'||
     ctx?.ref!=='refs/heads/main'||!HEX40.test(ctx.sha??''))
    no('privileged recipient must be default-main workflow_run');
  if(event?.action!=='completed'||event?.repository?.full_name!==REPO||
     !event?.workflow_run||event?.workflow_run?.event!=='workflow_dispatch')
    no('unexpected wake-up event or upstream trigger');
  const wake=event.workflow_run;
  if(source?.id!==wake.id||source?.run_attempt!==wake.run_attempt||
     source?.head_sha!==wake.head_sha||source?.workflow_id!==wake.workflow_id)
    no('GitHub upstream REST identity does not match the triggering event');
  if(!positive(source?.id)||!positive(source?.run_attempt)||
     !positive(source?.workflow_id)||!HEX40.test(source?.head_sha??'')||
     !source?.created_at||!Number.isFinite(Date.parse(source.created_at)))
    no('invalid source run identity');
  if(source.status!=='completed'||source.conclusion!=='success'||
     source.event!=='workflow_dispatch'||source.head_branch!=='main'||
     source.repository?.full_name!==REPO||
     source.head_repository?.full_name!==REPO||
     source.name!==REQUEST_NAME||pathOf(source.path)!==REQUEST_PATH||
     workflow?.id!==source.workflow_id||workflow?.path!==REQUEST_PATH||
     workflow?.name!==REQUEST_NAME)
    no('untrusted dispatch source, branch or workflow');
  // GitHub Actions re-runs can be initiated by a different triggering actor.
  // Both the original requestor and the latest re-run initiator must be owner.
  if(source.actor?.login?.toLowerCase()!=='bestnathan'||
     source.triggering_actor?.login?.toLowerCase()!=='bestnathan')
    no('only repository owner may request or re-run Metrics replay');
  // In particular, a branch-selected dispatcher with the same *name* cannot
  // publish; the exact source SHA must still equal the current trusted main.
  if(!HEX40.test(main?.object?.sha??'')||
     main.object.sha!==ctx.sha||source.head_sha!==ctx.sha)
    no('main SHA drift or non-main dispatched code');
  if(wake.head_branch!=='main'||wake.head_sha!==ctx.sha||
     wake.head_repository?.full_name!==REPO||
     wake.repository?.full_name!==REPO)
    no('untrusted wake-up provenance');
  return Object.freeze({status:'authorized',mode:'owner_main_manual_replay',
    repository:REPO,source_run_id:source.id,source_attempt:source.run_attempt,
    source_sha:ctx.sha,workflow_id:source.workflow_id});
}
function ctxFrom(env){return {repository:env.GITHUB_REPOSITORY,event:env.GITHUB_EVENT_NAME,
  ref:env.GITHUB_REF,sha:env.GITHUB_SHA};}
function requireSchedule(ctx){
  if(ctx.repository!==REPO||ctx.event!=='schedule'||
     ctx.ref!=='refs/heads/main'||!HEX40.test(ctx.sha??''))
    no('schedule must be exact trusted main');
  return {status:'authorized',mode:'scheduled',repository:REPO,source_sha:ctx.sha};
}
async function getJson(endpoint,token){
  const res=await fetch('https://api.github.com/repos/'+REPO+endpoint,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28'},
    signal:AbortSignal.timeout(30000)});
  if(!res.ok)no('authenticated GitHub GET failed: '+res.status);
  return await res.json();
}
async function authorize(){
  const ctx=ctxFrom(process.env);
  let statement;
  if(ctx.event==='schedule')statement=requireSchedule(ctx);
  else if(ctx.event==='workflow_run'){
    const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
    if(typeof token!=='string'||token.length<10)no('missing read-only Actions token');
    const file=process.env.GITHUB_EVENT_PATH;
    if(!file||fs.lstatSync(file).size>512*1024)no('missing/oversized GitHub event');
    const event=JSON.parse(fs.readFileSync(file,'utf8'));
    const id=event?.workflow_run?.id;
    if(!positive(id))no('missing GitHub upstream run ID');
    const [source,main]=await Promise.all([
      getJson('/actions/runs/'+id,token),getJson('/git/ref/heads/main',token)]);
    if(!positive(source.workflow_id))no('upstream workflow ID invalid');
    const workflow=await getJson('/actions/workflows/'+source.workflow_id,token);
    statement=attestReplay({ctx,event,source,workflow,main});
  }else no('only schedule or attested workflow_run allowed');
  const output=process.env.GITHUB_OUTPUT;
  if(!output||!fs.existsSync(output))no('trusted output channel missing');
  fs.appendFileSync(output,
    'authorized=true\nmode='+statement.mode+'\nsource_sha='+statement.source_sha+'\n');
  if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    'Metrics replay authorizer: '+statement.mode+
    ', source SHA '+statement.source_sha+
    '. No downstream request artifacts, inputs or source code executed.\n');
  console.log(JSON.stringify(statement));
}
function selfTest(){
  const sha='a'.repeat(40),id=234567,workflowId=1234;
  const ctx={repository:REPO,event:'workflow_run',ref:'refs/heads/main',sha};
  const actor={login:'BestNathan'}, repo={full_name:REPO};
  const source={id,run_attempt:1,workflow_id:workflowId,head_sha:sha,
    head_branch:'main',head_repository:repo,repository:repo,
    name:REQUEST_NAME,path:REQUEST_PATH,event:'workflow_dispatch',
    status:'completed',conclusion:'success',actor,triggering_actor:actor,
    created_at:'2026-10-15T12:00:00Z'};
  const workflow={id:workflowId,name:REQUEST_NAME,path:REQUEST_PATH};
  const event={action:'completed',repository:repo,
    workflow_run:{id,run_attempt:1,workflow_id:workflowId,head_sha:sha,
      head_branch:'main',head_repository:repo,repository:repo,event:'workflow_dispatch'}};
  const main={object:{sha}};
  const valid={ctx,event,source,workflow,main};
  assert.equal(attestReplay(valid).status,'authorized');
  assert.equal(requireSchedule({...ctx,event:'schedule'}).status,'authorized');
  const bad=patch=>assert.throws(()=>attestReplay({...valid,...patch}),/Metrics Replay refused/);
  bad({ctx:{...ctx,ref:'refs/heads/untrusted'}});
  bad({ctx:{...ctx,event:'workflow_dispatch'}});
  bad({ctx:{...ctx,sha:'b'.repeat(40)}});
  bad({event:{...event,action:'requested'}});
  bad({event:{...event,workflow_run:{...event.workflow_run,run_attempt:2}}});
  bad({event:{...event,workflow_run:{...event.workflow_run,head_branch:'feature'}}});
  bad({event:{...event,workflow_run:{...event.workflow_run,event:'push'}}});
  bad({source:{...source,event:'repository_dispatch'}});
  bad({source:{...source,head_branch:'feature'}});
  bad({source:{...source,head_sha:'b'.repeat(40)}});
  bad({source:{...source,path:'.github/workflows/evil.yml'}});
  bad({source:{...source,actor:{login:'attacker'}}});
  bad({source:{...source,triggering_actor:{login:'attacker'}}});
  bad({source:{...source,conclusion:'failure'}});
  bad({source:{...source,repository:{full_name:'attacker/fork'}}});
  bad({workflow:{...workflow,path:'.github/workflows/evil.yml'}});
  bad({main:{object:{sha:'b'.repeat(40)}}});
  assert.throws(()=>requireSchedule({...ctx,event:'workflow_dispatch'}),/Metrics Replay refused/);
  const request=fs.readFileSync('.github/workflows/metrics-replay-request.yml','utf8');
  assert.match(request,/^  workflow_dispatch:\s*$/m);
  assert.match(request,/^permissions:\s*\n  contents: read\s*$/m);
  assert.doesNotMatch(request,/contents: write|RUN_STORE_WRITER_APP_PRIVATE_KEY|actions\/create-github-app-token|repository_dispatch:/);
  const writer=fs.readFileSync('.github/workflows/metrics-repository.yml','utf8');
  assert.match(writer,/workflow_run:\s*\n    workflows: \["Metrics \/ Replay Request"\]\s*\n    types: \[completed\]/);
  assert.doesNotMatch(writer,/^  workflow_dispatch:\s*$/m);
  assert.match(writer,/needs: \[authorize-replay, rust-health, web-health, e2e-health\]/);
  assert.match(writer,/needs\.authorize-replay\.result == 'success'/);
  assert.match(writer,/scripts\/metrics-replay-source\.mjs authorize/);
  console.log('Metrics Replay trusted-main source provenance: owner, exact SHA, actor, attempt, trigger and fallback negatives passed');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{
    if(process.argv[2]==='self-test')selfTest();
    else if(process.argv[2]==='authorize')await authorize();
    else no('usage: self-test | authorize');
  }catch(e){console.error('::error::'+String(e.message));process.exitCode=1;}
}
