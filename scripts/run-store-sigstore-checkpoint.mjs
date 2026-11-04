#!/usr/bin/env node
// #1690 SC-08: independently witnessed public-Sigstore checkpoint for all
// four public orphan Store refs. This creates NO refs and has NO writer token.
// The first signed snapshot is a new baseline, not retroactive attestation.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditAnchoredRunStore} from './run-store-integrity.mjs';

export const REPO='BestNathan/nession';
export const REFS=Object.freeze(['acceptance-results','task-results','metrics','agent-store']);
export const PREDICATE='https://github.com/BestNathan/nession/attestation/run-store-checkpoint/v1';
export const SIGNER='BestNathan/nession/.github/workflows/ci-run-store-anchor.yml';
const SHA=/^[0-9a-f]{40}$/;
const DIGEST=/^[0-9a-f]{64}$/;
const URL='https://github.com/BestNathan/nession.git';
const hash=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const deny=message=>{throw Error('run-store-sigstore-checkpoint: '+message);};

function command(program,args,options={}){
  return execFileSync(program,args,{
    timeout:120000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe'],
    ...options,
  });
}
function git(cwd,...args){return command('git',['-C',cwd,...args]);}
function exactMain(env){
  if(env.GITHUB_REPOSITORY!==REPO||env.GITHUB_REF!=='refs/heads/main'||
     !SHA.test(env.GITHUB_SHA??'')||
     !/^[1-9]\d*$/.test(String(env.GITHUB_RUN_ID??''))||
     !/^[1-9]\d*$/.test(String(env.GITHUB_RUN_ATTEMPT??'')))
    deny('trusted exact-main source/run/attempt required');
}
export function temporaryGit(callback){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-store-checkpoint-'));
  try{
    command('git',['init','-q',dir]);
    // Explicit public URL, fixed refs, no untrusted checkout scripts, no push.
    command('git',['-C',dir,'fetch','--quiet','--no-tags',URL,
      ...REFS.map(ref=>'refs/heads/'+ref+':refs/nession-audit/'+ref)]);
    return callback(dir);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
function githubRef(ref,run=command){
  if(!REFS.includes(ref))deny('unclassified store ref');
  const raw=run('gh',['api','--method','GET',
    'repos/'+REPO+'/git/ref/heads/'+ref],{encoding:'utf8',timeout:30000});
  const value=JSON.parse(String(raw));
  if(value?.ref!=='refs/heads/'+ref||
     value.object?.type!=='commit'||!SHA.test(value.object.sha??''))
    deny('untrusted live GitHub ref response for '+ref);
  return value.object.sha;
}
function treeOf(repo,ref){
  if(!REFS.includes(ref))deny('unsupported Git checkpoint ref');
  const name='refs/nession-audit/'+ref;
  const head=git(repo,'rev-parse',name).toString('utf8').trim();
  const tree=git(repo,'rev-parse',name+'^{tree}').toString('utf8').trim();
  const entries=git(repo,'ls-tree','-r','-z',name);
  const count=entries.length?entries.toString('utf8').split('\0').length-1:0;
  if(!SHA.test(head)||!SHA.test(tree)||count<1||count>100000)
    deny('invalid Git history or oversized Store tree '+ref);
  return {ref,head_sha:head,tree_sha:tree,tree_entry_count:count,
    canonical_tree_listing_sha256:hash(entries)};
}
export function canonicalManifest(stores,mainSha,runId,attempt){
  if(!Array.isArray(stores)||JSON.stringify(stores.map(x=>x.ref))!==JSON.stringify(REFS)||
     !SHA.test(mainSha)||!/^[1-9]\d*$/.test(String(runId))||
     !/^[1-9]\d*$/.test(String(attempt)))
    deny('untrusted checkpoint scope');
  for(const s of stores){
    if(!SHA.test(s.head_sha)||!SHA.test(s.tree_sha)||
       !DIGEST.test(s.canonical_tree_listing_sha256)||
       !Number.isSafeInteger(s.tree_entry_count)||s.tree_entry_count<1)
      deny('invalid Store root/content commitment');
  }
  const canonical=JSON.stringify(stores);
  return {
    schema_version:1,kind:'public_sigstore_run_store_checkpoint',
    repository:REPO,main_sha:mainSha,
    source_run_id:Number(runId),source_run_attempt:Number(attempt),
    initial_checkpoint_class:'new_observation_only_not_retroactive_attestation',
    integrity_policy:'scripts/run-store-integrity.mjs:auditAnchoredRunStore',
    stores,
    canonical_store_roots_sha256:hash(Buffer.from(canonical,'utf8')),
    external_witness:'Sigstore Public Good transparency log; verification required',
    scope_limit:'immutable source snapshot, not writer identity or source receipt attestation',
  };
}
export function validateManifest(value){
  if(value?.schema_version!==1||value.kind!=='public_sigstore_run_store_checkpoint'||
     value.repository!==REPO||value.initial_checkpoint_class!==
       'new_observation_only_not_retroactive_attestation'||
     value.canonical_store_roots_sha256!==
       hash(Buffer.from(JSON.stringify(value.stores??null),'utf8')))
    deny('invalid untrusted signed checkpoint content');
  const expected=canonicalManifest(value.stores,value.main_sha,
    value.source_run_id,value.source_run_attempt);
  if(JSON.stringify(expected)!==JSON.stringify(value))
    deny('unrecognized checkpoint fields/policy');
  return value;
}
export function verifySignedBundle(manifest,verified,bytes){
  validateManifest(manifest);
  if(!Array.isArray(verified)||verified.length<1||!Buffer.isBuffer(bytes))
    deny('no verified Sigstore bundle');
  const digest=hash(bytes);
  const match=verified.find(item=>{
    const result=item?.verificationResult;
    const st=result?.statement;
    const subjects=st?.subject;
    const bundle=item?.attestation?.bundle??item?.attestation;
    const logEntries=bundle?.verificationMaterial?.tlogEntries;
    // A TSA-only timestamp is insufficient: this public-repo path requires
    // an actual Sigstore transparency log entry in the verified bundle.
    return st?.predicateType===PREDICATE&&
      isDeepStrictEqual(st.predicate,manifest)&&
      Array.isArray(subjects)&&subjects.length===1&&
      subjects[0]?.digest?.sha256===digest&&
      Array.isArray(result.verifiedTimestamps)&&result.verifiedTimestamps.length>0&&
      Array.isArray(logEntries)&&logEntries.length>0&&
      logEntries.some(entry=>Number.isSafeInteger(Number(entry?.logIndex))&&
        Number(entry.logIndex)>=0&&
        (entry.inclusionProof||entry.inclusionPromise));
  });
  if(!match)deny('no exact subject/predicate/independent witnessed timestamp');
  // Signature, trusted root and signer-workflow identity are checked by gh
  // attestation verify, not by reinterpreting model- or workflow-supplied JSON.
  return {kind:'run_store_independent_signature_verification',
    checkpoint_sha256:digest,main_sha:manifest.main_sha,
    witness:'verified public Sigstore log timestamp',
    verified:true,external_log_witnessed:true};
}
export function verifyRestore(manifest,repo,lookup=githubRef){
  validateManifest(manifest);
  const results=[];
  for(const stored of manifest.stores){
    const current=lookup(stored.ref);
    const currentName='refs/nession-audit/'+stored.ref;
    const fetched=git(repo,'rev-parse',currentName).toString('utf8').trim();
    if(current!==fetched)deny('live API/fetched head drift for '+stored.ref);
    // Never silently accept a rewritten ref, even if a new tree looks plausible.
    try{
      git(repo,'merge-base','--is-ancestor',stored.head_sha,currentName);
    }catch{deny('signed checkpoint is not an ancestor for '+stored.ref);}
    const pinned=''+stored.head_sha;
    const tree=git(repo,'rev-parse',pinned+'^{tree}').toString('utf8').trim();
    const entries=git(repo,'ls-tree','-r','-z',pinned);
    if(tree!==stored.tree_sha||
       hash(entries)!==stored.canonical_tree_listing_sha256||
       (entries.length?entries.toString('utf8').split('\0').length-1:0)!==
         stored.tree_entry_count)
      deny('signed Store content commitment mismatch: '+stored.ref);
    // The canonical auditor requires HEAD == observed. Move ONLY the
    // disposable local symbolic HEAD; no checkout, production ref, or tracked
    // file is modified. This also prevents accidental worktree execution.
    git(repo,'symbolic-ref','HEAD',currentName);
    // Reuse the canonical Git policy: a later fast-forward destructive change
    // is corruption, not a valid signed-checkpoint successor.
    const audit=auditAnchoredRunStore(repo,stored.ref,pinned,current);
    results.push({ref:stored.ref,baseline_sha:pinned,observed_sha:current,
      checked_commits:audit.checked_commits,checked_changes:audit.checked_changes,
      status:'ReadOnlyRestoreVerified'});
  }
  return {kind:'run_store_signed_checkpoint_restore_drill',
    baseline_class:manifest.initial_checkpoint_class,restored_to_temporary_git:true,
    source_main_sha:manifest.main_sha,coverage:results.length,total:REFS.length,
    production_ref_mutated:false,results};
}
function collect(output){
  exactMain(process.env);
  if(!path.isAbsolute(output)||fs.existsSync(output))deny('fresh absolute output required');
  temporaryGit(repo=>{
    const stores=REFS.map(ref=>{
      const tree=treeOf(repo,ref);
      if(tree.head_sha!==githubRef(ref))deny('live GitHub head changed while collecting '+ref);
      return tree;
    });
    const manifest=canonicalManifest(stores,process.env.GITHUB_SHA,
      process.env.GITHUB_RUN_ID,process.env.GITHUB_RUN_ATTEMPT);
    fs.writeFileSync(output,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    console.log('Run Store checkpoint: 4 exact public refs; signed baseline not yet minted');
  });
}
function verifyAndRestore(file,report){
  exactMain(process.env);
  if(!path.isAbsolute(file)||!path.isAbsolute(report)||fs.existsSync(report))
    deny('absolute signed checkpoint and fresh report required');
  const bytes=fs.readFileSync(file);
  if(bytes.length>64*1024||bytes.length<100)deny('unbounded checkpoint file');
  const manifest=validateManifest(JSON.parse(bytes.toString('utf8')));
  if(manifest.main_sha!==process.env.GITHUB_SHA||
     manifest.source_run_id!==Number(process.env.GITHUB_RUN_ID)||
     manifest.source_run_attempt!==Number(process.env.GITHUB_RUN_ATTEMPT))
    deny('checkpoint is from a different main run/attempt');
  const out=command('gh',['attestation','verify',file,'--repo',REPO,
    '--signer-workflow',SIGNER,'--predicate-type',PREDICATE,
    '--format','json'],{encoding:'utf8',timeout:90000,maxBuffer:1024*1024,
    env:{...process.env,GH_TOKEN:process.env.GITHUB_TOKEN}});
  const witness=verifySignedBundle(manifest,JSON.parse(out),bytes);
  const restore=temporaryGit(repo=>verifyRestore(manifest,repo));
  fs.writeFileSync(report,JSON.stringify({schema_version:1,
    kind:'run_store_external_checkpoint_and_restore_evidence',
    witness,restore,verified_at:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
  console.log('Signed Sigstore checkpoint verified, four Store roots recovered read-only');
}
function selfTest(){
  const stores=REFS.map(ref=>({ref,head_sha:'a'.repeat(40),
    tree_sha:'b'.repeat(40),tree_entry_count:3,
    canonical_tree_listing_sha256:'c'.repeat(64)}));
  const m=canonicalManifest(stores,'d'.repeat(40),123,1);
  assert.equal(validateManifest(m),m);
  assert.throws(()=>validateManifest({...m,stores:[...stores].reverse()}));
  assert.throws(()=>validateManifest({...m,canonical_store_roots_sha256:'0'.repeat(64)}));
  assert.throws(()=>validateManifest({...m,main_sha:'foo'}));
  const bytes=Buffer.from(JSON.stringify(m));
  const evidence=[{attestation:{bundle:{verificationMaterial:{tlogEntries:[
    {logIndex:10,inclusionProof:{rootHash:'abc'}}]}}},verificationResult:{statement:{
    predicateType:PREDICATE,predicate:m,
    subject:[{digest:{sha256:hash(bytes)}}],
  },verifiedTimestamps:[{timestamp:'2026-11-03T12:00:00Z'}]}}];
  assert.equal(verifySignedBundle(m,evidence,bytes).verified,true);
  assert.throws(()=>verifySignedBundle(m,evidence,Buffer.from('changed')));
  assert.throws(()=>verifySignedBundle(m,[{...evidence[0],
    attestation:{bundle:{verificationMaterial:{tlogEntries:[]}}}}],bytes));
  assert.throws(()=>verifySignedBundle(m,[{verificationResult:{
    ...evidence[0].verificationResult,verifiedTimestamps:[]}}],bytes));
  assert.throws(()=>verifySignedBundle(m,[{verificationResult:{
    ...evidence[0].verificationResult,statement:{
      ...evidence[0].verificationResult.statement,predicate:{...m,main_sha:'0'.repeat(40)},
    }}}],bytes));
  assert.equal(REFS.length,4);
  console.log('run-store Sigstore checkpoint: canonical roots, witnessed signature and hostile fixtures passed');
}
// Importing the canonical verifier for a trusted, separately scheduled
// observer must not invoke its CLI or claim an SC verdict as a side effect.
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{
    const mode=process.argv[2];
    if(mode==='self-test')selfTest();
    else if(mode==='collect')collect(process.argv[3]);
    else if(mode==='verify-restore')verifyAndRestore(process.argv[3],process.argv[4]);
    else deny('usage: self-test | collect OUT | verify-restore CHECKPOINT OUT');
  }catch(e){console.error('::error::'+String(e.message));process.exitCode=1;}
}
