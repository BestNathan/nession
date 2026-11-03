#!/usr/bin/env node
// Read-only ref audit. Baselines MUST come from independently governed
// secrets, never the audited orphan branches or workflow_dispatch inputs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditAnchoredRunStore} from './run-store-integrity.mjs';

export const AUDITED_STORES=Object.freeze(['acceptance-results','task-results','metrics']);
export const AGENT_STORE_AUDIT_REFS=Object.freeze(['agent-store']);
function allowedAuditRefs(refs){
  if(!Array.isArray(refs)||!([AUDITED_STORES,AGENT_STORE_AUDIT_REFS]
    .some(list=>JSON.stringify(refs)===JSON.stringify(list))))
    deny('unsupported exact store audit ref set');
  return refs;
}
const SHA=/^[0-9a-f]{40}$/;
const REPO='BestNathan/nession';
function deny(reason){throw new Error('live run-store audit: '+reason);}
function git(cwd,...args){
  try{
    return execFileSync('git',['-C',cwd,...args],{
      encoding:'utf8',timeout:60000,maxBuffer:3*1024*1024,
      stdio:['ignore','pipe','pipe'],
      env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0'},
    }).trim();
  }catch{deny('Git fetch/worktree operation failed');}
}
export function parseProtectedAnchors(raw,stores=AUDITED_STORES) {
  allowedAuditRefs(stores);
  if(typeof raw!=='string'||!raw.trim()||raw.length>2048)deny('independent anchor secret missing/oversized');
  let value;
  try{value=JSON.parse(raw);}catch{deny('invalid anchor JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).length!==stores.length ||
    stores.some(k=>!Object.hasOwn(value,k)||!SHA.test(value[k]))) {
    deny('anchor manifest requires exact store commit SHAs');
  }
  return Object.fromEntries(stores.map(k=>[k,value[k]]));
}
function trustedCheckout(root,sha) {
  if(typeof root!=='string'||!path.isAbsolute(root)||!SHA.test(sha))deny('invalid main checkout');
  if(!fs.existsSync(root)||fs.lstatSync(root).isSymbolicLink())deny('unsafe checkout');
  // `git rev-parse --show-toplevel` resolves symlinks in the path it reports.
  // Comparing that against a merely lexical `path.resolve` fails whenever an
  // *ancestor* is a symlink — on darwin `os.tmpdir()` is `/var/…` while git
  // reports the resolved `/private/var/…`, so this checker could never pass for
  // a scratch checkout and the whole run-store-integrity Gate was red locally
  // and green on Linux CI. Realpath both sides: the invariant (this root IS the
  // git top-level of this tree) is unchanged and still fails closed.
  let real;
  try{real=fs.realpathSync(root);}catch{deny('unsafe checkout');}
  if(git(root,'rev-parse','HEAD')!==sha||
     git(root,'rev-parse','--show-toplevel')!==real) {
    deny('trusted main checkout SHA/root mismatch');
  }
}
function validateRef(value,store){
  if(!value||value.ref!=='refs/heads/'+store||
     value.object?.type!=='commit'||!SHA.test(value.object.sha??'')) {
    deny('untrusted GitHub ref metadata for '+store);
  }
  return value.object.sha;
}
// GitHub Actions' Node fetch has repeatedly timed out in this runner while
// the same trusted-main job successfully used the GitHub CLI to read Rulesets.
// Use one bounded GET-only CLI transport for live refs; the canonical
// API-ref-vs-fetched-Git-SHA check below remains unchanged. The test's injected
// fetchFn continues to exercise malformed API/ref and ancestry failures.
export async function githubRefRead(url,opts,{run=execFileSync}={}){
  const match=/^https:\/\/api\.github\.com\/repos\/BestNathan\/nession\/git\/ref\/heads\/(acceptance-results|task-results|metrics|agent-store)$/.exec(url);
  const auth=/^Bearer (.{8,})$/.exec(opts?.headers?.Authorization??'');
  if(!match||opts?.method!=='GET'||opts?.redirect!=='error'||!auth||
     typeof run!=='function')
    deny('unsafe or unauthenticated GitHub ref GET');
  const store=match[1];
  let raw;
  try{
    raw=run('gh',['api','--method','GET',
      'repos/'+REPO+'/git/ref/heads/'+store],{
      encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,
      stdio:['ignore','pipe','pipe'],
      env:{...process.env,GH_TOKEN:auth[1]},
    });
  }catch{
    deny('GitHub CLI read-only ref request failed for '+store);
  }
  let data;
  try{data=JSON.parse(raw);}catch{deny('invalid GitHub ref JSON for '+store);}
  // Validation of exact ref name and commit object belongs to validateRef.
  return {ok:true,status:200,json:async()=>data};
}

export async function auditLiveRunStores({
  checkout,sourceSha,anchors,token,fetchFn=githubRefRead,gitRunner=git,
  anchorTrust='externally_supplied',baselineTrees=null,storeRefs=AUDITED_STORES,
}){
  allowedAuditRefs(storeRefs);
  trustedCheckout(checkout,sourceSha);
  if(!token||typeof token!=='string'||token.length<8||
      typeof fetchFn!=='function'||typeof gitRunner!=='function')deny('read-only API credential missing');
  if(!['externally_supplied','main_migration_observation','main_bootstrap_observation'].includes(anchorTrust))
    deny('invalid audit anchor trust boundary');
  if(anchorTrust==='main_bootstrap_observation'&&
      JSON.stringify(storeRefs)!==JSON.stringify(AGENT_STORE_AUDIT_REFS))
    deny('bootstrap observation must audit only the agent-store root');
  const trust=typeof anchors==='string'?parseProtectedAnchors(anchors,storeRefs):parseProtectedAnchors(JSON.stringify(anchors),storeRefs);
  const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28'};
  const auditDir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-store-audit-'));
  const records=[];
  try{
    for(const store of storeRefs){
      const response=await fetchFn('https://api.github.com/repos/'+REPO+
        '/git/ref/heads/'+store,{method:'GET',headers,redirect:'error'});
      if(!response.ok)deny('missing/inaccessible GitHub ref '+store+' ('+response.status+')');
      const observed=validateRef(await response.json(),store);
      // Update only a local tracking ref. No GitHub remote mutation.
      gitRunner(checkout,'fetch','--no-tags','origin',
        '+refs/heads/'+store+':refs/remotes/origin/'+store);
      const fetched=gitRunner(checkout,'rev-parse','refs/remotes/origin/'+store);
      if(fetched!==observed)deny('API and fetched Git ref disagree for '+store);
      const worktree=path.join(auditDir,store);
      gitRunner(checkout,'worktree','add','--detach',worktree,observed);
      try{
        // A repository-main migration observation records both a commit and
        // its tree. The commit SHA alone proves only the claimed object name;
        // verify exact tree identity before trusting the ancestry classifier.
        if(anchorTrust==='main_migration_observation'||anchorTrust==='main_bootstrap_observation'){
          const expectedTree=baselineTrees?.[store];
          if(typeof expectedTree!=='string'||!/^[a-f0-9]{40}$/.test(expectedTree)||
             gitRunner(worktree,'rev-parse',trust[store]+'^{tree}')!==expectedTree)
            deny('migration baseline tree identity does not match Git object for '+store);
        }
        // A bootstrap "baseline" must actually be the orphan root; a newer
        // mutable head must not be silently substituted as the first commit.
        if(anchorTrust==='main_bootstrap_observation'&&
           gitRunner(worktree,'rev-list','--parents','-n','1',trust[store])!==trust[store])
          deny('agent-store bootstrap baseline is not the orphan root');
        const result=auditAnchoredRunStore(worktree,store,trust[store],observed);
        records.push({...result,api_ref_verified:true});
      }finally{
        gitRunner(checkout,'worktree','remove','--force',worktree);
      }
    }
    return {schema_version:1,kind:'read_only_run_store_audit',repository:REPO,
      source_sha:sourceSha,passed:true,
      anchoring:anchorTrust==='externally_supplied'
        ?'separately_supplied_secret':anchorTrust==='main_bootstrap_observation'
          ?'repository_main_bootstrap_observation_only':'repository_main_migration_observation_only',
      historical_provenance_trust:anchorTrust==='externally_supplied'
        ?'caller_supplied_not_proven_WORM':'not_independent_or_retroactive',
      records};
  }finally{
    fs.rmSync(auditDir,{force:true,recursive:true});
  }
}
async function main(){
  if(process.env.GITHUB_REPOSITORY!==REPO||
     process.env.GITHUB_REF!=='refs/heads/main'||
     !SHA.test(process.env.GITHUB_SHA??'')||
     !['schedule','repository_dispatch'].includes(process.env.GITHUB_EVENT_NAME)) {
    deny('only trusted main schedule/manual workflow may audit');
  }
  const report=await auditLiveRunStores({
    checkout:process.cwd(),sourceSha:process.env.GITHUB_SHA,
    anchors:process.env.RUN_STORE_AUDIT_ANCHORS_JSON,
    token:process.env.GITHUB_TOKEN,
  });
  const summary=report.records.map(r=>({
    store:r.store,observed:r.observed,
    checked_commits:r.checked_commits,checked_changes:r.checked_changes,
  }));
  console.log(JSON.stringify({passed:true,anchoring:report.anchoring,records:summary}));
  if(process.env.GITHUB_STEP_SUMMARY){
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '### Read-only orphan Run Store audit\n\n'+
      '| Ref | Observed commit | Checked commits | Checked changes |\n'+
      '|---|---|---:|---:|\n'+summary.map(r=>
        '| '+r.store+' | '+r.observed+' | '+r.checked_commits+
        ' | '+r.checked_changes+' |').join('\n')+
      '\n\nThe separately provided baseline does not retroactively authenticate historical records.\n');
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(e=>{console.error(e.message);process.exitCode=1;});
}
