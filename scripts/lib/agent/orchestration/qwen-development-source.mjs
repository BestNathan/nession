// #2274: bounded, verified source/edit result for a Store-admitted Qwen
// Developer task. This module neither authenticates the GitHub Run nor writes
// GitHub/Store/Publisher state. Worker preflight owns signed Run/Outbox admission;
// the trusted Publisher must still independently inspect the proposed patch.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {bindQwenDeveloper} from './qwen-developer-policy.mjs';
import {toolUseNames} from '../providers/claude-stream.mjs';

const SHA=/^[a-f0-9]{40}$/;
const FILE=/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;
// A 32 KiB binary patch stays under the canonical 64 KiB result.json ZIP
// member budget after base64 encoding and provenance metadata.
const MAX_PATCH=32*1024;
const MAX_SOURCE_FILE=1024*1024;
function fail(s){throw Error('Qwen Developer source: '+s);}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function git(root,...args){
  try{
    return execFileSync('git',['-C',root,...args],{
      encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000,
      maxBuffer:2*1024*1024,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',
        GIT_EXTERNAL_DIFF:'',GIT_CONFIG_NOSYSTEM:'1'},
    });
  }catch{fail('exact Git source or bounded patch check failed');}
}
function approvedPaths(paths){
  if(!Array.isArray(paths)||paths.length<1||paths.length>8||
      paths.some(v=>typeof v!=='string'||v.length>240||!FILE.test(v)||
        v.split('/').some(x=>x==='.'||x==='..')||
        v.split('/').some(x=>['.git','.claude','.github','node_modules'].includes(x)))||
      new Set(paths).size!==paths.length)
    fail('missing or unsafe trusted edit allowlist');
  return Object.freeze([...paths].sort());
}
function ordinaryFile(root,relative){
  let target=root;
  const pieces=relative.split('/');
  for(let i=0;i<pieces.length;i++){
    target=path.join(target,pieces[i]);
    let stat;
    try{stat=fs.lstatSync(target);}catch{fail('missing allowlisted source path');}
    if(stat.isSymbolicLink()||(i===pieces.length-1?
      (!stat.isFile()||stat.size>MAX_SOURCE_FILE):
      !stat.isDirectory()))
      fail('symlink, unsafe type or unbounded source file');
  }
  return target;
}
// Git status deliberately hides ignored paths. Isolated model work must not
// manufacture unreviewed files under ignored build/cache directories either.
function ignoredArtifacts(root){
  return git(root,'ls-files','--others','--ignored','--exclude-standard','-z');
}
function verifyCheckout(root,sourceSha,files){
  if(!SHA.test(sourceSha??'')||typeof root!=='string'||!path.isAbsolute(root))
    fail('exact source SHA and absolute workspace are required');
  let real;
  try{real=fs.realpathSync(root);}catch{fail('source workspace unavailable');}
  // macOS temp paths may have a system-owned symlink ancestor (/var ->
  // /private/var). Reject a symlink at the workspace root itself, but
  // consistently operate on the physical Git root after realpath resolution.
  if(fs.lstatSync(root).isSymbolicLink()||!fs.lstatSync(real).isDirectory())
    fail('source workspace must have a stable non-symlink root');
  if(git(real,'rev-parse','--show-toplevel').trim()!==real||
      git(real,'rev-parse','HEAD').trim()!==sourceSha||
      git(real,'status','--porcelain=v1','-z','--untracked-files=all').length!==0||
      ignoredArtifacts(real).length!==0)
    fail('source checkout is not the clean signed commit');
  for(const rel of files){
    ordinaryFile(real,rel);
    git(real,'ls-files','--error-unmatch','--',rel);
  }
  return real;
}
// The edit allowlist comes from a trusted, provider-neutral Task owner,
// NEVER from the Issue body, prompt, model response or worker artifact.
export function prepareQwenDevelopmentSource({
  admission,registry,environment,cliVersion,workspace,allowedFiles,
}){
  const plan=bindQwenDeveloper(admission,registry,environment,{cliVersion});
  const files=approvedPaths(allowedFiles);
  const root=verifyCheckout(workspace,plan.source_sha,files);
  const origin=Object.freeze({issue:admission.issue,action_id:admission.action_id,
    run_id:admission.run_id,task:admission.task});
  return Object.freeze({plan,origin,workspace:root,allowed_files:files});
}
function expectedWorkspace(snapshot){
  if(!snapshot||!SHA.test(snapshot.plan?.source_sha??'')||
      typeof snapshot.workspace!=='string'||
      !path.isAbsolute(snapshot.workspace)||
      !Array.isArray(snapshot.allowed_files))
    fail('missing verified source snapshot');
  const files=approvedPaths(snapshot.allowed_files);
  let root;
  try{root=fs.realpathSync(snapshot.workspace);}catch{fail('missing source workspace');}
  if(root!==snapshot.workspace||
      git(root,'rev-parse','--show-toplevel').trim()!==root||
      git(root,'rev-parse','HEAD').trim()!==snapshot.plan.source_sha)
    fail('workspace/source changed after admission');
  return {root,files};
}
// An observed model success is never accepted without an independently
// checked real Git diff. No untracked files, index writes, renames, deletes,
// symlinks, submodules or modifications outside the trusted allowlist.
function checkedGitPatch(snapshot){
  const {root,files}=expectedWorkspace(snapshot);
  if(ignoredArtifacts(root).length)
    fail('model created or retained ignored workspace artifacts');
  const status=git(root,'status','--porcelain=v1','-z','--untracked-files=all');
  const rows=status.split('\0').filter(Boolean);
  if(!rows.length||rows.length>files.length)fail('missing or unbounded source edits');
  const changed=new Set();
  for(const row of rows){
    if(!row.startsWith(' M ')||row.length<4)
      fail('untracked, index, rename or delete change prohibited');
    const name=row.slice(3);
    if(!files.includes(name)||changed.has(name))
      fail('edit outside approved source paths');
    ordinaryFile(root,name);
    changed.add(name);
  }
  // Verify that the index is still the originally admitted source. The
  // Publisher must re-check the patch/target, not trust this worker receipt.
  if(git(root,'diff','--cached','--name-only','-z').length)
    fail('model modified the Git index');
  const diffPaths=git(root,'-c','core.quotePath=false',
    'diff','--name-only','-z','--no-ext-diff','--',...files)
    .split('\0').filter(Boolean).sort();
  if(diffPaths.length!==changed.size||diffPaths.some(p=>!changed.has(p)))
    fail('observed Git diff does not match approved changed paths');
  const patch=git(root,'-c','core.quotePath=false','diff',
    '--binary','--no-ext-diff','--',...files);
  if(!patch.length||Buffer.byteLength(patch)>MAX_PATCH)
    fail('empty or oversized proposal patch');
  for(const f of changed){
    if(Buffer.byteLength(fs.readFileSync(ordinaryFile(root,f)))>MAX_SOURCE_FILE)
      fail('source file exceeds bounded edit budget');
  }
  return Object.freeze({schema_version:1,kind:'qwen_developer_bounded_patch',
    source_sha:snapshot.plan.source_sha,
    issue:snapshot.origin.issue,action_id:snapshot.origin.action_id,
    run_id:snapshot.origin.run_id,
    agent_id:snapshot.plan.agent_id,
    provider:snapshot.plan.provider,
    harness_digest:snapshot.plan.harness_digest,
    paths:[...changed].sort(),patch_sha256:hash(patch),
    patch_bytes:Buffer.byteLength(patch),patch});
}

