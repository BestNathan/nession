// #2137: one-shot non-force UPDATE of the ORIGINAL authenticated Qwen PR.
// This is a separate, credentialed Publisher operation, never model code.
// All GitHub writes require a previously committed immutable Store Intent.
// On any ambiguous POST/PATCH failure, the ONLY recovery is GET readback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {preflightAgentPatch,validPublisherFile} from './patch-preflight.mjs';
import {validateQwenRepairPublisherIntent}
  from './qwen-repair-intent.mjs';

const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/;
const hash=data=>createHash('sha256').update(data).digest('hex');
const blobSha=b=>createHash('sha1').update(Buffer.concat([
  Buffer.from('blob '+b.length+'\0'),b])).digest('hex');
function fail(s){throw Error('Qwen Repair PR update: '+s);}
function git(root,args,{input,home=root}={}){
  try{return execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{
    cwd:root,encoding:'utf8',input,timeout:30000,
    maxBuffer:3*1024*1024,stdio:['pipe','pipe','pipe'],
    env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home,
      GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
      GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',
      GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C'}}).trimEnd();}
  catch{fail('isolated Git '+args[0]+' failed');}
}
function plan(preflight,intent,{write=false}={}){
  const x=validateQwenRepairPublisherIntent(intent?.record);
  const e=preflight?.evidence;
  if(!SHA.test(intent?.store_commit_sha??'')||
      (write?(intent.status!=='committed'||intent.may_publish!==true):
        !['committed','reconcile'].includes(intent.status))||
      e?.schema_version!==1||e.kind!=='trusted_qwen_repair_preflight_only'||
      e.status!=='preflight_only'||e.issue!==x.issue||
      e.action_id!==x.action_id||e.developer_run_id!==x.worker_run_id||
      e.worker_sha!==x.worker_sha||e.source_sha!==x.source_sha||
      e.original_main_sha!==x.original_main_sha||
      e.original_publisher_run_id!==x.original_publisher_run_id||
      e.original_pr_branch!==x.branch||
      e.checkpoint_version!==x.checkpoint_version||
      e.checkpoint_commit_sha!==x.checkpoint_commit_sha||
      e.ciphertext_sha256!==x.checkpoint_ciphertext_sha256||
      e.patch_sha256!==x.patch_sha256||
      !Array.isArray(e.file_manifest)||
      e.file_manifest.length!==x.file_count||
      hash(JSON.stringify(e.file_manifest))!==x.file_manifest_sha256||
      typeof preflight.patch!=='string'||
      hash(Buffer.from(preflight.patch))!==x.patch_sha256)
    fail('missing exact immutable Store-fenced Repair grant or manifest');
  return x;
}
export function materializeQwenRepairGitTree({preflight,intent,sourceCheckout}){
  const record=plan(preflight,intent);
  if(typeof sourceCheckout!=='string'||!path.isAbsolute(sourceCheckout))
    fail('exact checked-out PR SHA A is required');
  const checked=preflightAgentPatch({checkout:sourceCheckout,
    source_sha:record.source_sha,patch:preflight.patch,
    allowed_paths:preflight.evidence.file_manifest.map(x=>x.path)});
  if(checked.patch_sha256!==record.patch_sha256||
      JSON.stringify(checked.files)!==
        JSON.stringify(preflight.evidence.file_manifest))
    fail('repair patch no longer matches signed PR-A byte manifest');
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-repair-pr-'));
  try{
    const home=path.join(tmp,'git-home'),clone=path.join(tmp,'repo');
    fs.mkdirSync(home);
    git(tmp,['clone','--quiet','--no-hardlinks','--no-checkout',
      '--template='+home,'--',sourceCheckout,clone],{home});
    git(clone,['checkout','--quiet','--detach',record.source_sha],{home});
    git(clone,['remote','remove','origin'],{home});
    git(clone,['apply','--check','--index','--whitespace=error','-'],
      {input:preflight.patch,home});
    git(clone,['apply','--index','--whitespace=error','-'],
      {input:preflight.patch,home});
    const names=git(clone,['diff','--cached','--name-only','--no-renames'],
      {home}).split('\n').filter(Boolean).sort();
    if(JSON.stringify(names)!==
        JSON.stringify(checked.files.map(x=>x.path).sort()))
      fail('repair generated unauthorized Git file modifications');
    const blobs=checked.files.map(x=>{
      const relative=validPublisherFile(x.path);
      const index=git(clone,['ls-files','--stage','--',relative],{home});
      if(!/^100644 [a-f0-9]{40} 0\t/.test(index))
        fail('nonregular Git blob or unsafe file mode in Repair');
      const file=path.join(clone,relative),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)
        fail('unsafe materialized Repair file');
      const b=fs.readFileSync(file);
      if(b.length!==x.new_bytes||hash(b)!==x.new_sha256)
        fail('materialized Repair bytes differ from original signed patch');
      return {path:relative,sha256:x.new_sha256,
        git_blob_sha:blobSha(b),content_base64:b.toString('base64')};
    });
    const expectedTreeSha=git(clone,['write-tree'],{home});
    if(!SHA.test(expectedTreeSha))fail('failed to calculate exact PR-B tree');
    return Object.freeze({blobs,expected_tree_sha:expectedTreeSha});
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
async function get(api,endpoint){
  const v=await api('GET',endpoint);
  if(v==null)fail('incomplete independently retrieved GitHub source');
  return v;
}
function matchPR(pr,record,expectedSha){
  if(pr?.state!=='open'||!Number.isSafeInteger(pr.number)||pr.number<1||
      pr.head?.ref!==record.branch.slice('refs/heads/'.length)||
      pr.head?.repo?.full_name!==REPO||
      pr.head.sha!==expectedSha||
      pr.base?.ref!=='main'||pr.base.repo?.full_name!==REPO||
      pr.user?.login!=='nession-publisher[bot]')
    fail('original GitHub PR/ref identity or head differs from signed Repair');
}
async function uniqueOriginalPR(api,record,expectedSha){
  const short=record.branch.slice('refs/heads/'.length);
  const list=await get(api,'pulls?state=all&head=BestNathan:'+
    encodeURIComponent(short)+'&per_page=100');
  if(!Array.isArray(list)||list.length!==1)
    fail('missing or ambiguous existing Qwen PR branch; never create another');
  const pr=await get(api,'pulls/'+list[0].number);
  matchPR(pr,record,expectedSha);
  const ref=await get(api,'git/ref/heads/'+short);
  if(ref.ref!==record.branch||ref.object?.sha!==expectedSha)
    fail('existing original PR ref was moved or rewritten');
  return pr;
}
async function prFiles(api,number,limit=8){
  const files=await get(api,'pulls/'+number+'/files?per_page=100');
  if(!Array.isArray(files)||files.length<1||files.length>limit||
      new Set(files.map(x=>x.filename)).size!==files.length||
      files.some(f=>!SHA.test(f.sha??'')||f.status!=='modified'||
        typeof f.filename!=='string'))
    fail('existing PR scope cannot be independently verified');
  for(const x of files)validPublisherFile(x.filename);
  return files;
}
function attestCurrentPRFiles(files,blobs){
  for(const blob of blobs){
    if(!files.some(f=>f.filename===blob.path&&
        f.sha===blob.git_blob_sha))
      fail('GitHub PR-B content differs from signed Repair patch');
  }
}
function receipt(record,intent,pr,tree,blobs){
  return Object.freeze({
    schema_version:1,kind:'authenticated_qwen_repair_pr_receipt',
    status:'same_pr_nonforce_update_readback_verified',
    issue:record.issue,action_id:record.action_id,
    worker_run_id:record.worker_run_id,worker_sha:record.worker_sha,
    publisher_run_id:record.publisher_run_id,
    intent_store_sha:intent.store_commit_sha,
    original_publisher_run_id:record.original_publisher_run_id,
    original_main_sha:record.original_main_sha,
    previous_sha:record.source_sha,
    head_sha:pr.head.sha,branch:record.branch,
    pull_request:pr.number,expected_tree_sha:tree,
    patch_sha256:record.patch_sha256,
    checkpoint_commit_sha:record.checkpoint_commit_sha,
    files:blobs.map(b=>({path:b.path,sha256:b.sha256,
      blob_sha:b.git_blob_sha})),
  });
}
// This function is GET-ONLY, including after any error or replay. No call
// back into 'publish' is ever allowed for a previously persisted intent.
export async function readBackQwenRepairPR({
  preflight,intent,sourceCheckout,api,
}){
  if(typeof api!=='function')fail('GET-only PR reader required');
  const record=plan(preflight,intent);
  const {blobs,expected_tree_sha}=materializeQwenRepairGitTree({
    preflight,intent,sourceCheckout});
  const short=record.branch.slice('refs/heads/'.length);
  const list=await get(api,'pulls?state=all&head=BestNathan:'+
    encodeURIComponent(short)+'&per_page=100');
  if(!Array.isArray(list)||list.length!==1)
    fail('missing unique original PR after potentially ambiguous write');
  const pr=await get(api,'pulls/'+list[0].number);
  if(!SHA.test(pr?.head?.sha??'')||pr.head.sha===record.source_sha)
    fail('original PR still at A or unavailable; do not retry any POST/PATCH');
  matchPR(pr,record,pr.head.sha);
  const branch=await get(api,'git/ref/heads/'+short);
  if(branch.ref!==record.branch||branch.object?.sha!==pr.head.sha)
    fail('PR/ref SHA mismatch after Qwen Repair');
  const commit=await get(api,'git/commits/'+pr.head.sha);
  if(!Array.isArray(commit.parents)||commit.parents.length!==1||
      commit.parents[0].sha!==record.source_sha||
      commit.tree?.sha!==expected_tree_sha)
    fail('PR-B is not exactly the signed non-force repair atop PR-A');
  const files=await prFiles(api,pr.number);
  attestCurrentPRFiles(files,blobs);
  return receipt(record,intent,pr,expected_tree_sha,blobs);
}
// This function may perform GitHub mutations ONCE, after Store CAS grants
// may_publish=true. Every network error is ambiguous; do not retry it.
export async function publishQwenRepairToSamePR({
  preflight,intent,sourceCheckout,api,
}){
  if(typeof api!=='function')fail('separate Publisher App writer required');
  const record=plan(preflight,intent,{write:true});
  const {blobs,expected_tree_sha}=materializeQwenRepairGitTree({
    preflight,intent,sourceCheckout});
  const pr=await uniqueOriginalPR(api,record,record.source_sha);
  const oldFiles=await prFiles(api,pr.number);
  if(blobs.some(b=>!oldFiles.some(f=>f.filename===b.path)))
    fail('Repair cannot add a new PR file outside original published scope');
  const current=await get(api,'git/commits/'+record.source_sha);
  // The current Slice proves its ORIGINAL PR-A parent, not a random
  // branch or a model-selected base. Additional rounds require independently
  // authenticated chained PR snapshots, not relaxing this check.
  if(!Array.isArray(current.parents)||current.parents.length!==1||
      current.parents[0].sha!==record.original_main_sha||
      !SHA.test(current.tree?.sha??''))
    fail('original Qwen PR-A commit parent or tree was rewritten');
  const tree=[];
  for(const blob of blobs){
    const created=await api('POST','git/blobs',{
      content:blob.content_base64,encoding:'base64'});
    if(created?.sha!==blob.git_blob_sha)
      fail('GitHub Repair blob differs from signed bytes');
    tree.push({path:blob.path,mode:'100644',type:'blob',sha:created.sha});
  }
  const newTree=await api('POST','git/trees',{
    base_tree:current.tree.sha,tree});
  if(newTree?.sha!==expected_tree_sha)
    fail('GitHub Repair tree differs from exact local source patch');
  const commit=await api('POST','git/commits',{
    message:'fix(agent): authenticated Qwen Repair for Issue #'+record.issue,
    tree:newTree.sha,parents:[record.source_sha]});
  if(!SHA.test(commit?.sha??'')||commit?.tree?.sha!==newTree.sha)
    fail('GitHub Repair commit differs from signed tree');
  const updated=await api('PATCH','git/refs/heads/'+
    record.branch.slice('refs/heads/'.length),
    {sha:commit.sha,force:false});
  if(updated?.ref!==record.branch||updated.object?.sha!==commit.sha)
    fail('non-force GitHub ref update response is ambiguous');
  const readback=await readBackQwenRepairPR({
    preflight,intent,sourceCheckout,api});
  if(readback.head_sha!==commit.sha||readback.pull_request!==pr.number)
    fail('non-force ref update does not match independently read original PR');
  return readback;
}
