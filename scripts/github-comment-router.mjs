#!/usr/bin/env node
// Main-owned comment router. All domain evidence and mutations remain in their existing owners.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { commandPlan, parseCommand, workflowTitle, dispatchInputs } from './github-comment-command.mjs';
import { resolveCaseTarget } from './github-comment-case-request.mjs';
import { verifyLiveBugDevelopSource } from './lib/agent/orchestration/bug-develop-comment.mjs';

const REPO = 'BestNathan/nession';
const API = 'https://api.github.com';
async function api(path, { method = 'GET', body } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw Error('GitHub token missing');
  const response = await fetch(API + path, {
    method, headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw Error('GitHub ' + method + ' ' + path + ': HTTP ' + response.status);
  return response.status === 204 ? null : response.json();
}
function validEvent(event) {
  return event?.action === 'created' && event?.repository?.full_name === REPO &&
    process.env.GITHUB_REPOSITORY === REPO &&
    process.env.GITHUB_EVENT_NAME === 'issue_comment' &&
    process.env.GITHUB_ACTOR === event?.comment?.user?.login &&
    event?.sender?.login === process.env.GITHUB_ACTOR &&
    event?.comment?.user?.type === 'User' &&
    Number.isSafeInteger(event?.comment?.id) && event.comment.id > 0 &&
    Number.isSafeInteger(event?.issue?.number) && event.issue.number > 0;
}
export async function resolve(event, read = api) {
  if (!validEvent(event) || !parseCommand(event.comment.body)) return null;
  const id = event.comment.id, number = event.issue.number;
  const [comment, issue] = await Promise.all([
    read('/repos/' + REPO + '/issues/comments/' + id),
    read('/repos/' + REPO + '/issues/' + number),
  ]);
  if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment?.author_association)) return null;
  const isPr = Boolean(issue?.pull_request);
  let pr = null, permission = null;
  if (isPr) {
    pr = await read('/repos/' + REPO + '/pulls/' + number);
    permission = event.comment.user.login === 'BestNathan' &&
      comment.author_association === 'OWNER' ? 'admin' :
      (await read('/repos/' + REPO + '/collaborators/' +
        encodeURIComponent(event.comment.user.login) + '/permission')).permission;
  }
  const plan = commandPlan(event, comment, issue, pr, permission);
  if (plan?.handler === 'develop') {
    // The same source verifier runs again inside Store Ingest. This is a
    // read-only, early rejection; it grants no Developer/Store authority.
    await verifyLiveBugDevelopSource(number, id, read);
  }
  return plan?.handler === 'case' ? resolveCaseTarget(plan, issue, read) : plan;
}
function outputs(plan) {
  if (!process.env.GITHUB_OUTPUT) throw Error('GITHUB_OUTPUT missing');
  if (!plan) return;
  for (const [key, value] of Object.entries({
    handler: plan.handler, issue_number: plan.issue_number, comment_id: plan.comment_id,
    target_sha: plan.target_sha ?? '', target_ref: plan.target_ref ?? '',
    criterion: plan.criterion ?? '', stage: plan.stage ?? '',
    environment: plan.environment ?? '',
    platform: plan.platform ?? '', runtime_profile: plan.runtime_profile ?? '',
  })) {
    if (!/^[a-z_]+$/.test(key) || /[\r\n]/.test(String(value))) throw Error('invalid output');
    appendFileSync(process.env.GITHUB_OUTPUT, key + '=' + value + '\n');
  }
}
function matchesPlan(plan) {
  return plan && plan.handler === process.env.EXPECTED_HANDLER &&
    String(plan.issue_number) === process.env.EXPECTED_ISSUE &&
    String(plan.comment_id) === process.env.EXPECTED_COMMENT &&
    (plan.target_sha ?? '') === (process.env.EXPECTED_SHA ?? '') &&
    (plan.target_ref ?? '') === (process.env.EXPECTED_REF ?? '') &&
    (plan.criterion ?? '') === (process.env.EXPECTED_CRITERION ?? '') &&
    (plan.stage ?? '') === (process.env.EXPECTED_STAGE ?? '') &&
    (plan.environment ?? '') === (process.env.EXPECTED_ENVIRONMENT ?? '') &&
    (plan.platform ?? '') === (process.env.EXPECTED_PLATFORM ?? '') &&
    (plan.runtime_profile ?? '') === (process.env.EXPECTED_RUNTIME_PROFILE ?? '');
}
function findRun(runs, plan) {
  return runs.find(r => r.display_title === workflowTitle(plan) &&
    r.event === 'workflow_dispatch' && r.head_branch === 'main' &&
    r.repository?.full_name === REPO && r.head_repository?.full_name === REPO);
}
async function inventory(read, plan) {
  const data = await read('/repos/' + REPO + '/actions/workflows/' +
    plan.workflow + '/runs?event=workflow_dispatch&per_page=100');
  if (!Array.isArray(data?.workflow_runs)) throw Error('bad run inventory');
  return data.workflow_runs;
}
function marker(plan) { return '<!-- nession-command-comment:' + plan.comment_id + ' -->'; }
async function acknowledge(read, plan, link) {
  const target = plan.kind === 'pull_request'
    ? 'PR #' + plan.issue_number + ' at ' + plan.target_sha
    : 'Issue #' + plan.issue_number +
      (plan.handler === 'case' ? ' / ' + plan.criterion + ' at ' + plan.target_sha : '');
  const body = 'Comment command ' + String.fromCharCode(96) + plan.command +
    String.fromCharCode(96) + ' accepted for ' + target +
    '. [Actions run](' + link + '). This request is not an Acceptance Pass or proof that a Developer has started.\n\n' + marker(plan);
  await read('/repos/' + REPO + '/issues/' + plan.issue_number + '/comments',
    { method: 'POST', body: { body } });
}
// #3491: Recover a completed Worker from immutable agent-store only. The
// Owner comment contains no Run ID; the Store receipt is authoritative. This
// read-only preflight does not mint credentials or trust model-provided output.
export async function wakeQwenResult(plan,read=api) {
  if(plan?.handler!=='develop-result'||plan.workflow!=='store-agent-development-ingest.yml'||
     !Number.isSafeInteger(plan.issue_number)||plan.issue_number<1)
    throw Error('Qwen replay must be an authorized owner Bug result command');
  const root='workflows/issues/'+plan.issue_number;
  async function storeJson(file) {
    const data=await read('/repos/'+REPO+'/contents/'+file+'?ref=agent-store');
    if(data?.type!=='file'||data.encoding!=='base64'||
       typeof data.content!=='string'||data.content.length>400000)
      throw Error('unsafe immutable Store content');
    const bytes=Buffer.from(data.content.replace(/\s/g,''),'base64');
    return {bytes,json:JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes))};
  }
  const head=(await storeJson(root+'/head.json')).json;
  if(!Number.isSafeInteger(head.version)||head.version<1||
     head.path!==root+'/states/'+String(head.version).padStart(8,'0')+'.json'||
     !/^[a-f0-9]{64}$/.test(head.sha256??''))
    throw Error('untrusted Store head or state path');
  const state=await storeJson(head.path);
  if(createHash('sha256').update(state.bytes).digest('hex')!==head.sha256||
     state.json.issue!==plan.issue_number||state.json.version!==head.version||
     !Array.isArray(state.json.outbox))
    throw Error('immutable Store state digest/Issue mismatch');
  const ready=state.json.outbox.filter(action=>
    action?.task?.type==='dispatch'&&action.task.role==='developer'&&
    action.task.task==='implement'&&action.task.agent_id==='dev-qwen-01'&&
    /^[a-f0-9]{40}$/.test(action.task.sha??'')&&
    /^[a-f0-9]{64}$/.test(action.id??'')&&
    action.status==='dispatched'&&action.attempts===1&&
    action.receipt?.status==='verified'&&
    action.receipt?.dispatch_id===action.id&&
    Number.isSafeInteger(action.receipt.source_run_id)&&
    action.receipt.source_run_id>0);
  if(ready.length!==1)throw Error('no unique pending immutable Qwen Worker receipt');
  const original=ready[0],id=original.receipt.source_run_id;
  const run=await read('/repos/'+REPO+'/actions/runs/'+id);
  if(run?.id!==id||run.run_attempt!==1||run.status!=='completed'||
     run.conclusion!=='success'||run.path!=='.github/workflows/agent-develop.yml'||
     run.name!=='Agent / Development'||run.event!=='workflow_dispatch'||
     run.actor?.login!=='github-actions[bot]'||
     run.repository?.full_name!==REPO||
     run.head_repository?.full_name!==REPO||
     run.head_branch!=='main'||run.head_sha!==original.task.sha)
    throw Error('Store Worker source is not successful exact-sha main Qwen');
  const artifacts=await read('/repos/'+REPO+'/actions/runs/'+id+'/artifacts?per_page=100');
  if(!Array.isArray(artifacts?.artifacts)||
     artifacts.total_count!==artifacts.artifacts.length||
     artifacts.total_count>100)
    throw Error('incomplete Worker Artifact inventory');
  for(const prefix of ['development-worker-claim','development-worker']){
    const entries=artifacts.artifacts.filter(a=>a.name===prefix+'-'+id+'-1');
    if(entries.length!==1||entries[0].expired!==false||
       entries[0].workflow_run?.id!==id||
       entries[0].workflow_run?.head_sha!==run.head_sha||
       !/^sha256:[a-f0-9]{64}$/.test(entries[0].digest??'')||
       !Number.isSafeInteger(entries[0].size_in_bytes)||
       entries[0].size_in_bytes<1)
      throw Error('missing or forged original Worker Artifact');
  }
  const workflow='store-agent-development-ingest.yml';
  const data=await read('/repos/'+REPO+'/actions/workflows/'+workflow+
    '/runs?event=workflow_dispatch&per_page=100');
  if(!Array.isArray(data?.workflow_runs))throw Error('bad Store Ingest wake inventory');
  const wakeName='Qwen Developer Ingest worker:'+id;
  const existing=data.workflow_runs.filter(r=>
    r.display_title===wakeName&&r.event==='workflow_dispatch'&&
    r.actor?.login==='github-actions[bot]'&&r.head_branch==='main'&&
    r.repository?.full_name===REPO);
  if(existing.length>2)throw Error('ambiguous Qwen Store Ingest wake');
  if(existing.length===2)return {state:'already-woken',source_run_id:id,
    url:existing[0].html_url};
  if(existing.length===1){
    const prior=existing[0];
    if(prior.status!=='completed'||prior.conclusion!=='failure'||
       prior.run_attempt!==1||
       prior.path!=='.github/workflows/store-agent-development-ingest.yml'||
       !/^[a-f0-9]{40}$/.test(prior.head_sha??'')) {
      return {state:'already-woken',source_run_id:id,url:prior.html_url};
    }
    // One verified failed Store Ingest may request one fresh bot/main replay.
    // The immutable Worker never runs again. Existing checkpoint is CAS-fenced.
  }
  if(data.workflow_runs.length===100&&
     !(Date.parse(data.workflow_runs.at(-1)?.created_at)<Date.parse(run.created_at)))
    throw Error('unbounded Store wake inventory; no blind redispatch');
  await read('/repos/'+REPO+'/actions/workflows/'+workflow+'/dispatches',{
    method:'POST',body:{ref:'main',inputs:{source_run_id:String(id)}},
  });
  return {state:'store-ingest-requested',source_run_id:id,
    url:'https://github.com/'+REPO+'/actions/workflows/'+workflow};
}
async function dispatch(plan, read = api) {
  const comments = await read('/repos/' + REPO + '/issues/' +
    plan.issue_number + '/comments?per_page=100&sort=created&direction=desc');
  if (!Array.isArray(comments)) throw Error('bad comment inventory');
  if (comments.some(c => c?.body?.includes(marker(plan)) &&
      c?.user?.type === 'Bot' && c?.user?.login === 'github-actions[bot]'))
    return { state: 'already-acknowledged' };
  if(plan.handler==='develop-result'){
    const woke=await wakeQwenResult(plan,read);
    await acknowledge(read,plan,woke.url);
    return woke;
  }
  const runs = await inventory(read, plan);
  const previous = findRun(runs, plan);
  if (previous) {
    // Recovery after dispatch succeeded but the acknowledgment POST failed:
    // repair the receipt without spending model/Full quota a second time.
    await acknowledge(read, plan, previous.html_url);
    return { state: 'already-dispatched', url: previous.html_url };
  }
  // A full page is safe for a freshly created command only when its oldest
  // item precedes the source comment. Otherwise history may hide a replay.
  const since = Date.parse(plan.created_at);
  if ((runs.length === 100 && !(Date.parse(runs.at(-1)?.created_at) < since)) ||
      (comments.length === 100 && !(Date.parse(comments.at(-1)?.created_at) < since)))
    throw Error('bounded run/comment inventory exhausted; reconcile manually');
  await read('/repos/' + REPO + '/actions/workflows/' + plan.workflow + '/dispatches', {
    method: 'POST', body: { ref: 'main', inputs: dispatchInputs(plan) },
  });
  let run = null;
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 1500));
    run = findRun(await inventory(read, plan), plan);
    if (run) break;
  }
  const link = run?.html_url ||
    'https://github.com/' + REPO + '/actions/workflows/' + plan.workflow;
  await acknowledge(read, plan, link);
  return { state: 'dispatched', url: link };
}
// #3488: A GITHUB_TOKEN workflow_dispatch executes Controller, but GitHub
// intentionally suppresses its workflow_run chain. The trusted human-comment
// Router explicitly requests the Store Ingest AFTER confirming that Controller
// completed successfully. Store Ingest re-authenticates Run, Artifact and the
// original Owner comment before using its own App credentials.
export async function wakeBugDeveloper(plan, read=api, pause=(ms)=>new Promise(r=>setTimeout(r,ms))) {
  if(plan?.handler!=='develop' || plan.workflow!=='acceptance-agent-controller.yml')
    throw Error('Bug Developer wake requires an authenticated command');
  const runs=await inventory(read,plan);
  const matches=runs.filter(run=>findRun([run],plan));
  if(matches.length!==1||!Number.isSafeInteger(matches[0].id)||matches[0].id<1)
    throw Error('missing or ambiguous exact Controller Run for Bug command');
  const original=matches[0];
  let current=null;
  for(let attempt=0;attempt<40;attempt++){
    current=await read('/repos/'+REPO+'/actions/runs/'+original.id);
    if(current.status==='completed')break;
    await pause(3000);
  }
  if(current?.id!==original.id||current.status!=='completed'||
      current.conclusion!=='success'||current.run_attempt!==1||
      current.actor?.login!=='github-actions[bot]'||
      current.path!=='.github/workflows/acceptance-agent-controller.yml'||
      current.event!=='workflow_dispatch'||current.head_branch!=='main'||
      current.repository?.full_name!==REPO||current.head_repository?.full_name!==REPO)
    throw Error('Controller is not authenticated completed success; Store wake denied');
  const workflow='store-agent-controller-ingest.yml';
  const prior=await read('/repos/'+REPO+'/actions/workflows/'+workflow+
    '/runs?event=workflow_dispatch&per_page=100');
  if(!Array.isArray(prior?.workflow_runs))
    throw Error('bad Store Ingest Run inventory');
  const runName='Bug Developer Ingest controller:'+original.id;
  const wakes=prior.workflow_runs.filter(item=>
    item.display_title===runName && item.event==='workflow_dispatch' &&
    item.actor?.login==='github-actions[bot]'&&
    item.head_branch==='main'&&item.repository?.full_name===REPO);
  if(wakes.length>1)throw Error('ambiguous existing Store Ingest wakes');
  if(wakes.length===1)
    return {state:'already-woken',controller_run_id:original.id,
      ingest_run_id:wakes[0].id??null};
  if(prior.workflow_runs.length===100&&
      !(Date.parse(prior.workflow_runs.at(-1)?.created_at)<Date.parse(plan.created_at)))
    throw Error('unbounded Store Ingest wake history, refusing duplicate dispatch');
  await read('/repos/'+REPO+'/actions/workflows/'+workflow+'/dispatches',{
    method:'POST',body:{ref:'main',inputs:{source_run_id:String(original.id)}},
  });
  return {state:'store-ingest-requested',controller_run_id:original.id,
    note:'Not a Store commit or Worker/PR proof'};
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const plan = await resolve(event);
  if (process.argv[2] === 'resolve') {
    outputs(plan);
    console.log(plan ? 'authorized command ' + plan.handler + ' #' + plan.issue_number :
      'ignored unsupported/unauthorized/stale comment');
    return;
  }
  if (process.argv[2] === 'wake-developer') {
    if(!matchesPlan(plan)||plan.handler!=='develop')
      throw Error('Bug Developer wake command/source changed; denying');
    const woke=await wakeBugDeveloper(plan);
    console.log(JSON.stringify(woke));
    return;
  }
  if (process.argv[2] !== 'dispatch') throw Error('unknown command');
  if (!matchesPlan(plan)) throw Error('command changed since initial plan; refusing stale request');
  const outcome = await dispatch(plan);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '## Comment command\n- Request: ' + plan.request_id +
      '\n- Target: ' + (plan.target_sha ?? 'Issue #' + plan.issue_number) +
      '\n- Result: ' + outcome.state + '\n- Link: ' + (outcome.url || 'already acknowledged') + '\n');
  console.log(JSON.stringify(outcome));
}
async function selfTest() {
  const repo = { full_name: REPO }, user = { login: 'BestNathan', type: 'User' };
  const issue = { number: 17, state: 'open', repository_url: API + '/repos/' + REPO };
  const comment = { id: 88, body: '/audit', issue_url: issue.repository_url + '/issues/17',
    author_association: 'OWNER', user };
  const event = { action: 'created', repository: repo, sender: user,
    issue: { number: 17 }, comment: { id: 88, body: '/audit', user } };
  const env = { GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: 'issue_comment',
    GITHUB_ACTOR: user.login };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const fake = async path => {
      if (path.endsWith('/issues/comments/88')) return comment;
      if (path.endsWith('/issues/17')) return issue;
      throw Error('unexpected lookup ' + path);
    };
    const plan = await resolve(event, fake);
    assert.equal(plan.handler, 'audit');
    assert.equal(await resolve({ ...event, sender: { login: 'attacker' } }, fake), null);
    assert.equal(await resolve({ ...event,
      comment: { ...event.comment, body: '/audit tree' } }, fake), null);
    const pr = { number: 17, state: 'open',
      head: { sha: 'a'.repeat(40), ref: 'feat/example', repo },
      base: { sha: 'b'.repeat(40), ref: 'staging' } };
    const prEvent = { ...event, issue: { ...event.issue, pull_request: {} },
      comment: { ...event.comment, body: '/e2e full' } };
    const read = async path => {
      if (path.endsWith('/issues/comments/88')) return { ...comment, body: '/e2e full' };
      if (path.endsWith('/issues/17')) return { ...issue, pull_request: {} };
      if (path.endsWith('/pulls/17')) return pr;
      throw Error('unexpected lookup ' + path);
    };
    assert.equal((await resolve(prEvent, read)).target_sha, pr.head.sha);
    const run = { display_title: workflowTitle(plan), event: 'workflow_dispatch',
      head_branch: 'main', repository: repo, head_repository: repo,
      html_url: 'https://github.com/BestNathan/nession/actions/runs/22' };
    let receiptsWritten = 0, redundantDispatches = 0;
    const recovered = await dispatch(plan, async (path, options = {}) => {
      if (options.method === 'POST') {
        if (path.endsWith('/dispatches')) redundantDispatches += 1;
        else if (path.endsWith('/comments')) receiptsWritten += 1;
        return {};
      }
      return path.endsWith('/comments?per_page=100&sort=created&direction=desc')
        ? [] : { workflow_runs: [run] };
    });
    assert.equal(recovered.state, 'already-dispatched');
    assert.equal(receiptsWritten, 1, 'missing receipt must be recovered');
    assert.equal(redundantDispatches, 0, 'replay cannot schedule another Full run');
    assert.equal((await dispatch(plan, async path => path.endsWith('/comments?per_page=100&sort=created&direction=desc')
      ? [{ body: marker(plan), user: { login: 'github-actions[bot]', type: 'Bot' } }]
      : { workflow_runs: [] })).state, 'already-acknowledged');
    // #3488: post-Controller wake must authenticate the exact completed
    // source Run before issuing exactly one GITHUB_TOKEN workflow_dispatch.
    const dev={...plan,handler:'develop',command:'/develop dev-qwen-01',
      workflow:'acceptance-agent-controller.yml'};
    const sourceRun={id:321,display_title:workflowTitle(dev),
      event:'workflow_dispatch',head_branch:'main',repository:repo,
      head_repository:repo,actor:{login:'github-actions[bot]'},
      path:'.github/workflows/acceptance-agent-controller.yml',
      status:'completed',conclusion:'success',run_attempt:1};
    let wakes=0;
    const wakeReader=async(path,options={})=>{
      if(options.method==='POST'){
        assert.ok(path.endsWith('/store-agent-controller-ingest.yml/dispatches'));
        assert.deepEqual(options.body,{ref:'main',inputs:{source_run_id:'321'}});
        wakes++;
        return null;
      }
      if(path.includes('/acceptance-agent-controller.yml/runs?'))
        return {workflow_runs:[sourceRun]};
      if(path.endsWith('/actions/runs/321'))
        return sourceRun;
      if(path.includes('/store-agent-controller-ingest.yml/runs?'))
        return {workflow_runs:[]};
      throw Error('unexpected waker API '+path);
    };
    const wake=await wakeBugDeveloper(dev,wakeReader,async()=>{});
    assert.equal(wake.state,'store-ingest-requested');
    assert.equal(wakes,1,'exactly one post-Controller Store wake');
    await assert.rejects(wakeBugDeveloper(dev,async(path,options)=>{
      if(path.endsWith('/actions/runs/321'))return {...sourceRun,conclusion:'failure'};
      return wakeReader(path,options);
    },async()=>{}),/authenticated completed success/);
    assert.equal(wakes,1,'failed source Run cannot request privileged Ingest');
    const existing=await wakeBugDeveloper(dev,async(path,options)=>{
      if(path.includes('/store-agent-controller-ingest.yml/runs?'))
        return {workflow_runs:[{id:456,display_title:'Bug Developer Ingest controller:321',
          event:'workflow_dispatch',actor:{login:'github-actions[bot]'},
          head_branch:'main',repository:repo}]};
      return wakeReader(path,options);
    },async()=>{});
    assert.equal(existing.state,'already-woken');
    assert.equal(existing.ingest_run_id,456);
    assert.equal(wakes,1,'readback prevents a second Store wake');
    // #3491: replay exactly one previously completed Qwen Worker from
    // immutable Store; comment ID never supplies a worker Run or Action.
    const issueNo=3433,workerId=43578706212;
    const stateDoc={schema_version:1,issue:issueNo,version:3,
      outbox:[{id:'a'.repeat(64),task:{type:'dispatch',role:'developer',
        task:'implement',agent_id:'dev-qwen-01',sha:'b'.repeat(40)},
        status:'dispatched',attempts:1,receipt:{status:'verified',
          dispatch_id:'a'.repeat(64),source_run_id:workerId}}]};
    const stateBytes=Buffer.from(JSON.stringify(stateDoc)+'\n');
    const headDoc={version:3,
      path:'workflows/issues/3433/states/00000003.json',
      sha256:createHash('sha256').update(stateBytes).digest('hex')};
    const wrap=obj=>({type:'file',encoding:'base64',
      content:Buffer.from(JSON.stringify(obj)+'\n').toString('base64')});
    const worker={id:workerId,run_attempt:1,status:'completed',
      conclusion:'success',path:'.github/workflows/agent-develop.yml',
      name:'Agent / Development',event:'workflow_dispatch',
      actor:{login:'github-actions[bot]'},head_branch:'main',
      head_sha:'b'.repeat(40),repository:repo,head_repository:repo,
      created_at:'2026-11-14T09:06:00Z'};
    const artifacts={artifacts:['development-worker-claim','development-worker']
      .map((prefix,i)=>({id:i+1,name:prefix+'-'+workerId+'-1',
        expired:false,size_in_bytes:100,digest:'sha256:'+'c'.repeat(64),
        workflow_run:{id:workerId,head_sha:worker.head_sha}})),total_count:2};
    const resultPlan={...dev,handler:'develop-result',
      workflow:'store-agent-development-ingest.yml',issue_number:issueNo};
    let resultWakes=0;
    function reader({failed=false,badHead=false,existing=false,
      failedIngest=false,retried=false}={}){
      return async(path,opts={})=>{
        if(opts.method==='POST'){
          assert.equal(path,'/repos/'+REPO+
            '/actions/workflows/store-agent-development-ingest.yml/dispatches');
          assert.deepEqual(opts.body,{ref:'main',
            inputs:{source_run_id:String(workerId)}});
          resultWakes++;return {};
        }
        if(path.endsWith('/head.json?ref=agent-store'))
          return wrap({...headDoc,...(badHead?{sha256:'0'.repeat(64)}:{})});
        if(path.endsWith('/00000003.json?ref=agent-store'))
          return {type:'file',encoding:'base64',content:stateBytes.toString('base64')};
        if(path.endsWith('/actions/runs/'+workerId))
          return {...worker,...(failed?{conclusion:'failure'}:{})};
        if(path.endsWith('/actions/runs/'+workerId+'/artifacts?per_page=100'))
          return artifacts;
        if(path.includes('/store-agent-development-ingest.yml/runs?'))
          return {workflow_runs:(existing||failedIngest||retried)?[
            {id:999,display_title:'Qwen Developer Ingest worker:'+workerId,
              event:'workflow_dispatch',actor:{login:'github-actions[bot]'},
              head_branch:'main',head_sha:'b'.repeat(40),
              status:'completed',conclusion:failedIngest?'failure':'success',
              run_attempt:1,path:'.github/workflows/store-agent-development-ingest.yml',
              repository:repo,html_url:'https://example.com/run/999'},
            ...(retried?[{id:1000,
              display_title:'Qwen Developer Ingest worker:'+workerId,
              event:'workflow_dispatch',actor:{login:'github-actions[bot]'},
              head_branch:'main',head_sha:'b'.repeat(40),
              status:'completed',conclusion:'failure',
              run_attempt:1,path:'.github/workflows/store-agent-development-ingest.yml',
              repository:repo,html_url:'https://example.com/run/1000'}]:[]),
          ]:[]};
        throw Error('unexpected replay API '+path);
      };
    }
    assert.equal((await wakeQwenResult(resultPlan,reader())).state,
      'store-ingest-requested');
    assert.equal(resultWakes,1);
    await assert.rejects(wakeQwenResult(resultPlan,reader({failed:true})),
      /successful exact-sha/);
    await assert.rejects(wakeQwenResult(resultPlan,reader({badHead:true})),
      /Store state digest/);
    assert.equal((await wakeQwenResult(resultPlan,reader({existing:true}))).state,
      'already-woken');
    assert.equal(resultWakes,1,'replay and invalid source may not redispatch');
    assert.equal((await wakeQwenResult(resultPlan,reader({failedIngest:true}))).state,
      'store-ingest-requested');
    assert.equal(resultWakes,2,'one failed authenticated Store wake may replay once');
    assert.equal((await wakeQwenResult(resultPlan,reader({retried:true}))).state,
      'already-woken');
    assert.equal(resultWakes,2,'two prior wakes never authorize a third');

        console.log('github-comment-router: source checks, context, replay guards passed');
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'self-test') await selfTest(); else await main();
}
