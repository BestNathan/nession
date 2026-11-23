#!/usr/bin/env node
// #3689: GitHub-native Auto-merge admission. GitHub owns merge requirements;
// Nession only verifies that its canonical qualification is a required status.
// Do not invent extra strict-mode / constituent-CI branch policy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';

export const QUALIFICATION_CONTEXT = 'nession/convergence-qualification';
const SHA = /^[0-9a-f]{40}$/;
const REPO = 'BestNathan/nession';
const PUBLISHER = 'nession-publisher[bot]';

function api(token, args) {
  if (!token) throw Error('missing GitHub token for convergence auto-merge boundary');
  return JSON.parse(execFileSync('gh', ['api', ...args], {
    encoding:'utf8', maxBuffer:4_000_000, stdio:['ignore','pipe','pipe'],
    env:{...process.env,GH_TOKEN:token},
  }));
}

// One GitHub-required qualification status is enough: the trusted qualifier
// already verifies exact-head Quality, Case, E2E, deployment and Issue evidence.
// Do not force strict-base mode or make every underlying check a second required
// context. Without an enforced qualification check, arming before qualification
// could merge immediately, so fail closed.
export function hasRequiredQualificationCheck(branch) {
  const checks=branch?.protection?.required_status_checks;
  return branch?.protected===true &&
    checks?.enforcement_level==='everyone' &&
    checks?.contexts?.includes(QUALIFICATION_CONTEXT)===true;
}

export function isTrustedConvergencePr(pr,{repo,base,headSha}) {
  return repo===REPO && SHA.test(headSha??'') &&
    pr?.state==='open' && pr.draft===false &&
    pr.user?.login===PUBLISHER &&
    pr.base?.ref===base && pr.base?.repo?.full_name===REPO &&
    pr.head?.sha===headSha && pr.head?.repo?.full_name===REPO &&
    pr.body?.startsWith('Staging Convergence automated proposal') &&
    (base==='main' ? pr.head.ref==='staging' :
      /^chore\/staging-sync-[a-zA-Z0-9-]+$/.test(pr.head.ref));
}

// Required checks apply to ALL PRs targeting a protected branch.
// Ordinary PRs are not native convergence proposals and need a trusted
// success/not-applicable qualification; source Quality checks remain required.
// Publisher-owned convergence-shaped PRs may ONLY be qualified by the
// independent canonical Controller after source/deploy/Issue verification.
export function classifyPrQualification(pr,otherOpenPrs=[],stagingHeadSha=null) {
  const base=pr?.base?.ref;
  const head=pr?.head?.ref;
  const publisher=pr?.user?.login===PUBLISHER;
  const nativeShape=(base==='main'&&head==='staging') ||
    (base!=='main'&&/^chore\/staging-sync-[a-zA-Z0-9-]+$/.test(head??''));
  const marker=pr?.body?.startsWith('Staging Convergence automated proposal');
  if(!['main','staging'].includes(base) ||
     pr?.base?.repo?.full_name!==REPO ||
     !SHA.test(pr?.head?.sha??'') ||
     pr?.head?.repo?.full_name!==REPO)
    return {state:'failure',reason:'Invalid or foreign PR identity'};
  if(publisher&&(nativeShape||marker)){
    if(nativeShape&&marker&&pr.state==='open'&&!pr.draft)
      return {state:'pending',reason:'Awaiting canonical Convergence qualification'};
    return {state:'failure',reason:'Publisher proposal requires trusted Convergence identity'};
  }
  // Commit statuses are keyed by SHA, not PR identity. A second ordinary PR
  // with the same HEAD must never overwrite a protected native proposal's
  // pending/failing status with a not-applicable success.
  if(!Array.isArray(otherOpenPrs)||otherOpenPrs.length>=100 ||
     (SHA.test(stagingHeadSha??'') && stagingHeadSha===pr.head.sha) ||
     otherOpenPrs.some(other=>other?.number!==pr.number &&
       other?.state==='open' && other?.head?.sha===pr.head.sha &&
       other?.user?.login===PUBLISHER &&
       (
         other?.body?.startsWith('Staging Convergence automated proposal') ||
         (other?.base?.ref==='main'&&other?.head?.ref==='staging') ||
         /^chore\/staging-sync-[a-zA-Z0-9-]+$/.test(other?.head?.ref??'')
       )))
    return {state:'failure',reason:'Shared or unbounded native Convergence HEAD'};
  return {state:'success',reason:'Not a native Convergence PR; ordinary Quality checks apply'};
}

