#!/usr/bin/env node
// #2031: opt-in durable publisher, separate Actions:write App credential.
// Shadow relay never imports or starts this process. No PR-head code execution.
import {resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DurableInbox,SOURCE_WORKFLOWS} from './acceptance-event-relay-core.mjs';
import {authorizeEventConsumer,canonicalTaskId} from './acceptance-event-consumer.mjs';
import {githubGet,installationToken} from './acceptance-event-relay.mjs';
import {retryDelay} from './acceptance-event-relay-worker.mjs';

const REPO='BestNathan/nession';
const WORKFLOW='acceptance-event-consumer.yml';
const PATH='.github/workflows/'+WORKFLOW;
const URL='https://api.github.com/repos/'+REPO+'/actions/workflows/'+WORKFLOW+'/dispatches';
const positive=n=>Number.isSafeInteger(n)&&n>0;
const fail=message=>{throw Error('acceptance-event-publisher: '+message)};
export function taskInputs(task){
  if(!task||!/^[a-f0-9]{64}$/.test(task.id??'')||
    task.repo!==REPO||!/^[a-f0-9]{40}$/.test(task.target_sha??'')||
    !positive(task.issue)||!positive(task.source_run_id)||
    !positive(task.source_attempt)||!/^[a-f0-9]{64}$/.test(task.contract_digest??'')||
    task.stage!=='post-merge'||!SOURCE_WORKFLOWS.has(task.source_path)||
    canonicalTaskId({repo:task.repo,source_run_id:task.source_run_id,
      source_attempt:task.source_attempt,target_sha:task.target_sha,
      stage:task.stage},task.issue,task.contract_digest)!==task.id)
    fail('invalid durable task');
  return {source_run_id:String(task.source_run_id),
    source_attempt:String(task.source_attempt),target_sha:task.target_sha,
    issue_number:String(task.issue),contract_digest:task.contract_digest,
    task_id:task.id};
}
export function verifyCreatedRunResponse(json){
  const id=json?.workflow_run_id;
  if(!positive(id)||json.run_url!==
    'https://api.github.com/repos/'+REPO+'/actions/runs/'+id||
    json.html_url!=='https://github.com/'+REPO+'/actions/runs/'+id)
    fail('missing or malformed dispatch Run ID receipt');
  return id;
}
export function matchDispatchedRun(task,result){
  return result&&positive(result.id)&&result.name==='Acceptance / Event Consumer'&&
    result.path===PATH&&result.display_title==='Acceptance task '+task.id&&
    result.event==='workflow_dispatch'&&result.head_branch==='main'&&
    result.repository?.full_name===REPO&&result.head_repository?.full_name===REPO;
}
export function dispatchDueResult(response){
  // GitHub added explicit run receipts in 2026. A legacy 204 or 5xx is
  // ambiguous: never turn it into "run created" without independent proof.
  if(response.status===403||response.status===429){
    const retry=response.headers?.get?.('retry-after');
    const reset=response.headers?.get?.('x-ratelimit-reset');
    let retryAfterMs=null;
    if(/^[0-9]+$/.test(retry??''))retryAfterMs=Number(retry)*1000;
    else if(/^[0-9]+$/.test(reset??''))
      retryAfterMs=Math.max(1000,Number(reset)*1000-Date.now());
    return {kind:'rejected',httpStatus:response.status,retryAfterMs};
  }
  if(response.status===200)return {kind:'receipt'};
  return {kind:'uncertain',httpStatus:response.status};
}
export async function dispatchConsumer(task,token,fetcher=fetch){
  const response=await fetcher(URL,{
    method:'POST',
    headers:{Authorization:'Bearer '+token,
      Accept:'application/vnd.github+json',
      'Content-Type':'application/json','X-GitHub-Api-Version':'2026-03-10'},
    body:JSON.stringify({ref:'main',return_run_details:true,inputs:taskInputs(task)}),
    signal:AbortSignal.timeout(20000),
  });
  const state=dispatchDueResult(response);
  if(state.kind==='receipt'){
    try{return {kind:'receipt',runId:verifyCreatedRunResponse(await response.json())}}
    catch{return {kind:'uncertain',httpStatus:200}}
  }
  return state;
}
export async function listMatchingDispatches(task,token,fetcher=fetch){
  taskInputs(task);
  const response=await fetcher('https://api.github.com/repos/'+REPO+
    '/actions/workflows/'+WORKFLOW+'/runs?event=workflow_dispatch&branch=main&per_page=100',{
    headers:{Authorization:'Bearer '+token,
      Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'},
    signal:AbortSignal.timeout(15000),
  });
  if(!response.ok)fail('dispatch list read rejected');
  const data=await response.json();
  if(!Array.isArray(data?.workflow_runs)||data.workflow_runs.length>100)
    fail('invalid dispatch listing');
  return data.workflow_runs.filter(run=>matchDispatchedRun(task,run));
}
export async function publishDueTask(inbox,github,{
  now=()=>Date.now(),onError=()=>{},
}={}){
  const uncertain=inbox.claimUncertain(now());
  if(uncertain){
    try{
      const matches=await github.lookup(uncertain);
      if(!Array.isArray(matches))fail('invalid reconciliation reply');
      const verified=matches.filter(x=>matchDispatchedRun(uncertain,x));
      if(verified.length===1){
        const id=verified[0].id;
        if(!inbox.acknowledgeDispatch(uncertain.id,id,now()))
          fail('cannot commit independently corroborated Run receipt');
        return {kind:'reconciled',task_id:uncertain.id,run_id:id};
      }
      // An absent run in a bounded listing is NEVER evidence that a 204,
      // timeout or 5xx request failed to create a run. Remain uncertain.
      return {kind:verified.length>1?'conflicting-runs':'uncertain',
        task_id:uncertain.id};
    }catch{
      onError({phase:'reconcile',kind:'read-error'});
      return {kind:'uncertain',task_id:uncertain.id};
    }
  }
  const task=inbox.claim(now());
  if(!task)return null;
  try{
    const inputs=taskInputs(task);
    // The publisher is not trusted to project a verdict. Re-read current
    // source + SC before triggering the separate main-owned consumer.
    let decision;
    try{decision=await github.authorize(inputs)}
    catch(err){
      const due=now()+retryDelay(task.attempts,err?.retryAfterMs);
      inbox.deferPreflight(task.id,due);
      return {kind:'preflight-retry',task_id:task.id,due_at:due};
    }
    if(!decision?.authorized){
      inbox.suppress(task.id,'no-current-eligible-SC',now());
      return {kind:'suppressed',task_id:task.id};
    }
    let outcome;
    try{outcome=await github.dispatch(task)}
    catch{outcome={kind:'uncertain',httpStatus:null}}
    if(outcome?.kind==='receipt'&&positive(outcome.runId)){
      inbox.acknowledgeDispatch(task.id,outcome.runId,now());
      return {kind:'submitted',task_id:task.id,run_id:outcome.runId};
    }
    if(outcome?.kind==='rejected'&&[403,429].includes(outcome.httpStatus)){
      const due=now()+retryDelay(task.attempts,outcome.retryAfterMs);
      inbox.deferRejectedDispatch(task.id,due,outcome.httpStatus);
      return {kind:'quota-retry',task_id:task.id,due_at:due};
    }
    inbox.uncertain(task.id,'ambiguous-dispatch-reply',now());
    return {kind:'uncertain',task_id:task.id};
  }catch(err){
    // Fail closed. If a POST might have reached GitHub, this preserves
    // the task's uncertain outcome rather than repeating a side effect.
    inbox.uncertain(task.id,'unhandled-publisher-error',now());
    onError({phase:'publish',kind:'internal-error'});
    return {kind:'uncertain',task_id:task.id};
  }
}
export function startPublisher(inbox,github,{onError=()=>{}}={}){
  let stopped=false,timer=null,inFlight=null;
  const clear=()=>{if(timer!==null)clearTimeout(timer);timer=null};
  const kick=()=>{
    if(stopped||inFlight)return;
    clear();
    const at=inbox.nextTaskDue();
    // A separate webhook process writes to the same WAL. When idle, check
    // local SQLite periodically to detect newly committed tasks; this is NOT
    // an Actions cron/remote polling loop and creates zero GitHub Runs.
    const due=at===null?Date.now()+5000:at;
    // Do NOT unref: this process owns durable delayed QUOTA_RETRY_DUE.
    timer=setTimeout(()=>{
      timer=null;
      inFlight=publishDueTask(inbox,github,{onError});
      inFlight.then(()=>{inFlight=null;if(!stopped)kick()},()=>{
        inFlight=null;
        onError({phase:'publisher-worker',kind:'error'});
        if(!stopped)kick();
      });
    },Math.min(2147483647,Math.max(0,due-Date.now())));
  };
  kick();
  return {kick,stop:async()=>{
    stopped=true;clear();
    if(inFlight)await inFlight;
  }};
}
export function createPublisher(env=process.env,fetcher=fetch){
  if(env.ACCEPTANCE_PUBLISHER_MODE!=='live')
    fail('explicit live publisher opt-in required');
  if(!isAbsolute(env.ACCEPTANCE_RELAY_DB??'')||
    env.ACCEPTANCE_RELAY_DB===':memory:'||
    !positive(Number(env.GITHUB_PUBLISHER_APP_ID))||
    !positive(Number(env.GITHUB_PUBLISHER_INSTALLATION_ID))||
    !env.GITHUB_PUBLISHER_PRIVATE_KEY)
    fail('persistent DB and separate Actions:write App identity required');
  const inbox=new DurableInbox(env.ACCEPTANCE_RELAY_DB);
  const getToken=()=>installationToken({
    appId:env.GITHUB_PUBLISHER_APP_ID,
    installationId:env.GITHUB_PUBLISHER_INSTALLATION_ID,
    privateKey:env.GITHUB_PUBLISHER_PRIVATE_KEY.replace(/\\n/g,'\n'),
    fetcher});
  const github={
    authorize:async inputs=>{
      const token=await getToken();
      return authorizeEventConsumer(inputs,path=>githubGet(path,token,fetcher));
    },
    dispatch:async task=>dispatchConsumer(task,await getToken(),fetcher),
    lookup:async task=>listMatchingDispatches(task,await getToken(),fetcher),
  };
  const worker=startPublisher(inbox,github,{
    onError:event=>console.error('acceptance-event-publisher: safe event',JSON.stringify(event))});
  return {inbox,worker};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {worker,inbox}=createPublisher();
  const stop=()=>void worker.stop().then(()=>inbox.close());
  process.on('SIGTERM',stop);
  process.on('SIGINT',stop);
}
