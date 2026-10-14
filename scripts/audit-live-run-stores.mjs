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
export function parseProtectedAnchors(raw) {
  if(typeof raw!=='string'||!raw.trim()||raw.length>2048)deny('independent anchor secret missing/oversized');
  let value;
  try{value=JSON.parse(raw);}catch{deny('invalid anchor JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).length!==AUDITED_STORES.length ||
    AUDITED_STORES.some(k=>!Object.hasOwn(value,k)||!SHA.test(value[k]))) {
    deny('anchor manifest requires exact store commit SHAs');
  }
  return Object.fromEntries(AUDITED_STORES.map(k=>[k,value[k]]));
}
function trustedCheckout(root,sha) {
  if(typeof root!=='string'||!path.isAbsolute(root)||!SHA.test(sha))deny('invalid main checkout');
  if(!fs.existsSync(root)||fs.lstatSync(root).isSymbolicLink())deny('unsafe checkout');
  if(git(root,'rev-parse','HEAD')!==sha||
     git(root,'rev-parse','--show-toplevel')!==path.resolve(root)) {
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
export async function auditLiveRunStores({
  checkout,sourceSha,anchors,token,fetchFn=fetch,gitRunner=git,
}){
  trustedCheckout(checkout,sourceSha);
  if(!token||typeof token!=='string'||token.length<8||
      typeof fetchFn!=='function'||typeof gitRunner!=='function')deny('read-only API credential missing');
  const trust=typeof anchors==='string'?parseProtectedAnchors(anchors):parseProtectedAnchors(JSON.stringify(anchors));
  const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28'};
  const auditDir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-store-audit-'));
  const records=[];
  try{
    for(const store of AUDITED_STORES){
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
        const result=auditAnchoredRunStore(worktree,store,trust[store],observed);
        records.push({...result,api_ref_verified:true});
      }finally{
        gitRunner(checkout,'worktree','remove','--force',worktree);
      }
    }
    return {schema_version:1,kind:'read_only_run_store_audit',repository:REPO,
      source_sha:sourceSha,passed:true,anchoring:'separately_supplied_secret',records};
  }finally{
    fs.rmSync(auditDir,{force:true,recursive:true});
  }
}
async function main(){
  if(process.env.GITHUB_REPOSITORY!==REPO||
     process.env.GITHUB_REF!=='refs/heads/main'||
     !SHA.test(process.env.GITHUB_SHA??'')||
     !['schedule','workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)) {
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