function qualifyPullRequestEvent() {
  if(process.env.GITHUB_REPOSITORY!==REPO)throw Error('untrusted GitHub repository');
  const event=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  if(!['opened','reopened','synchronize','ready_for_review'].includes(event.action) ||
      !Number.isSafeInteger(event.number)||event.number<=0)
    throw Error('invalid pull_request_target qualification wake');
  const pr=api(process.env.READ_GITHUB_TOKEN,
    ['repos/'+REPO+'/pulls/'+event.number]);
  if(pr.number!==event.number||
      pr.head?.sha!==event.pull_request?.head?.sha||
      pr.base?.ref!==event.pull_request?.base?.ref)
    throw Error('stale/foreign event HEAD cannot certify qualification');
  // This bounded complete inventory binds the not-applicable verdict to
  // the absence of ANY open publisher-native PR on the exact same commit.
  const open=api(process.env.READ_GITHUB_TOKEN,
    ['repos/'+REPO+'/pulls?state=open&per_page=100']);
  if(!Array.isArray(open)||open.length>=100)
    throw Error('unbounded open PR inventory cannot authorize not-applicable status');
  const stage=api(process.env.READ_GITHUB_TOKEN,['repos/'+REPO+'/branches/staging']);
  const {state,reason}=classifyPrQualification(pr,open,stage?.commit?.sha);
  publishQualificationStatus(REPO,pr.head.sha,state,reason);
  console.log(JSON.stringify({pr:pr.number,head_sha:pr.head.sha,state,reason}));
}

function policyFor(repo,base) {
  const branch=api(process.env.READ_GITHUB_TOKEN,
    ['repos/'+repo+'/branches/'+encodeURIComponent(base)]);
  return hasRequiredQualificationCheck(branch);
}

export function isQualificationRequired(repo,base) {
  if(repo!==REPO || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base))
    throw Error('invalid convergence qualification target');
  return policyFor(repo,base);
}

// A create-status response does not prove the commit it was written for:
// the endpoint is source-SHA scoped, while the returned status object itself
// need not carry a SHA. Re-read the exact SHA and bind its newest matching
// context to the unique created status id. Foreign/replayed status is denied.
export function matchesQualificationReadback(created,inventory,state) {
  if(!created || !Number.isSafeInteger(created.id) || created.id<=0 ||
      created.context!==QUALIFICATION_CONTEXT || created.state!==state ||
      !Array.isArray(inventory) || inventory.length===0) return false;
  const latest=inventory.find(item=>item.context===QUALIFICATION_CONTEXT);
  return latest?.id===created.id && latest.state===state &&
    latest.context===QUALIFICATION_CONTEXT;
}

// A successful GitHub Status POST may not be immediately visible through the
// independent commits/:sha/statuses GET. Retry ONLY that read (never POST),
// while still proving that our created ID is the newest qualifying context.
// A newer conflicting Status is terminal: retries must not launder another
// writer's decision into our own.
export function verifyQualificationReadback(created,state,read,pause=()=>{}) {
  if (!created || !Number.isSafeInteger(created.id) || created.id<=0) {
    throw Error('invalid created GitHub status identity');
  }
  for (let attempt=1; attempt<=4; attempt++) {
    const inventory=read();
    if(matchesQualificationReadback(created,inventory,state)) return attempt;
    const latest=Array.isArray(inventory)
      ? inventory.find(item=>item.context===QUALIFICATION_CONTEXT) : null;
    if(latest?.id===created.id || (Number.isSafeInteger(latest?.id) &&
        latest.id>created.id)) {
      throw Error('GitHub qualification status was superseded or altered');
    }
    if(attempt<4) pause(attempt);
  }
  throw Error('GitHub status readback does not match exact HEAD and latest context');
}

// #4230: reconcile stdout is a single JSON document consumed by jq. A
// successful GitHub status GET retry is diagnostic-only and must never pollute
// the Controller's machine-readable stdout channel.
export function reportQualificationStatusReadback(attempts) {
  if(attempts>1) console.error('Qualification Status GET became visible after '+attempts+' attempts');
}

