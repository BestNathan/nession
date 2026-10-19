#!/usr/bin/env node
// #1690: publish one validated run-store commit with remote-head CAS semantics.
// No force push, no orphan initialization, no silent immutable-key overwrite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateRunStoreChange} from './run-store-integrity.mjs';

const HEX40=/^[0-9a-f]{40}$/;
const STORE_REF=/^(acceptance-results|task-results|metrics|agent-store)$/;
function fail(reason){throw new Error('run-store-cas-push: '+reason);}
function git(root,args,options={}){
  try {return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,
    timeout:45000,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',...options.env},
  }).trim();}catch(e){
    if(options.allowFailure)return null;
    // Do not surface stderr: an authenticated origin URL may contain credentials.
    fail('git '+args[0]+' failed ('+(e.status??'unknown')+')');
  }
}
function treeEntry(root,commit,filename){
  const line=git(root,['ls-tree',commit,'--',filename]);
  if(!line)return null;
  const matched=/^(100644) blob ([a-f0-9]{40})\t([^\r\n]+)$/.exec(line);
  if(!matched||matched[3]!==filename)fail('non-regular/ambiguous Git tree entry: '+filename);
  return matched[2];
}
function delta(root,base,head,store){
  const bytes=execFileSync('git',['-C',root,'diff','--name-status','--no-renames','-z',base,head],{
    encoding:'buffer',maxBuffer:8*1024*1024,timeout:30000,stdio:['ignore','pipe','pipe'],
    env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1'},
  });
  if(bytes.length===0)fail('candidate has no recorded changes');
  if(bytes[bytes.length-1]!==0)fail('truncated Git diff');
  const fields=bytes.subarray(0,-1).toString('utf8').split('\0');
  if(fields.length%2)fail('invalid Git change record');
  const result=[],seen=new Set();
  for(let i=0;i<fields.length;i+=2){
    const [status,filename]=[fields[i],fields[i+1]];
    validateRunStoreChange(store,status,filename);
    if(seen.has(filename))fail('duplicate file path');
    seen.add(filename);
    const next=treeEntry(root,head,filename);
    if(!next)fail('candidate missing blob: '+filename);
    const previous=treeEntry(root,base,filename);
    if(status==='A'&&previous!==null)fail('addition already in candidate base');
    if(status==='M'&&previous===null)fail('modification absent from candidate base');
    result.push({status,path:filename,before:previous,after:next});
  }
  return result;
}
function remoteHead(root,ref){
  const raw=git(root,['ls-remote','--heads','origin','refs/heads/'+ref]);
  const match=new RegExp('^([a-f0-9]{40})\\trefs/heads/'+ref+'$').exec(raw);
  if(!match)fail('remote ref missing or ambiguous; refuse orphan initialization');
  return match[1];
}
function requireLinearAdvance(root,base,remote,ref){
  git(root,['fetch','--no-tags','--depth=96','origin','refs/heads/'+ref]);
  const observed=git(root,['rev-parse','FETCH_HEAD']);
  if(observed!==remote)fail('remote head moved while fetching; retry externally');
  if(base===remote)return;
  if(git(root,['merge-base','--is-ancestor',base,remote],{allowFailure:true})!==null)return;
  // Shallow fetches may omit the parent base; deepen once, then fail closed.
  git(root,['fetch','--no-tags','--deepen=1024','origin','refs/heads/'+ref]);
  if(git(root,['merge-base','--is-ancestor',base,remote],{allowFailure:true})===null)
    fail('remote is not a verified descendant of candidate base; refuse replacement');
}
function makeCommit(root,remote,changes,message){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'run-store-cas-'));
  const index=path.join(directory,'index');
  const env={GIT_INDEX_FILE:index};
  try{
    git(root,['read-tree',remote],{env});
    for(const change of changes)
      git(root,['update-index','--add','--cacheinfo','100644,'+change.after+','+change.path],{env});
    const tree=git(root,['write-tree'],{env});
    const oldTree=git(root,['rev-parse',remote+'^{tree}']);
    if(tree===oldTree)return null;
    // Commit-tree bypasses git commit's configured author identity. A clean
    // GHA checkout may have no user.name/email when concurrent Store writers
    // require a linear CAS rebase. Use fixed automation identity rather than
    // inherited host Git config or a Worker-controlled author.
    const writerIdentity={
      GIT_AUTHOR_NAME:'nession-store-writer',
      GIT_AUTHOR_EMAIL:'nession-store-writer@users.noreply.github.com',
      GIT_COMMITTER_NAME:'nession-store-writer',
      GIT_COMMITTER_EMAIL:'nession-store-writer@users.noreply.github.com',
    };
    const commit=git(root,['commit-tree',tree,'-p',remote,'-m',message],
      {env:writerIdentity});
    if(!HEX40.test(commit))fail('invalid generated commit');
    return commit;
  }finally{fs.rmSync(directory,{force:true,recursive:true});}
}
function receipt(root,store,head,changed,replayed){
  const dest=process.env.RUN_STORE_RECEIPT_DIR ||
    (process.env.RUNNER_TEMP?path.join(process.env.RUNNER_TEMP,'run-store-receipts'):null);
  if(!dest)return;
  if(!path.isAbsolute(dest))fail('receipt directory must be absolute');
  const safe=v=>String(v??'').slice(0,200);
  const hashes=changed.map(x=>({
    path:x.path,sha256:crypto.createHash('sha256').update(
      execFileSync('git',['-C',root,'cat-file','blob',x.after],{maxBuffer:8*1024*1024})).digest('hex'),
  }));
  let event={};
  if(process.env.GITHUB_EVENT_PATH){
    try{event=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));}
    catch{fail('cannot read trusted GitHub source event for receipt');}
  }
  const src=event.workflow_run??null;
  const workspace=process.env.GITHUB_WORKSPACE;
  const trusted=workspace&&fs.existsSync(path.join(workspace,'trusted','.git'))
    ?path.join(workspace,'trusted'):workspace;
  const toolSha=trusted&&fs.existsSync(path.join(trusted,'.git'))
    ?git(trusted,['rev-parse','HEAD']):process.env.GITHUB_SHA;
  if(!HEX40.test(toolSha??''))fail('unverifiable trusted tool SHA in receipt');
  const body={schema_version:1,kind:'run_store_post_commit_receipt',
    trust_level:'trusted_workflow_artifact_not_independent_anchor',
    status:replayed?'idempotent-replay':'published',ref:'refs/heads/'+store,
    store,commit_sha:head,
    ingester:{repository:safe(process.env.GITHUB_REPOSITORY),
      run_id:safe(process.env.GITHUB_RUN_ID),attempt:safe(process.env.GITHUB_RUN_ATTEMPT),
      workflow_ref:safe(process.env.GITHUB_WORKFLOW_REF),tool_sha:toolSha},
    source:{workflow_id:safe(src?.workflow_id),workflow_path:safe(src?.path),
      repository:safe(src?.head_repository?.full_name??process.env.GITHUB_REPOSITORY),
      run_id:safe(src?.id??process.env.GITHUB_RUN_ID),
      attempt:safe(src?.run_attempt??process.env.GITHUB_RUN_ATTEMPT),
      target_sha:safe(src?.head_sha??process.env.GITHUB_SHA),
      event:safe(src?.event??process.env.GITHUB_EVENT_NAME)},
    records:hashes,
  };
  fs.mkdirSync(dest,{recursive:true});
  fs.writeFileSync(path.join(dest,store+'-'+Date.now()+'-'+process.pid+'.json'),
    JSON.stringify(body,null,2)+'\n',{flag:'wx',mode:0o600});
}
export function publish(store,root,maxAttempts=4){
  if(!STORE_REF.test(store)||!fs.statSync(root).isDirectory())fail('invalid store or checkout');
  if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>8)fail('invalid retry limit');
  if(git(root,['status','--porcelain']))fail('uncommitted changes; refuse publish');
  const head=git(root,['rev-parse','HEAD']);
  const base=git(root,['rev-parse','HEAD^'],{allowFailure:true});
  if(!HEX40.test(head)||!HEX40.test(base??''))fail('single-parent candidate required; no new orphan root');
  if(git(root,['show','-s','--format=%P',head])!==base)fail('candidate must have one parent');
  const changed=delta(root,base,head,store);
  const message=git(root,['log','-1','--format=%B']);
  for(let attempt=0;attempt<maxAttempts;attempt++){
    const remote=remoteHead(root,store);
    requireLinearAdvance(root,base,remote,store);
    const pending=[];
    for(const entry of changed){
      const current=treeEntry(root,remote,entry.path);
      if(current===entry.after)continue;
      if(current!==entry.before)fail('divergent record, index or projection collision: '+entry.path);
      pending.push(entry);
    }
    if(!pending.length){
      if(remoteHead(root,store)!==remote)continue;
      git(root,['reset','--hard',remote]);
      receipt(root,store,remote,changed,true);
      return {commit_sha:remote,replayed:true,attempt:attempt+1};
    }
    const proposed=remote===base?head:makeCommit(root,remote,pending,message);
    if(!proposed)fail('nonempty candidate delta collapsed unexpectedly');
    // Non-fast-forward rejection happens server-side; no force flag or ref reset.
    if(git(root,['push','origin',proposed+':refs/heads/'+store],{allowFailure:true})===null){
      if(attempt+1===maxAttempts)fail('bounded CAS retry exhausted');
      continue;
    }
    if(remoteHead(root,store)!==proposed)fail('post-push remote SHA verification failed');
    git(root,['reset','--hard',proposed]);
    receipt(root,store,proposed,changed,false);
    return {commit_sha:proposed,replayed:false,attempt:attempt+1};
  }
  fail('bounded CAS retry exhausted');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{
    const [store,root]=process.argv.slice(2);
    if(!store||!root||!path.isAbsolute(root))fail('usage: STORE ABSOLUTE_GIT_DIR');
    console.log(JSON.stringify(publish(store,root)));
  }catch(e){console.error('::error::'+String(e.message));process.exitCode=1;}
}
