#!/usr/bin/env node
// #2953: source-bound Issue/E2E contracts for scheduled Staging integrations.
// Model suggestions never authorize a merge or a "not required" decision.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {catalogFromPaths} from './issue-e2e-plan.mjs';
import {parseIssueE2E,verifyIssueE2EAgainstCatalog} from './issue-e2e-contract.mjs';
import {auditIssue} from './issue-contract.mjs';
import {classifyChangedPaths} from './e2e-full-applicability.mjs';

const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/;
const MARKER='nession-convergence-batch:v1',APPROVAL='/approve-staging-convergence';
export const AUDIT_APPROVAL='STAGING_CONVERGENCE_AUDIT_V1';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:8_000_000}).trim();
const list=s=>s.split('\n').filter(Boolean);
const api=(...args)=>{
  const token=process.env.ISSUE_GITHUB_TOKEN||process.env.READ_GITHUB_TOKEN;
  if(!token)throw Error('trusted Issue token missing');
  return JSON.parse(execFileSync('gh',['api',...args],{
    encoding:'utf8',maxBuffer:8_000_000,env:{...process.env,GH_TOKEN:token}
  }));
};
const catalog=sha=>catalogFromPaths(list(git('ls-tree','-r','--name-only',sha,'--','e2e/tests')));
const diff=(a,b)=>list(git('diff','--no-renames','--name-only',a,b));
export function batchIdentity({branch,main_sha,lane_sha,integration_head}){
  if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(branch)||branch==='main'||
    branch.includes('..')||branch.includes('@{')||branch.endsWith('.lock'))
    throw Error('invalid deploy-eligible branch');
  if(![main_sha,lane_sha,integration_head].every(s=>SHA.test(s||''))||
    new Set([main_sha,lane_sha,integration_head]).size!==3)
    throw Error('invalid exact batch SHAs');
  return MARKER+' branch='+branch+' main='+main_sha+' lane='+lane_sha+' head='+integration_head;
}
export function planBatch({branch,main_sha,lane_sha,integration_head,repoRoot=process.cwd()}) {
  // Source-attestation executes in a separate trusted checkout. Use one
  // explicit Git root for EVERY query, never the caller's incidental cwd.
  const localGit=(...args)=>execFileSync('git',args,{
    cwd:repoRoot,encoding:'utf8',maxBuffer:8_000_000
  }).trim();
  const localDiff=(a,b)=>list(localGit('diff','--no-renames','--name-only',a,b));
  const localCatalog=sha=>catalogFromPaths(list(
    localGit('ls-tree','-r','--name-only',sha,'--','e2e/tests')));

  const identity=batchIdentity({branch,main_sha,lane_sha,integration_head});
  const parents=localGit('rev-list','--parents','-n','1',integration_head).split(/\s+/);
  if(parents.length!==3||parents[0]!==integration_head||parents[1]!==lane_sha||
    parents[2]!==main_sha)throw Error('unexpected integration commit parent identity');
  const history=list(localGit('rev-list','--first-parent','--reverse',main_sha,'^'+lane_sha));
  if(history.length>400)throw Error('unbounded main history for E2E audit');
  const changed=new Set(localDiff(lane_sha,integration_head)),touched=new Set();
  for(const sha of history){
    const refs=localGit('rev-list','--parents','-n','1',sha).split(/\s+/);
    if(refs.length<2)throw Error('unattributable root commit in main history');
    for(const file of localDiff(refs[1],sha)){
      changed.add(file);
      if(file.startsWith('e2e/tests/')&&file.endsWith('.spec.ts'))touched.add(file);
    }
  }
  for(const file of localDiff(lane_sha,integration_head)){
    if(file.startsWith('e2e/tests/')&&file.endsWith('.spec.ts'))touched.add(file);
  }
  const headIds=localCatalog(integration_head),baseIds=localCatalog(lane_sha);
  const head=new Set(headIds),base=new Set(baseIds);
  const ids=catalogFromPaths([...touched]);
  const removed=ids.filter(id=>!head.has(id));
  const newIds=ids.filter(id=>head.has(id)&&!base.has(id));
  const regressionIds=ids.filter(id=>head.has(id)&&base.has(id));
  const changedPaths=[...changed].sort();
  if(!changedPaths.length)throw Error('empty integration batch');
  const impact=classifyChangedPaths(changedPaths);
  return {branch,main_sha,lane_sha,integration_head,identity,
    changedPaths,impact,newIds,regressionIds,removed,headIds,baseIds};
}
export function issueBody(plan){
  const newIds=plan.newIds.length?plan.newIds.map(id=>'- '+id):
    ['- none: no added runnable E2E IDs in exact main history'];
  const regressions=plan.regressionIds.length?plan.regressionIds.map(id=>'- '+id):
    ['- none: no existing runnable E2E IDs touched in exact main history'];
  const rows=[...plan.newIds.map(id=>'| '+id+' | New | Pending | - |'),
    ...plan.regressionIds.map(id=>'| '+id+' | Regression | Pending | - |')];
  return [
    '## Requirements: exact-SHA Staging integration batch','','<!-- '+plan.identity+' -->','',
    'Source-bound integration of main into '+plan.branch+'; Refs #2953.',
    '- Main SHA: '+plan.main_sha,'- Lane SHA: '+plan.lane_sha,
    '- Checked integration head: '+plan.integration_head,
    '- Risk: '+plan.impact.category+'; historical changed paths: '+plan.changedPaths.length,
    '- Removed historical browser test IDs (separate review required): '+(plan.removed.join(', ')||'none'),
    '',
    'New/Regression IDs are the deterministic historical minimum, not an E2E waiver.',
    'An empty proposed list or an additional risk-bearing change requires exact-batch',
    'owner approval after the canonical Issue Audit. No model-generated Pass is trusted.',
    '',
    '### Success Criteria',
    '- [ ] SC-01 Linked exact-head PR has audited E2E obligations and independent Quality/Case/E2E evidence.',
    '- [ ] SC-02 Protected merge retains both source refs and produces trusted Staging deployment evidence.',
    '',
    '## Acceptance Plan','','FENCE_YAML','acceptance:',
    '  SC-01:','    when: pr','    method: agent',
    '  SC-02:','    when: merged','    branch: '+plan.branch,'    method: agent','FENCE_YAML','',
    '## Acceptance Report','','| Criterion | Result | Evidence |','|---|---|---|',
    '| SC-01 | Pending | Awaiting exact-head checks and trusted audit |',
    '| SC-02 | Pending | Awaiting protected merge and deployment receipt |','',
    '## E2E Verification','','### New',...newIds,'','### Regression',...regressions,'',
    '## E2E Report','','| ID | Type | Result | Evidence |','|---|---|---|',...rows,'',
    '### Knowledge Impact',
    '- Decision: Read',
    '- Related knowledge: nession-cicd; issue-e2e-selection-entry',
    '- Reason: Batch consumes the existing canonical Issue-owned E2E plan.',
    '- Owner and timing: Staging Convergence controller, before protected merge',
    '- Evidence: pinned SHAs above, final CI/deployment pending','',
    '## Product alignment',
    '- [x] Preserves canonical CI and Issue E2E Gate authority.',
    '- [x] Does not modify Production release/version policy.','',
    '**Status:** In Discussion',''
  ].join('\n').replaceAll('FENCE_YAML','\x60\x60\x60yaml').replace('\x60\x60\x60yaml\n\n## Acceptance Report',
    '\x60\x60\x60\n\n## Acceptance Report');
}
export function approvalCommand(plan,digest){
  if(!/^[a-f0-9]{64}$/.test(digest))throw Error('invalid Issue E2E digest');
  return APPROVAL+' '+plan.integration_head+' '+digest;
}
export function verifyBatchIssue(issue,plan,comments=[],auditRuns=[]){
  if(!issue||issue.state!=='open'||!Number.isInteger(issue.number)||
    !issue.body?.includes('<!-- '+plan.identity+' -->'))
    throw Error('missing or stale source-bound integration Issue');
  const contract=auditIssue(issue);
  if(!contract.ok)throw Error('invalid integration Issue Contract: '+contract.errors.join('; '));
  const parsed=parseIssueE2E(issue.body,{requireDeclaration:true});
  if(parsed.errors.length)throw Error('invalid Issue E2E declaration');
  verifyIssueE2EAgainstCatalog(parsed,plan.headIds,plan.baseIds);
  for(const id of [...plan.newIds,...plan.regressionIds])
    if(!parsed.selectedIds.includes(id))throw Error('historical E2E obligation missing: '+id);
  const command=approvalCommand(plan,parsed.digest);
  const humanApproved=comments.some(c=>c?.body?.trim()===command&&
    c?.user?.login==='BestNathan'&&!c.deleted_at);
  const auditApproved=comments.some(c=>{
    const match=new RegExp('^'+AUDIT_APPROVAL+' '+plan.integration_head+
      ' '+parsed.digest+' run=([1-9][0-9]*)$').exec(c?.body?.trim()??'');
    if(!match||c?.user?.login!=='github-actions[bot]')return false;
    const run=auditRuns.find(r=>r.id===Number(match[1]));
    return run?.name==='Agent / Issue Audit'&&run.display_title==='Issue Audit #'+issue.number&&
      run.event==='workflow_dispatch'&&
      run.status==='completed'&&run.conclusion==='success'&&
      run.head_branch==='main'&&run.repository?.full_name===REPO&&
      run.head_repository?.full_name===REPO&&
      Date.parse(run.created_at)>=Date.parse(issue.created_at);
  });
  const approved=humanApproved||auditApproved;
  return {approved,reason:humanApproved?'SOURCE_BOUND_OWNER_APPROVED':
    auditApproved?'SOURCE_BOUND_ISSUE_AUDIT_APPROVED':'PENDING_SOURCE_BOUND_ISSUE_AUDIT',
    declaration_digest:parsed.digest,
    approval_command:command,selected_ids:parsed.selectedIds};
}
// The immutable integration commit is minted before any matching Issue can
// exist. GitHub's creation-ordered REST inventory can stop once it crosses
// that birth fence; scanning *all* historical Issues is not a bounded lookup.
// A 15-minute cushion covers runner/GitHub clock skew without depending on
// eventually consistent search indexing.
export function batchIssueBirthFence(committerIso,now=Date.now()){
  const born=Date.parse(committerIso);
  if(!Number.isFinite(born)||born>now+5*60_000)
    throw Error('untrusted integration commit time');
  return born-15*60_000;
}
export function inspectBatchIssuePage(issues,identity,birthFence){
  if(!Array.isArray(issues)||issues.length>100||
    typeof identity!=='string'||!identity||!Number.isFinite(birthFence))
    throw Error('untrusted bounded Issue inventory');
  const matches=[];
  let previous=Infinity;
  for(const issue of issues){
    const created=Date.parse(issue?.created_at);
    if(!Number.isFinite(created)||created>previous)
      throw Error('untrusted Issue creation order');
    previous=created;
    if(!issue.pull_request&&issue.body?.includes('<!-- '+identity+' -->'))
      matches.push(issue);
  }
  return {matches,complete:issues.length<100||previous<birthFence};
}
export function findBatchIssue(plan){
  // The controller validates this exact two-parent integration before lookup.
  // An implausibly future-dated commit fails closed rather than making a
  // creation-time search silently miss a preexisting Issue.
  const fence=batchIssueBirthFence(git('show','-s','--format=%cI',plan.integration_head));
  const matches=new Map();
  for(let page=1;page<=30;page++){
    const issues=api('repos/'+REPO+'/issues?state=all&sort=created&direction=desc&per_page=100&page='+page);
    const found=inspectBatchIssuePage(issues,plan.identity,fence);
    for(const issue of found.matches){
      if(!Number.isSafeInteger(issue.number)||issue.number<=0)
        throw Error('invalid exact integration Issue identity');
      matches.set(issue.number,issue);
    }
    if(matches.size>1)throw Error('duplicate exact integration Issues');
    if(found.complete)return [...matches.values()][0]||null;
  }
  throw Error('recent Issue inventory unbounded; refuse duplicate creation');
}
export function ensureBatchIssue(plan){
  const prior=findBatchIssue(plan);
  if(prior)return {issue:prior,created:false};
  const issue=api('--method','POST','repos/'+REPO+'/issues',
    '-f','title=Requirement: Staging integration '+plan.branch+' '+plan.main_sha.slice(0,12),
    '-f','body='+issueBody(plan),
    '-f','labels[]=requirement','-f','labels[]=ci','-f','labels[]=verification:integration');
  if(!Number.isInteger(issue.number)||issue.state!=='open')
    throw Error('failed to create integration Issue');
  return {issue,created:true};
}
export function issueApproval(plan,number){
  if(!Number.isInteger(number)||number<=0)throw Error('invalid integration Issue number');
  const issue=api('repos/'+REPO+'/issues/'+number);
  if(issue.pull_request)throw Error('integration Issue cannot be a PR');
  const comments=api('repos/'+REPO+'/issues/'+number+'/comments?per_page=100');
  if(!Array.isArray(comments)||comments.length>=100)throw Error('unbounded approval comments');
  const ids=comments.map(c=>new RegExp('^'+AUDIT_APPROVAL+' '+plan.integration_head+
    ' [0-9a-f]{64} run=([1-9][0-9]*)$').exec(c?.body?.trim()??''))
    .filter(Boolean).map(x=>Number(x[1]));
  if(new Set(ids).size>10)throw Error('unbounded Issue Audit run verification');
  const auditRuns=[...new Set(ids)].map(id=>api('repos/'+REPO+'/actions/runs/'+id));
  return verifyBatchIssue(issue,plan,comments,auditRuns);
}
function selfTest(){
  const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40);
  const plan={branch:'staging',main_sha:a,lane_sha:b,integration_head:c,
    identity:batchIdentity({branch:'staging',main_sha:a,lane_sha:b,integration_head:c}),
    newIds:[],regressionIds:['session-metadata'],removed:[],
    changedPaths:['scripts/release.mjs'],impact:{category:'mixed'},
    headIds:['session-metadata'],baseIds:['session-metadata']};
  // A large historical repository is not a reason to scan its entire Issue
  // history: only Issues created after the source integration can match.
  const now=Date.parse('2026-11-09T06:10:00Z');
  const fence=batchIssueBirthFence('2026-11-09T06:00:00Z',now);
  assert.equal(fence,Date.parse('2026-11-09T05:45:00Z'));
  assert.throws(()=>batchIssueBirthFence('invalid',now),/untrusted/);
  assert.throws(()=>batchIssueBirthFence('2026-11-09T06:20:00Z',now),/untrusted/);
  const dummy={created_at:'2026-11-09T05:50:00Z',body:'no exact marker'};
  const recent=Array.from({length:100},(_,i)=>({...dummy,number:i+1}));
  assert.equal(inspectBatchIssuePage(recent,'batch',fence).complete,false);
  const expired=recent.map((i,index)=>index===99?
    {...i,created_at:'2026-11-09T05:44:59Z'}:i);
  assert.equal(inspectBatchIssuePage(expired,'batch',fence).complete,true);
  const matched=inspectBatchIssuePage([{
    number:3,created_at:'2026-11-09T06:04:00Z',
    body:'<!-- batch -->',state:'closed'
  }],'batch',fence);
  assert.equal(matched.matches[0].number,3,'closed exact identities also block duplicates');
  assert.throws(()=>inspectBatchIssuePage([
    {created_at:'2026-11-09T05:40:00Z'},
    {created_at:'2026-11-09T06:00:00Z'}
  ],'batch',fence),/creation order/);
  const body=issueBody(plan),parsed=parseIssueE2E(body,{requireDeclaration:true});
  assert.deepEqual(parsed.errors,[]);
  const issue={number:123,state:'open',title:'Requirement: exact integration',
    labels:['requirement','ci','verification:integration'],body,created_at:'2026-11-08T00:00:00Z'};
  const approval={body:approvalCommand(plan,parsed.digest),user:{login:'BestNathan'}};
  assert.equal(verifyBatchIssue(issue,plan,[]).approved,false);
  assert.equal(verifyBatchIssue(issue,plan,[approval]).approved,true);
  assert.equal(verifyBatchIssue(issue,plan,[{...approval,user:{login:'other'}}]).approved,false);
  const auditComment={user:{login:'github-actions[bot]'},
    body:AUDIT_APPROVAL+' '+c+' '+parsed.digest+' run=42'};
  const run={id:42,name:'Agent / Issue Audit',event:'workflow_dispatch',
    status:'completed',conclusion:'success',head_branch:'main',display_title:'Issue Audit #123',
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    created_at:'2026-11-08T00:00:01Z'};
  assert.equal(verifyBatchIssue(issue,plan,[auditComment],[run]).approved,true);
  assert.equal(verifyBatchIssue(issue,plan,[auditComment],[{...run,conclusion:'failure'}]).approved,false);
  assert.equal(verifyBatchIssue(issue,plan,[auditComment],[{...run,head_branch:'staging'}]).approved,false);
  assert.throws(()=>verifyBatchIssue(issue,{...plan,identity:'stale'},[approval]),/stale/);
  assert.throws(()=>verifyBatchIssue({...issue,body:body.replace('- session-metadata','- none: fake')},plan,[approval]));
  // A historically touched browser spec must remain obligated even when
  // main later reverts that file and the final integration net diff omits it.
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'nession-convergence-batch-'));
  const original=process.cwd();
  try{
    process.chdir(tmp);
    git('init','-q','-b','main');
    git('config','user.name','Convergence Test');
    git('config','user.email','ci@example.invalid');
    fs.mkdirSync('e2e/tests/browser',{recursive:true});
    fs.writeFileSync('e2e/tests/browser/fixture-git.spec.ts','// base\\n');
    git('add','.');git('commit','-qm','base');
    git('checkout','-qb','staging');
    fs.writeFileSync('README.md','Staging-only change\\n');
    git('add','.');git('commit','-qm','staging own commit');
    const lane=git('rev-parse','HEAD');
    git('checkout','main');
    fs.writeFileSync('e2e/tests/browser/fixture-git.spec.ts','// changed historically\\n');
    git('add','.');git('commit','-qm','touch browser regression');
    fs.writeFileSync('e2e/tests/browser/fixture-git.spec.ts','// base\\n');
    git('add','.');git('commit','-qm','restore browser regression');
    fs.writeFileSync('e2e/tests/browser/another-test.spec.ts','// new test\\n');
    git('add','.');git('commit','-qm','new browser ID');
    const main=git('rev-parse','HEAD');
    const tree=git('merge-tree','--write-tree',lane,main).split('\n')[0];
    const integration=git('commit-tree',tree,'-p',lane,'-p',main,
      '-m','checked exact integration');
    assert.equal(diff(lane,integration).includes('e2e/tests/browser/fixture-git.spec.ts'),false,
      'fixture genuinely has no net browser change');
    const source=planBatch({branch:'staging',main_sha:main,
      lane_sha:lane,integration_head:integration});
    assert.deepEqual(source.newIds,['another-test']);
    assert.deepEqual(source.regressionIds,['fixture-git']);
    assert.throws(()=>planBatch({branch:'staging',main_sha:lane,
      lane_sha:main,integration_head:integration}),/parent identity/);
  }finally{
    process.chdir(original);
    fs.rmSync(tmp,{recursive:true,force:true});
  }
  console.log('Staging convergence batch E2E contract: historical source + approval negatives PASS');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href&&
   process.argv[2]==='self-test')selfTest();