export function publishQualificationStatus(repo,headSha,state,reason) {
  if(repo!==REPO || !SHA.test(headSha) || !['pending','success','failure'].includes(state))
    throw Error('invalid source-bound convergence status publication');
  const description=String(reason??'').replace(/\s+/g,' ').slice(0,135);
  const run=process.env.GITHUB_RUN_ID;
  const args=['--method','POST','repos/'+repo+'/statuses/'+headSha,
    '-f','context='+QUALIFICATION_CONTEXT,'-f','state='+state,
    '-f','description='+description];
  if(/^[1-9][0-9]*$/.test(run??''))
    args.push('-f','target_url=https://github.com/'+repo+'/actions/runs/'+run);
  const token=process.env.STATUS_GITHUB_TOKEN;
  const status=api(token,args);
  const attempts=verifyQualificationReadback(status,state,()=>api(
    process.env.READ_GITHUB_TOKEN,
    ['repos/'+repo+'/commits/'+headSha+'/statuses?per_page=100']),
    ()=>execFileSync('sleep',['0.5'],{stdio:'ignore'}));
  reportQualificationStatusReadback(attempts);
  return status;
}

// Called by the trusted controller for a specific planner-authenticated PR.
// Publish a pending HEAD status BEFORE arming the merge; GitHub cannot merge
// until the independent qualifier publishes a success for that same HEAD.
export function armNativeAutoMerge({repo,prNumber,base,headSha}) {
  if(repo!==REPO || !Number.isSafeInteger(prNumber)||prNumber<=0 ||
     !SHA.test(headSha) || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base))
    throw Error('invalid convergence PR for auto-merge');
  const readToken=process.env.READ_GITHUB_TOKEN;
  const pr=api(readToken,['repos/'+repo+'/pulls/'+prNumber]);
  if(!isTrustedConvergencePr(pr,{repo,base,headSha}))
    return {armed:false,reason:'UNTRUSTED_AUTO_MERGE_PR'};
  if(!policyFor(repo,base))
    return {armed:false,reason:'GITHUB_REQUIRED_QUALIFICATION_NOT_CONFIGURED'};
  if(pr.auto_merge && pr.auto_merge.merge_method!=='merge')
    return {armed:false,reason:'AUTO_MERGE_METHOD_NOT_MERGE'};

  publishQualificationStatus(repo,headSha,'pending','Awaiting source-bound Convergence qualification');
  if(!pr.auto_merge) {
    const query='mutation($id:ID!,$sha:GitObjectID!){enablePullRequestAutoMerge('+
      'input:{pullRequestId:$id,expectedHeadOid:$sha,mergeMethod:MERGE}){'+
      'pullRequest{number autoMergeRequest{enabledAt mergeMethod}}}}';
    const result=api(process.env.GH_TOKEN,['graphql','-f','query='+query,
      '-f','id='+pr.node_id,'-f','sha='+headSha]);
    const armed=result?.data?.enablePullRequestAutoMerge?.pullRequest;
    if(armed?.number!==prNumber || armed.autoMergeRequest?.mergeMethod!=='MERGE')
      throw Error('GitHub did not confirm merge-commit auto-merge for exact HEAD');
  }
  return {armed:true,context:QUALIFICATION_CONTEXT};
}

// GitHub Actions allows only one pending workflow per concurrency group.
// A workflow-global Convergence lock can cancel ordinary pull_request_target
// classifiers before they write the required status, stranding green PRs.
// The controller still needs one global lock, but classification must be
// independently schedulable.
export function qualifierConcurrencyIsolated(workflow) {
  if (typeof workflow !== 'string') return false;
  const jobs=workflow.match(/^jobs:\s*$/m);
  if (!jobs || /^concurrency:\s*$/m.test(workflow.slice(0,jobs.index))) return false;
  const converge=workflow.split(/^  converge:\s*$/m);
  if (converge.length !== 2) return false;
  const job=converge[1].split(/^  [a-z][a-z0-9_-]*:\s*$/m)[0];
  return /^    concurrency:\s*\n      group: release-staging-convergence\s*\n      cancel-in-progress: false\s*$/m.test(job);
}

