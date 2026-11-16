#!/usr/bin/env node
// #3689: GitHub-native convergence auto-merge admission. Never substitute this
// script's verdict for GitHub's *effective strict required* status protection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

export const QUALIFICATION_CONTEXT = 'nession/convergence-qualification';
const UNIVERSAL_REQUIRED=['rust-check','web-check',QUALIFICATION_CONTEXT];
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

// Classic branch protection must require this exact context, and strict mode
// must invalidate otherwise-successful HEAD checks when the base advances.
// Ruleset-only or unreadable configurations are intentionally NOT inferred.
export function hasStrictQualificationProtection(graphql, branch) {
  const rule=graphql?.data?.repository?.ref?.branchProtectionRule;
  return branch?.protected===true &&
    branch?.protection?.required_status_checks?.enforcement_level==='everyone' &&
    UNIVERSAL_REQUIRED.every(context=>
      branch.protection.required_status_checks.contexts?.includes(context)) &&
    rule?.requiresStatusChecks===true &&
    rule?.requiresStrictStatusChecks===true &&
    UNIVERSAL_REQUIRED.every(context=>rule?.requiredStatusCheckContexts?.includes(context)===true);
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
export function classifyPrQualification(pr) {
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
  const {state,reason}=classifyPrQualification(pr);
  publishQualificationStatus(REPO,pr.head.sha,state,reason);
  console.log(JSON.stringify({pr:pr.number,head_sha:pr.head.sha,state,reason}));
}

function policyFor(repo,base) {
  const readToken=process.env.READ_GITHUB_TOKEN;
  const [owner,name]=repo.split('/');
  const branch=api(readToken,['repos/'+repo+'/branches/'+encodeURIComponent(base)]);
  const query='query($owner:String!,$name:String!,$ref:String!){'+
    'repository(owner:$owner,name:$name){ref(qualifiedName:$ref){'+
    'branchProtectionRule{requiresStatusChecks requiresStrictStatusChecks requiredStatusCheckContexts}}}}';
  const graphql=api(readToken,['graphql','-f','query='+query,
    '-f','owner='+owner,'-f','name='+name,'-f','ref=refs/heads/'+base]);
  return hasStrictQualificationProtection(graphql,branch);
}

export function isStrictQualificationRequired(repo,base) {
  if(repo!==REPO || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base))
    throw Error('invalid strict convergence qualification target');
  return policyFor(repo,base);
}

// A create-status response does not prove the commit it was written for:
// the endpoint is source-SHA scoped, while the returned status object itself
// need not carry a SHA. Re-read the exact SHA and bind its newest matching
// context to the unique created status id. Foreign/replayed status is denied.
export function matchesQualificationReadback(created,inventory,state) {
  if(!created || !Number.isSafeInteger(created.id) || created.id<=0 ||
      created.context!==QUALIFICATION_CONTEXT || created.state!==state ||
      !Array.isArray(inventory) || inventory.length>=100) return false;
  const latest=inventory.find(item=>item.context===QUALIFICATION_CONTEXT);
  return latest?.id===created.id && latest.state===state &&
    latest.context===QUALIFICATION_CONTEXT;
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
  const statuses=api(process.env.READ_GITHUB_TOKEN,
    ['repos/'+repo+'/commits/'+headSha+'/statuses?per_page=100']);
  if(!matchesQualificationReadback(status,statuses,state))
    throw Error('GitHub status readback does not match exact HEAD and latest context');
  return status;
}

// Called by the trusted controller for a specific planner-authenticated PR.
// Publish a pending HEAD status BEFORE arming the merge; GitHub cannot merge
// until the independent qualifier publishes a success for that same HEAD.
export function armProtectedAutoMerge({repo,prNumber,base,headSha}) {
  if(repo!==REPO || !Number.isSafeInteger(prNumber)||prNumber<=0 ||
     !SHA.test(headSha) || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base))
    throw Error('invalid convergence PR for auto-merge');
  const readToken=process.env.READ_GITHUB_TOKEN;
  const pr=api(readToken,['repos/'+repo+'/pulls/'+prNumber]);
  if(!isTrustedConvergencePr(pr,{repo,base,headSha}))
    return {armed:false,reason:'UNTRUSTED_AUTO_MERGE_PR'};
  if(!policyFor(repo,base))
    return {armed:false,reason:'STRICT_REQUIRED_QUALIFICATION_NOT_CONFIGURED'};
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

function selfTest(){
  const sample={
    data:{repository:{ref:{branchProtectionRule:{
      requiresStatusChecks:true,requiresStrictStatusChecks:true,
      requiredStatusCheckContexts:[...UNIVERSAL_REQUIRED],
    }}}},
  };
  const branch={protected:true,protection:{required_status_checks:{
    enforcement_level:'everyone',contexts:[...UNIVERSAL_REQUIRED],
  }}};
  assert.equal(hasStrictQualificationProtection(sample,branch),true);
  assert.equal(hasStrictQualificationProtection(sample,{...branch,protected:false}),false);
  assert.equal(hasStrictQualificationProtection(sample,{...branch,protection:{
    required_status_checks:{...branch.protection.required_status_checks,contexts:['web-check']}}}),false);
  assert.equal(hasStrictQualificationProtection(sample,{...branch,protection:{
    required_status_checks:{...branch.protection.required_status_checks,enforcement_level:'off'}}}),false);
  assert.equal(hasStrictQualificationProtection({data:{repository:{ref:{branchProtectionRule:{
    ...sample.data.repository.ref.branchProtectionRule,requiresStrictStatusChecks:false}}}}},branch),false);
  assert.equal(hasStrictQualificationProtection({data:{repository:{ref:null}}},branch),false);

  const normal={state:'open',draft:false,user:{login:'BestNathan'},
    base:{ref:'main',repo:{full_name:REPO}},head:{
      ref:'fix/safe',sha:'a'.repeat(40),repo:{full_name:REPO}},
    body:'Refs #3689'};
  assert.equal(classifyPrQualification(normal).state,'success',
    'ordinary PR must receive a required not-applicable status');
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
  const requiredOnly={...branch,protection:{required_status_checks:{
    enforcement_level:'everyone',contexts:[QUALIFICATION_CONTEXT,'web-check']}}};
  assert.equal(hasStrictQualificationProtection(sample,requiredOnly),false,
    'normal PR Quality checks must be required alongside qualification');
  const created={id:108,context:QUALIFICATION_CONTEXT,state:'pending'};
  const previous={id:107,context:QUALIFICATION_CONTEXT,state:'success'};
  assert.equal(matchesQualificationReadback(created,[created,previous],'pending'),true);
  assert.equal(matchesQualificationReadback(created,[previous,created],'pending'),false,
    'newer green source must not be mistaken for our pending write');
  assert.equal(matchesQualificationReadback(created,[{...created,id:109}], 'pending'),false);
  assert.equal(matchesQualificationReadback(created,[created],'success'),false);
  assert.equal(matchesQualificationReadback(created,Array.from({length:100},
    (_,i)=>({...created,id:i+1})), 'pending'),false,
    'truncated remote status inventory must fail closed');

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
