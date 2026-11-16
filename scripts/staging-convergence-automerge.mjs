#!/usr/bin/env node
// #3689: GitHub-native convergence auto-merge admission. Never substitute this
// script's verdict for GitHub's *effective strict required* status protection.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

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

// Classic branch protection must require this exact context, and strict mode
// must invalidate otherwise-successful HEAD checks when the base advances.
// Ruleset-only or unreadable configurations are intentionally NOT inferred.
export function hasStrictQualificationProtection(graphql, branch) {
  const rule=graphql?.data?.repository?.ref?.branchProtectionRule;
  return branch?.protected===true &&
    branch?.protection?.required_status_checks?.enforcement_level==='everyone' &&
    branch.protection.required_status_checks.contexts?.includes(QUALIFICATION_CONTEXT) &&
    rule?.requiresStatusChecks===true &&
    rule?.requiresStrictStatusChecks===true &&
    rule?.requiredStatusCheckContexts?.includes(QUALIFICATION_CONTEXT)===true;
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
  const status=api(process.env.STATUS_GITHUB_TOKEN,args);
  if(status.state!==state || status.context!==QUALIFICATION_CONTEXT ||
      status.sha!==headSha)throw Error('GitHub status readback does not match exact HEAD');
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
      requiredStatusCheckContexts:[QUALIFICATION_CONTEXT,'rust-check'],
    }}}},
  };
  const branch={protected:true,protection:{required_status_checks:{
    enforcement_level:'everyone',contexts:[QUALIFICATION_CONTEXT,'web-check'],
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
  else throw Error('usage: self-test');
}