// Tool observations MUST come from actual Claude native events. This is the
// only entrypoint that attests Read/Edit; do not fabricate tool observations
// when re-checking a patch later at the checkpoint seal boundary.
export function collectQwenDevelopmentPatch(snapshot,{events}={}){
  // A textual model report saying "Read" or "Edit" is not a tool event.
  // Reuse the canonical Claude Code native stream parser's tool-use owner;
  // the caller must supply the real parsed stream, never claimed names.
  const observed=Array.isArray(events)?toolUseNames(events):null;
  if(!observed||!observed.includes('Read')||
      !observed.some(x=>x==='Edit'||x==='Write')||
      observed.some(x=>!['Read','Edit','Write'].includes(x)))
    fail('required actual restricted native Read/Edit evidence missing');
  return checkedGitPatch(snapshot);
}
export function verifyQwenPatchStillMatches(snapshot,previous){
  const current=checkedGitPatch(snapshot);
  if(previous?.kind!==current.kind||
      previous.patch_sha256!==current.patch_sha256||
      previous.patch!==current.patch||
      previous.issue!==current.issue||
      previous.action_id!==current.action_id||
      previous.run_id!==current.run_id||
      previous.harness_digest!==current.harness_digest||
      JSON.stringify(previous.paths)!==JSON.stringify(current.paths))
    fail('proposed Git source changed before native checkpoint seal');
  return current;
}
