import { execFileSync } from 'node:child_process';
import path from 'node:path';

const HEX40 = /^[0-9a-f]{40}$/;
const UUID = '[a-z][a-z0-9-]*';
const ISSUE = '[1-9][0-9]*';
const VER = '[0-9]{8}';
const ROLES = '(?:developer|reviewer|acceptor|auditor)';
const SEGMENT = '[a-zA-Z0-9._-]+';
const rules = Object.freeze({
  'acceptance-results': [
    {path: /^runs\/.+$/, kind: 'immutable'},
    {path: /^indexes\/.+$/, kind: 'immutable'},
    {path: /^sources\/.+$/, kind: 'immutable'},
    {path: /^README\.md$/, kind: 'immutable'},
  ],
  'task-results': [
    {path: /^runs\/.+$/, kind: 'immutable'},
    {path: /^indexes\/.+$/, kind: 'immutable'},
    {path: /^sources\/.+$/, kind: 'immutable'},
    {path: /^README\.md$/, kind: 'immutable'},
  ],
  metrics: [
    {path: /^raw\/workflows\/.+$/, kind: 'immutable'},
    {path: /^raw\/events\/.+$/, kind: 'immutable'},
    {path: /^(?:metrics|agent-metrics|repo-metrics)\.json$/, kind: 'projection'},
    {path: /^(?:repo-metrics|agent-metrics)-(?:light|dark)\.svg$/, kind: 'projection'},
    {path: /^README\.md$/, kind: 'immutable'},
  ],
  'agent-store': [
    {path: new RegExp('^roles/' + ROLES + '/' + UUID + '/issues/' + ISSUE + '/checkpoints/' + VER + '\\.json$'), kind:'immutable'},
    {path: new RegExp('^roles/' + ROLES + '/' + UUID + '/issues/' + ISSUE + '/runs/' + ISSUE + '-' + ISSUE + '\\.json$'), kind:'immutable'},
    {path: new RegExp('^roles/' + ROLES + '/' + UUID + '/issues/' + ISSUE + '/head\\.json$'), kind:'cas-pointer'},
    {path: new RegExp('^workflows/issues/' + ISSUE + '/states/' + VER + '\\.json$'), kind:'immutable'},
    {path: new RegExp('^workflows/issues/' + ISSUE + '/results/' + ISSUE + '-' + ISSUE + '-[a-f0-9]{64}\\.json$'), kind:'immutable'},
    {path: new RegExp('^workflows/issues/' + ISSUE + '/head\\.json$'), kind:'cas-pointer'},
  ],
});
export const RUN_STORE_INTEGRITY_SCHEMA_VERSION=1;
export const RUN_STORE_REFS=Object.freeze(Object.keys(rules));
function reject(s){throw new Error('run-store-integrity: '+s);}
function git(root,args){
  try{return execFileSync('git',['-C',root,...args],{
    encoding:'buffer',maxBuffer:3*1024*1024,timeout:20000,
    env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1'},
    stdio:['ignore','pipe','pipe'],
  });}catch(e){reject('Git operation failed: '+args[0]+' ('+(e.status??'unknown')+')');}
}
function scalarSha(sha){if(typeof sha!=='string'||!HEX40.test(sha))reject('trusted SHA-1 commit anchor is required');return sha;}
function noUnsafePath(file){
  if(typeof file!=='string'||!file||file.startsWith('/')||
    file.split('/').some(x=>!x||x==='.'||x==='..')||
    /[\x00-\x1f\x7f\\]/.test(file))reject('unsafe Git tree path');
}
export function classifyRunStorePath(store,file){
  const policy=rules[store];if(!policy)reject('unclassified run store');
  noUnsafePath(file);
  return policy.find(x=>x.path.test(file))?.kind??'unclassified';
}
export function validateRunStoreChange(store,status,file){
  const kind=classifyRunStorePath(store,file);
  if(!['A','M','D','T','U'].includes(status))reject('unclassified Git status '+status);
  if(status==='A'&&(kind==='immutable'||kind==='projection'||kind==='cas-pointer'))return {path:file,status,kind};
  if(status==='M'&&(kind==='projection'||kind==='cas-pointer'))return {path:file,status,kind};
  reject('forbidden '+store+' '+status+' '+file+' ('+kind+')');
}
function decodeNameStatus(bytes){
  if(!Buffer.isBuffer(bytes))reject('invalid Git tree diff stream');
  if(!bytes.length)return [];
  if(bytes[bytes.length-1]!==0)reject('truncated Git diff entry');
  const fields=bytes.subarray(0,-1).toString('utf8').split('\0');
  if(fields.length%2)reject('misaligned Git diff stream');
  const entries=[];
  for(let i=0;i<fields.length;i+=2){
    if(!/^[AMDTU]$/.test(fields[i]))reject('unexpected Git rename/copy/conflict status '+fields[i]);
    entries.push({status:fields[i],path:fields[i+1]});
  }
  return entries;
}
function checkEntries(store,entries){
  const seen=new Set();
  for(const item of entries){
    if(seen.has(item.path))reject('duplicate Git path change');
    seen.add(item.path);
    validateRunStoreChange(store,item.status,item.path);
  }
  return entries.length;
}
export function auditStagedRunStore(root,store){
  const entries=decodeNameStatus(git(root,[
    'diff','--cached','--name-status','--no-renames','-z','--diff-filter=AMDTU'
  ]));
  return {schema_version:1,store,mode:'staged',checked_changes:checkEntries(store,entries)};
}
function resolveCommit(root,sha){
  scalarSha(sha);
  const resolved=git(root,['rev-parse','--verify',sha+'^{commit}']).toString('utf8').trim();
  if(resolved!==sha)reject('commit identity differs from claimed anchor');
  return sha;
}
export function auditAnchoredRunStore(root,store,baseline,observed){
  if(!rules[store])reject('unclassified run store');
  // Caller must obtain the baseline from a separately controlled anchor. A
  // self-hash, current ref HEAD, GitHub workflow input or branch-local file
  // does NOT establish such an anchor.
  const base=resolveCommit(root,baseline),head=resolveCommit(root,observed);
  const checkedOut=git(root,['rev-parse','--verify','HEAD']).toString('utf8').trim();
  if(checkedOut!==head)reject('checkout HEAD differs from observed ref');
  try{
    execFileSync('git',['-C',root,'merge-base','--is-ancestor',base,head],{
      timeout:20000,stdio:'ignore',
      env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1'},
    });
  }catch{reject('baseline is not ancestor of observed ref (rewrite/unrelated history)');}
  const commits=git(root,['rev-list','--reverse','--first-parent',base+'..'+head])
    .toString('utf8').trim().split('\n').filter(Boolean);
  if(commits.length>20000)reject('audit window exceeds bounded commit count');
  let prev=base,checkedChanges=0;
  for(const sha of commits){
    if(!HEX40.test(sha))reject('invalid Git ancestry SHA');
    const parents=git(root,['show','-s','--format=%P',sha]).toString('utf8').trim().split(' ').filter(Boolean);
    if(parents.length!==1||parents[0]!==prev)reject('nonlinear/merge history in orphan run store');
    const delta=git(root,['diff','--name-status','--no-renames','-z','--diff-filter=AMDTU',prev,sha]);
    checkedChanges+=checkEntries(store,decodeNameStatus(delta));
    prev=sha;
  }
  if(prev!==head)reject('unverified commit traversal');
  return {
    schema_version:RUN_STORE_INTEGRITY_SCHEMA_VERSION,
    store,mode:'anchored-history',baseline:base,observed:head,
    checked_commits:commits.length,checked_changes:checkedChanges,
    // This means ancestry against a caller-provided anchor, not that an
    // independent external anchor has been provisioned by this module.
    anchor_source:'caller-supplied',
  };
}
if(process.argv[1]?.endsWith('run-store-integrity.mjs')){
  const [mode,store,repoDir,a,b]=process.argv.slice(2);
  if(!repoDir||!path.isAbsolute(repoDir))reject('absolute checkout path is required');
  if(mode==='staged')console.log(JSON.stringify(auditStagedRunStore(repoDir,store)));
  else if(mode==='anchored')console.log(JSON.stringify(auditAnchoredRunStore(repoDir,store,a,b)));
  else reject('usage: staged STORE ABS_DIR | anchored STORE ABS_DIR TRUSTED_BASE_SHA REF_SHA');
}
