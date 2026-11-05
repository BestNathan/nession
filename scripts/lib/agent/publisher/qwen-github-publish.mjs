// #2274: only the main-owned separately credentialed Publisher may create
// a PR from a signed Qwen Developer proposal. Immutable Store Intent is
// committed BEFORE the first GitHub write. A timeout is AMBIGUOUS: no replay.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {validateQwenPublisherIntent}
  from './store-intent.mjs';
import {preflightAgentPatch,validPublisherFile}
  from './patch-preflight.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const hash=b=>createHash('sha256').update(b).digest('hex');
function reject(x){throw Error('Qwen trusted GitHub Publisher: '+x);}
function blobSha(bytes){
  return createHash('sha1').update(Buffer.concat([
    Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex');
}
function git(root,args,options={}){
  try{return execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{
    cwd:root,encoding:options.input?'buffer':'utf8',
    input:options.input,stdio:['pipe','pipe','pipe'],timeout:30000,
    maxBuffer:3*1024*1024,env:{PATH:process.env.PATH??'/usr/bin:/bin',
      HOME:options.home??root,GIT_CONFIG_NOSYSTEM:'1',
      GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',
      GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C'}
  }).toString().trimEnd();}catch{reject('disposable Git source verification failed');}
}
function verifiedSpec(preflight,intent){
  const record=validateQwenPublisherIntent(intent?.record);
  const e=preflight?.evidence;
  if(intent.status!=='committed'||intent.may_publish!==true||
      !SHA.test(intent.store_commit_sha??'')||
      e?.kind!=='trusted_qwen_publisher_preflight_only'||
      e.status!=='preflight_only'||
      e.issue!==record.issue||e.action_id!==record.action_id||
      e.worker_run_id!==record.worker_run_id||
      e.worker_run_attempt!==1||e.worker_sha!==record.worker_sha||
      e.source_sha!==record.source_sha||
      e.checkpoint_version!==record.checkpoint_version||
      e.checkpoint_commit_sha!==record.checkpoint_commit_sha||
      e.ciphertext_sha256!==record.checkpoint_ciphertext_sha256||
      e.patch_sha256!==record.patch_sha256||
      hash(JSON.stringify(e.file_manifest))!==record.file_manifest_sha256||
      e.file_manifest.length!==record.file_count||
      typeof preflight.patch!=='string'||
      hash(Buffer.from(preflight.patch))!==record.patch_sha256)
    reject('no first authenticated Qwen Store CAS publication grant');
  return record;
}
export function materializeQwenTrustedBlobs({sourceCheckout,preflight,intent}){
  const record=verifiedSpec(preflight,intent);
  if(typeof sourceCheckout!=='string'||!path.isAbsolute(sourceCheckout))
    reject('pinned source checkout required');
  // Recheck exact immutable checkout and semantic patch even at publication.
  const checked=preflightAgentPatch({checkout:sourceCheckout,
    source_sha:record.source_sha,patch:preflight.patch,
    allowed_paths:preflight.evidence.file_manifest.map(x=>x.path)});
  if(checked.patch_sha256!==record.patch_sha256||
      JSON.stringify(checked.files)!==
        JSON.stringify(preflight.evidence.file_manifest))
    reject('source changed after authenticated Publisher preflight');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-pr-blobs-'));
  const clone=path.join(temp,'source');
  try{
    const home=path.join(temp,'git-home');
    fs.mkdirSync(home);
    git(temp,['clone','--quiet','--no-hardlinks','--no-checkout',
      '--template='+home,'--',sourceCheckout,clone],{home});
    git(clone,['checkout','--quiet','--detach',record.source_sha],{home});
    git(clone,['remote','remove','origin'],{home});
    git(clone,['apply','--check','--index','--whitespace=error','-'],
      {home,input:preflight.patch});
    git(clone,['apply','--index','--whitespace=error','-'],
      {home,input:preflight.patch});
    const changes=git(clone,['diff','--cached','--name-only','--no-renames'],{home})
      .split('\n').filter(Boolean).sort();
    const expected=checked.files.map(x=>x.path).sort();
    if(JSON.stringify(changes)!==JSON.stringify(expected))
      reject('applied Git tree includes an unauthorized file');
    const blobs=checked.files.map(row=>{
      const file=validPublisherFile(row.path);
      const mode=git(clone,['ls-files','--stage','--',file],{home});
      if(!/^100644 [a-f0-9]{40} 0\t/.test(mode))
        reject('Qwen publication requires regular non-executable Git blobs');
      const full=path.join(clone,file);
      const stat=fs.lstatSync(full);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)
        reject('unsafe Qwen file content');
      const bytes=fs.readFileSync(full);
      if(hash(bytes)!==row.new_sha256||bytes.length!==row.new_bytes)
        reject('published bytes differ from signed patch preflight');
      return {path:file,content_base64:bytes.toString('base64'),
        git_blob_sha:blobSha(bytes),sha256:row.new_sha256};
    });
    return Object.freeze(blobs);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
function expect(value,wanted,field){
  if(value!==wanted)reject('independent GitHub '+field+' mismatch');
}
async function get(api,endpoint){
  const d=await api('GET',endpoint);
  if(!d||typeof d!=='object'||Array.isArray(d))
    reject('invalid read-only GitHub evidence for '+endpoint);
  return d;
}
async function absent(api,path){
  try{await get(api,path);}
  catch(e){if(e?.status===404)return;throw e;}
  reject('existing Qwen PR branch; manual reconciliation required');
}
// This is a network-facing one-shot action. The caller must NOT retry POST
// after ANY failure/timeout; an immutable intent already fences subsequent jobs.
export async function publishTrustedQwenGitHubPR({
  preflight,intent,sourceCheckout,api,
}){
  if(typeof api!=='function')reject('separate GitHub PR App token unavailable');
  const record=verifiedSpec(preflight,intent);
  const blobs=materializeQwenTrustedBlobs({sourceCheckout,preflight,intent});
  const main=await get(api,'git/ref/heads/main');
  expect(main.ref,'refs/heads/main','target branch');
  expect(main.object?.sha,record.target_main_sha,'stale exact main HEAD');
  const existing=await api('GET','pulls?state=all&head=BestNathan:'+
    encodeURIComponent(record.branch)+'&per_page=100');
  if(!Array.isArray(existing)||existing.length)
    reject('Qwen Action PR already exists or listing incomplete');
  await absent(api,'git/ref/heads/'+record.branch);
  const base=await get(api,'git/commits/'+record.target_main_sha);
  if(!SHA.test(base.tree?.sha??''))
    reject('trusted main tree SHA missing');
  const treeFiles=[];
  for(const blob of blobs){
    const written=await api('POST','git/blobs',{
      content:blob.content_base64,encoding:'base64'});
    expect(written?.sha,blob.git_blob_sha,'written file blob');
    treeFiles.push({path:blob.path,mode:'100644',type:'blob',sha:written.sha});
  }
  const newTree=await api('POST','git/trees',{
    base_tree:base.tree.sha,tree:treeFiles});
  if(!SHA.test(newTree?.sha??''))reject('GitHub tree write failed');
  const newCommit=await api('POST','git/commits',{
    message:'feat(agent): authenticated Qwen Developer Issue #'+record.issue,
    tree:newTree.sha,parents:[record.target_main_sha]});
  if(!SHA.test(newCommit?.sha??'')||newCommit.tree?.sha!==newTree.sha)
    reject('GitHub commit not built from authenticated Qwen patch');
  const ref=await api('POST','git/refs',{
    ref:'refs/heads/'+record.branch,sha:newCommit.sha});
  expect(ref?.ref,'refs/heads/'+record.branch,'new Qwen ref');
  expect(ref.object?.sha,newCommit.sha,'new Qwen commit');
  const afterRef=await get(api,'git/ref/heads/'+record.branch);
  expect(afterRef.object?.sha,newCommit.sha,'committed Qwen branch');
  const pr=await api('POST','pulls',{
    title:'feat(agent): Qwen Developer proposal for #'+record.issue,
    body:'Refs #'+record.issue+'.\n\nAuthenticated Developer Run '+
      record.worker_run_id+'/1; committed native checkpoint '+
      record.checkpoint_commit_sha+'; patch SHA256 '+record.patch_sha256+
      '.\n\nAwait independent Reviewer and Acceptance; no automatic merge.',
    head:record.branch,base:'main',draft:false});
  if(!Number.isSafeInteger(pr?.number)||pr.number<1)
    reject('GitHub PR creation has no verified ID');
  const observed=await get(api,'pulls/'+pr.number);
  expect(observed.number,pr.number,'PR number');
  expect(observed.head?.sha,newCommit.sha,'PR HEAD');
  expect(observed.head?.ref,record.branch,'PR branch');
  expect(observed.head?.repo?.full_name,REPO,'PR repository');
  expect(observed.base?.ref,'main','PR target');
  expect(observed.state,'open','PR state');
  const files=await api('GET','pulls/'+pr.number+'/files?per_page=100');
  if(!Array.isArray(files)||files.length!==blobs.length||
      files.some(f=>!blobs.some(b=>
        b.path===f.filename&&f.status==='modified'&&
        f.sha===b.git_blob_sha))||
      new Set(files.map(f=>f.filename)).size!==blobs.length)
    reject('PR readback differs from signed edited source files');
  return Object.freeze({schema_version:1,
    kind:'authenticated_qwen_publisher_pr_receipt',
    status:'published_verified_by_github',
    issue:record.issue,action_id:record.action_id,
    source_run_id:record.worker_run_id,source_run_attempt:1,
    publisher_run_id:record.publisher_run_id,
    publication_intent_store_sha:intent.store_commit_sha,
    checkpoint_commit_sha:record.checkpoint_commit_sha,
    target_main_sha:record.target_main_sha,
    patch_sha256:record.patch_sha256,branch:record.branch,
    pull_request:pr.number,head_sha:newCommit.sha,
    files:blobs.map(b=>({path:b.path,sha256:b.sha256,blob_sha:b.git_blob_sha}))});
}