function selfTest(){
  const workflowPath=new URL('../.github/workflows/release-staging-convergence.yml',import.meta.url);
  const current=fs.readFileSync(workflowPath,'utf8');
  assert.equal(qualifierConcurrencyIsolated(current),true,
    'required PR classifier must not share controller workflow-global queue');
  assert.equal(qualifierConcurrencyIsolated(current.replace(/^jobs:\s*$/m,
    'concurrency:\n  group: release-staging-convergence\n  cancel-in-progress: false\n\njobs:')),false,
    'reintroducing a workflow-global lock must strand qualification tests');
  assert.equal(qualifierConcurrencyIsolated(current.replace(
    '      group: release-staging-convergence',
    '      group: convergence-accidentally-unlocked')),false,
    'controller must retain its canonical serialized writer lock');

  const checks={enforcement_level:'everyone',
    contexts:[QUALIFICATION_CONTEXT]};
  const branch={protected:true,protection:{required_status_checks:checks}};
  assert.equal(hasRequiredQualificationCheck(branch),true);
  assert.equal(hasRequiredQualificationCheck({...branch,protected:false}),false);
  assert.equal(hasRequiredQualificationCheck({...branch,protection:{
    required_status_checks:{...checks,contexts:['rust-check','web-check']}}}),false);
  assert.equal(hasRequiredQualificationCheck({...branch,protection:{
    required_status_checks:{...checks,enforcement_level:'off'}}}),false);
  assert.equal(hasRequiredQualificationCheck({...branch,protection:{
    required_status_checks:{...checks,strict:false}}}),true,
    'GitHub base-up-to-date strict mode is not required by native Auto-merge');
  assert.equal(hasRequiredQualificationCheck({...branch,protection:{
    required_status_checks:{...checks,contexts:[QUALIFICATION_CONTEXT]}}}),true,
    'constituent CI contexts are evaluated by the canonical qualification owner');

  const normal={state:'open',draft:false,user:{login:'BestNathan'},
    base:{ref:'main',repo:{full_name:REPO}},head:{
      ref:'fix/safe',sha:'a'.repeat(40),repo:{full_name:REPO}},
    body:'Refs #3689'};
  assert.equal(classifyPrQualification(normal).state,'success',
    'ordinary PR must receive a required not-applicable status');
  const publisherSameSha={...normal,number:44,user:{login:PUBLISHER},
    head:{...normal.head,ref:'staging'},
    body:'Staging Convergence automated proposal (source: main)'};
  assert.equal(classifyPrQualification({...normal,number:42},
    [publisherSameSha]).state,'failure',
    'same SHA on a native PR must never receive a foreign success');
  assert.equal(classifyPrQualification(normal,[],normal.head.sha).state,'failure',
    'staging source SHA must never be exempted by another PR');
  assert.equal(classifyPrQualification(normal,Array.from({length:100},
    (_,i)=>({...normal,number:i+1}))).state,'failure',
    'truncated open PR inventory must never authorize not-applicable');

  assert.equal(classifyPrQualification({...normal,base:{
    ref:'staging',repo:{full_name:REPO}}}).state,'success');
  assert.equal(classifyPrQualification({...normal,user:{login:PUBLISHER},
    head:{...normal.head,ref:'staging'},
    body:'Staging Convergence automated proposal (source: main)'}).state,'pending');
  assert.equal(classifyPrQualification({...normal,user:{login:PUBLISHER},
    head:{...normal.head,ref:'staging'},
    body:'not a qualified convergence PR'}).state,'failure');
  assert.equal(classifyPrQualification({...normal,head:{
    ...normal.head,repo:{full_name:'attacker/fork'}}}).state,'failure');
  assert.equal(classifyPrQualification({...normal,user:{login:PUBLISHER},
    body:'Staging Convergence automated proposal (forged)',
    head:{...normal.head,ref:'fix/not-a-sync'}}).state,'failure');
  const created={id:108,context:QUALIFICATION_CONTEXT,state:'pending'};
  const previous={id:107,context:QUALIFICATION_CONTEXT,state:'success'};
  assert.equal(matchesQualificationReadback(created,[created,previous],'pending'),true);
  assert.equal(matchesQualificationReadback(created,[previous,created],'pending'),false,
    'newer green source must not be mistaken for our pending write');
  assert.equal(matchesQualificationReadback(created,[{...created,id:109}], 'pending'),false);
  assert.equal(matchesQualificationReadback(created,[created],'success'),false);
  assert.equal(matchesQualificationReadback(created,[created,
    ...Array.from({length:99},(_,i)=>({...created,id:i+1}))], 'pending'),true,
    'historical status count cannot strand the latest authenticated write');

  // #3689: GET may briefly return the previous status after a successful
  // POST. No second write is authorized; retry only exact status readback.
  let reads=0,pauses=0;
  const confirmed=verifyQualificationReadback(created,'pending',()=>{
    reads++;
    return reads<3 ? [previous] : [created,previous];
  },()=>{pauses++});
  assert.equal(confirmed,3);
  assert.equal(reads,3);
  assert.equal(pauses,2);
  assert.throws(()=>verifyQualificationReadback(created,'pending',
    ()=>[previous]),/does not match exact HEAD and latest context/);
  assert.throws(()=>verifyQualificationReadback(created,'pending',
    ()=>[{...created,id:109}]),/superseded or altered/);
  assert.throws(()=>verifyQualificationReadback(created,'pending',
    ()=>[{...created,state:'failure'}]),/superseded or altered/);
  assert.equal(verifyQualificationReadback(created,'pending',
    ()=>[created]),1);
  // #4230: exercise real Node stdout/stderr pipes, not a mock reporter.
  // Reconcile output must remain one strict JSON document after a retried
  // status GET; an old stdout diagnostic must be rejected by its JSON reader.
  const fixtureJson=JSON.stringify([{outcome:'BLOCKED',reason:'MISSING_EXACT_HEAD_PR_CHECK'}])+'\\n';
  const emitter=JSON.stringify(new URL('./staging-convergence-automerge.mjs',import.meta.url).href);
  const script='import {reportQualificationStatusReadback} from '+emitter+
    ';reportQualificationStatusReadback(2);process.stdout.write('+JSON.stringify(fixtureJson)+');';
  const emitted=spawnSync(process.execPath,['--input-type=module','-e',script],{
    encoding:'utf8',maxBuffer:1024*1024
  });
  assert.equal(emitted.status,0,emitted.stderr);
  assert.equal(emitted.stdout,fixtureJson,'reconcile stdout must contain only JSON');
  assert.match(emitted.stderr,/Qualification Status GET became visible after 2 attempts/);
  assert.deepEqual(JSON.parse(emitted.stdout),
    [{outcome:'BLOCKED',reason:'MISSING_EXACT_HEAD_PR_CHECK'}]);
  assert.throws(()=>JSON.parse(emitted.stderr+emitted.stdout),SyntaxError,
    'polluting a JSON stream with a retry diagnostic must stay a hard error');
  assert.throws(()=>JSON.parse(fixtureJson+'unexpected second document'),SyntaxError,
    'trailing/non-JSON reconcile output must never be silently stripped');

  const pr={state:'open',draft:false,user:{login:PUBLISHER},
    base:{ref:'main',repo:{full_name:REPO}},head:{ref:'staging',
      sha:'a'.repeat(40),repo:{full_name:REPO}},
    body:'Staging Convergence automated proposal (test)'};
  const pinned={repo:REPO,base:'main',headSha:'a'.repeat(40)};
  assert.equal(isTrustedConvergencePr(pr,pinned),true);
  assert.equal(isTrustedConvergencePr({...pr,user:{login:'attacker'}},pinned),false);
  assert.equal(isTrustedConvergencePr(pr,{...pinned,headSha:'b'.repeat(40)}),false);
  assert.equal(isTrustedConvergencePr({...pr,body:'untrusted PR'},pinned),false);
  assert.equal(isTrustedConvergencePr({...pr,head:{...pr.head,repo:{full_name:'evil/fork'}}},pinned),false);
  const sync={...pr,base:{ref:'staging',repo:{full_name:REPO}},
    head:{...pr.head,ref:'chore/staging-sync-staging-aaaaaaaaaaaa-bbbbbbbbbbbb'}};
  assert.equal(isTrustedConvergencePr(sync,{...pinned,base:'staging'}),true);
  assert.equal(isTrustedConvergencePr({...sync,head:{...sync.head,ref:'main'}},
    {...pinned,base:'staging'}),false);
  process.stdout.write('staging convergence native auto-merge self-test: PASS\n');
}

if(process.argv[1]?.endsWith('/staging-convergence-automerge.mjs')){
  if(process.argv[2]==='self-test')selfTest();
  else if(process.argv[2]==='classify')qualifyPullRequestEvent();
  else throw Error('usage: self-test | classify');
}
