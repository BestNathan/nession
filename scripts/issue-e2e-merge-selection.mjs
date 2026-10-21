#!/usr/bin/env node
// Verify the exact merge commit and its owning PR before selecting Issue E2E.
// A main/staging push is NOT implicit authority to run all browser tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { prepare, pathsCannotAffectE2E } from './issue-e2e-selection-entry.mjs';
import { parsePreMergeIssueNumbers } from './requirement-acceptance.mjs';
import { planVerification } from './verification-tier-policy.mjs';

const REPO='BestNathan/nession', SHA=/^[0-9a-f]{40}$/;
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
const gh=(resource)=>JSON.parse(execFileSync('gh',['api',resource],{encoding:'utf8',
  env:process.env,maxBuffer:4*1024*1024}));
export function mergeIdentity(event,commit,prs) {
  if(event?.repository?.full_name!==REPO || !['refs/heads/main','refs/heads/staging'].includes(event.ref) ||
    !SHA.test(event.after??'') || event.after!==commit.sha ||
    !Array.isArray(commit.parents)||![1,2].includes(commit.parents.length) ||
    !commit.parents.every(p=>SHA.test(p)) || !Array.isArray(prs) || prs.length>20)
    throw Error('untrusted push/commit identity');
  const matching=prs.filter(pr=>typeof pr?.merged_at === 'string' && pr.merged_at.length > 0 &&
    pr?.merge_commit_sha===commit.sha && pr?.base?.repo?.full_name===REPO &&
    pr?.base?.ref===event.ref.slice(11) && pr?.head?.repo?.full_name===REPO &&
    (commit.parents.length===1 ||
      (commit.parents.length===2 && pr?.head?.sha===commit.parents[1])));
  if(matching.length>1)throw Error('ambiguous exact merge PR identity');
  return {targetSha:commit.sha,baseSha:commit.parents[0],pr:matching[0]??null};
}
export function mergedSelection(event,commit,prs,issues,repoRoot) {
  const target=mergeIdentity(event,commit,prs);
  if(git(repoRoot,'rev-parse','HEAD')!==target.targetSha)
    throw Error('merged source checkout does not match target SHA');
  // Renames expose both paths: moving runtime code into docs never skips E2E.
  const paths=git(repoRoot,'diff','--no-renames','--name-only',target.baseSha,target.targetSha)
    .split('\n').filter(Boolean);
  if(!paths.length) throw Error('empty merge change scope');
  if(!target.pr) {
    if(!pathsCannotAffectE2E(paths))
      throw Error('non-PR runtime push requires trusted risk audit; full E2E is not the fallback');
    return {schema_version:1,kind:'issue_e2e_selection',base_sha:target.baseSha,
      target_sha:target.targetSha,merge_sha:target.targetSha,source_event:'push',
      mode:'not-required',selected:[],issues:[],
      reason:'verified-unassociated-metadata-only-merge'};
  }
  const numbers=parsePreMergeIssueNumbers(target.pr.body, 'BestNathan','nession',target.pr.title);
  if(numbers.length!==issues.length || !issues.every(i=>numbers.includes(i.number)))
    throw Error('linked Issue contract set mismatches authenticated merged PR');
  const synthetic={repository:{full_name:REPO},source_event:'push',
    pull_request:{number:target.pr.number,title:target.pr.title,body:target.pr.body,
      merge_commit_sha:target.targetSha,
      base:{sha:target.baseSha},
      head:{sha:target.targetSha,repo:{full_name:REPO}}}};
  const plan=prepare(synthetic,issues,repoRoot);
  if(plan.mode==='unresolved')
    throw Error('merged PR has no verified scoped E2E contract for affected code; Audit must resolve, not silently run Full E2E');
  // Labels inform the scope of verification but never authorize skipping a
  // selected E2E ID or silently executing Full. Explicit L3 milestone means
  // downstream Acceptance requires a separately authenticated Full receipt.
  const closes=[...String(target.pr.body??'').matchAll(/(?:^|\n)\s*(?:closes?|fixes?|resolves?)\s+#([1-9][0-9]*)\b/gim)]
    .map(m=>Number(m[1]));
  const verification=planVerification({
    issues,closingIssueNumbers:closes,changedPaths:paths,
    fullMilestone:closes.length>0,
  });
  if(verification.needs_audit)
    throw Error('unclassified changed path requires a trusted Audit decision before selected merge E2E can pass');
  return {...plan,source_event:'push',merge_sha:target.targetSha,
    source_pr:target.pr.number,verification,
    reason:plan.reason??'verified-merge-issue-scope'};
}
function selfTest(){
  const sha='a'.repeat(40),base='b'.repeat(40),head='c'.repeat(40);
  const event={repository:{full_name:REPO},ref:'refs/heads/main',after:sha};
  const commit={sha,parents:[base,head]};
  const pr={number:1,merged_at:'2026-10-21T02:00:00Z',merge_commit_sha:sha,
    base:{ref:'main',repo:{full_name:REPO}},head:{sha:head,repo:{full_name:REPO}}};
  assert.equal(mergeIdentity(event,commit,[pr]).pr.number,1);
  const squash={sha,parents:[base]};
  assert.equal(mergeIdentity(event,squash,[pr]).pr.number,1,
    'GitHub-attested squash merge PR must not be mistaken for an unassociated push');
  assert.equal(mergeIdentity(event,commit,[]).pr,null);
  for(const [e,c,p] of [
    [{...event,after:base},commit,[pr]],
    [event,{...commit,parents:[base]},[pr,pr]],
    [{...event,ref:'refs/heads/dev'},commit,[pr]],
    [event,{...commit,parents:[base,head,base]},[pr,pr]],
    [event,commit,[pr,pr]],
  ]) {
    if(p.length===2&&c.parents.length===1) {
      assert.throws(()=>mergeIdentity(e,c,p),/ambiguous/);continue;
    }
    assert.throws(()=>mergeIdentity(e,c,p),/identity|ambiguous/);
  }
  console.log('merge E2E source: exact push/PR parent, no misleading direct-push full fallback');
}
function main(){
  if(process.argv[2]==='self-test')return selfTest();
  if(process.argv[2]!=='plan'||process.argv.length!==6)
    throw Error('usage: issue-e2e-merge-selection.mjs plan EVENT REPO_ROOT OUTPUT');
  const event=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
  const root=process.argv[4],out=process.argv[5];
  const sha=git(root,'rev-parse','HEAD');
  if(!SHA.test(sha)||event.after!==sha)throw Error('untrusted push source checkout');
  const parents=git(root,'rev-list','--parents','-n','1',sha).split(/\s+/);
  if(parents[0]!==sha)throw Error('untrusted git commit parent proof');
  const commit={sha,parents:parents.slice(1)};
  const prs=gh('repos/'+REPO+'/commits/'+sha+'/pulls?per_page=20');
  const identity=mergeIdentity(event,commit,prs);
  let issues=[];
  if(identity.pr){
    const refs=parsePreMergeIssueNumbers(identity.pr.body,'BestNathan','nession',identity.pr.title);
    if(refs.length>30)throw Error('too many associated Issues');
    issues=refs.map(number=>gh('repos/'+REPO+'/issues/'+number));
  }
  const plan=mergedSelection(event,commit,prs,issues,root);
  fs.mkdirSync(new URL('.',pathToFileURL(out)),{recursive:true});
  fs.writeFileSync(out,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
  console.log('Verified merged SHA '+sha+'; scoped E2E mode '+plan.mode+
    ', selected '+plan.selected.map(i=>i.id).join(','));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{main()}catch(e){console.error(e.message);process.exitCode=1;}
}
