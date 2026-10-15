#!/usr/bin/env node
// Read-only cross-store live audit. Never obtains an Issue/ref write token,
// runs fetched branch code, mutates a result ref, or treats the repository's
// own baseline as an independently controlled cryptographic anchor.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {auditAnchoredRunStore,classifyRunStorePath} from './run-store-integrity.mjs';
import {GOVERNED_REFS,evaluateStoreRules,validateMigrationBaseline,assertTrustedAuditContext}
  from './run-store-policy.mjs';

const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/,DIGEST=/^[a-f0-9]{64}$/;
const MAX_OUTPUT=10*1024*1024;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const err=m=>{throw Error('run-store-audit: '+m);};
const root=path.dirname(path.dirname(new URL(import.meta.url).pathname));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sortRefs=rows=>[...rows].sort((a,b)=>GOVERNED_REFS.indexOf(a.ref)-GOVERNED_REFS.indexOf(b.ref));

function git(dir,...args){
  return execFileSync('git',['-C',dir,...args],{
    timeout:45000,maxBuffer:MAX_OUTPUT,stdio:['ignore','pipe','pipe'],
    env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0'},
  }).toString('utf8').trim();
}
function api(endpoint){
  return JSON.parse(execFileSync('gh',['api','repos/'+REPO+'/'+endpoint],{
    timeout:30000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe'],
  }).toString('utf8'));
}
function externalPayload(source) {
  if(!source||source.schema_version!==1||source.kind!=='nession_run_store_anchor'||
     source.repository!==REPO||!positive(source.sequence)||
     !Array.isArray(source.stores)||source.stores.length!==GOVERNED_REFS.length||
     source.stores.map(x=>x.ref).join(',')!==GOVERNED_REFS.join(','))
    err('invalid separately signed checkpoint');
  for(const x of source.stores){
    if(!SHA.test(x.head_sha??'')||!SHA.test(x.tree_sha??'')||
       !DIGEST.test(x.manifest_sha256??''))
      err('malformed independently anchored ref/head/manifest');
  }
  return {schema_version:1,kind:'nession_run_store_anchor',
    repository:REPO,sequence:source.sequence,stores:source.stores.map(
      ({ref,head_sha,tree_sha,manifest_sha256})=>({ref,head_sha,tree_sha,manifest_sha256}))};
}

// Ed25519 signature covers the *canonical ordered* payload. Signature and
// anchor bytes must be published/retained outside the audited repository.
// A signature proves only the holder of the separately controlled private
// key signed the claimed checkpoint; no unsigned branch-local hash suffices.
export function verifyExternalAnchor(doc,publicKey){
  if(typeof doc!=='object'||Array.isArray(doc))err('invalid anchor envelope');
  const data=externalPayload(doc);
  if(typeof doc.signature!=='string'||!(/^[A-Za-z0-9+/]{84,90}={0,2}$/).test(doc.signature))
    err('invalid signed checkpoint signature');
  const key=crypto.createPublicKey(publicKey);
  if(key.asymmetricKeyType!=='ed25519'||
     !crypto.verify(null,Buffer.from(JSON.stringify(data)),key,
       Buffer.from(doc.signature,'base64')))
    err('independent anchor signature verification failed');
  return data;
}
export function verifyObservedAnchor(signed,ref,rootDir){
  const anchor=signed.stores.find(s=>s.ref===ref);
  if(!anchor)err('signed checkpoint missing ref');
  const head=git(rootDir,'rev-parse','--verify',anchor.head_sha+'^{commit}');
  if(head!==anchor.head_sha)err('signed checkpoint object missing');
  const tree=git(rootDir,'rev-parse',anchor.head_sha+'^{tree}');
  if(tree!==anchor.tree_sha)err('signed checkpoint tree drift');
  // The signed digest covers the full Git tree manifest at the signed head.
  const actual=hash(git(rootDir,'ls-tree','-r','-z',anchor.head_sha));
  if(actual!==anchor.manifest_sha256)err('signed checkpoint manifest drift');
  return anchor.head_sha;
}
export function verifyBaselineInRepo(baseline,ref,repoDir){
  const source=baseline.stores.find(s=>s.ref===ref);
  if(!source)err('missing migration ref');
  if(git(repoDir,'rev-parse','--verify',source.head_sha+'^{commit}')!==source.head_sha||
     git(repoDir,'rev-parse',source.head_sha+'^{tree}')!==source.tree_sha)
    err('migration baseline Git tree differs from recorded observation');
  return source.head_sha;
}
function listEntries(repoDir,commit='HEAD'){
  const raw=git(repoDir,'ls-tree','-r','-z',commit);
  if(!raw)return [];
  return raw.split('\0').filter(Boolean).map(item=>{
    const index=item.indexOf('\t'),metadata=item.slice(0,index).split(' ');
    const name=item.slice(index+1);
    if(index<0||metadata.length!==3||!SHA.test(metadata[2]))
      err('malformed Git tree entry');
    return {path:name,mode:metadata[0],blob_sha:metadata[2]};
  });
}
function scanSnapshot(repoDir,ref){
  const entries=listEntries(repoDir);
  let immutable=0,projection=0,cas=0;
  for(const {path:filename,mode} of entries){
    const kind=classifyRunStorePath(ref,filename);
    if(kind==='unclassified'||mode!=='100644')
      err('unclassified or nonregular current Git tree object '+ref+'/'+filename);
    if(kind==='immutable')immutable++;
    else if(kind==='projection')projection++;
    else if(kind==='cas-pointer')cas++;
  }
  const records=entries.filter(e=>
    e.path.endsWith('.json')&&
    (e.path.startsWith('runs/')||e.path.startsWith('raw/workflows/')));
  const samples=[];
  // A bounded representative read checks bytes as stored in Git and records
  // provenance *claims*. It does NOT substitute for source API/ingest receipts.
  for(const item of records.slice(-3)){
    const bytes=execFileSync('git',['-C',repoDir,'show','HEAD:'+item.path],{
      timeout:15000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
    if(bytes.length>1024*1024)err('sample exceeds record size budget');
    let record;
    try{record=JSON.parse(bytes.toString('utf8'));}
    catch{err('invalid record JSON at '+item.path);}
    const source=record.kind==='agent_workflow_run'
      ?{run_id:record.identity?.github_run_id,attempt:record.identity?.github_run_attempt,
        sha:record.task?.target_ref}
      :record.kind==='issue_e2e_run'
        ?{run_id:record.run_id,attempt:record.run_attempt,sha:record.target_sha}
        :{run_id:record.workflow?.id??record.run_id??null,
          attempt:record.workflow?.attempt??record.run_attempt??null,
          sha:record.source_sha??record.target_sha??null};
    if(source.run_id!=null&&(!positive(source.run_id)||!positive(source.attempt)||
       !SHA.test(source.sha??'')))err('invalid sampled source identity at '+item.path);
    if(ref==='task-results'&&record.source_snapshot_path){
      const snapshot=record.source_snapshot_path;
      if(typeof snapshot!=='string'||!/^sources\/[a-f0-9]{40}\/[a-z0-9-]+\.json$/.test(snapshot)||
         !entries.some(x=>x.path===snapshot))
        err('missing or invalid referenced Task source snapshot');
    }
    samples.push({path:item.path,blob_sha:item.blob_sha,
      record_sha256:hash(bytes),source_claims:source,
      source_api_and_ingester_receipt_verified:false});
  }
  return {tree_manifest_sha256:hash(git(repoDir,'ls-tree','-r','-z','HEAD')),
    objects:entries.length,immutable,mutable_projections:projection,
    cas_pointers:cas,representative_record_claims:samples};
}
async function loadExternal(){
  const url=process.env.STORE_ANCHOR_URL;
  const key=process.env.STORE_ANCHOR_PUBLIC_KEY_B64;
  if(!url&&!key)return null;
  if(!url||!key||!/^https:\/\//.test(url)||url.length>2048)
    err('independent anchor requires HTTPS URL and public Ed25519 key');
  const pem=Buffer.from(key,'base64').toString('utf8');
  const response=await fetch(url,{signal:AbortSignal.timeout(15000),
    redirect:'error',headers:{accept:'application/json'}});
  if(!response.ok)err('independent anchor endpoint unavailable');
  const body=await response.text();
  if(body.length>32768)err('oversized independent checkpoint');
  return verifyExternalAnchor(JSON.parse(body),pem);
}
async function observe(out){
  assertTrustedAuditContext(process.env);
  if(!path.isAbsolute(out))err('absolute output path required');
  const manifest=JSON.parse(fs.readFileSync(path.join(root,
    'scripts/run-store-migration-baseline.json'),'utf8'));
  validateMigrationBaseline(manifest);
  const report={schema_version:1,kind:'run_store_integrity_audit',repo:REPO,
    source_sha:process.env.GITHUB_SHA,
    source_run_id:process.env.GITHUB_RUN_ID??null,
    observed_at:new Date().toISOString(),
    baseline_label:'unanchored pre-enforcement migration observation',
    immutable_history_anchor_verified:false,
    result:'Pending',observations:[],errors:[]};
  let anchor=null;
  try {anchor=await loadExternal();}
  catch(e){report.errors.push('external-anchor: '+e.message);}
  let rules=[];
  try{
    const summaries=api('rulesets?per_page=100');
    if(!Array.isArray(summaries))err('invalid GitHub rulesets response');
    rules=summaries.map(item=>api('rulesets/'+item.id));
  }catch(e){report.errors.push('GitHub Ruleset details unavailable: '+e.message);}
  const approved=Number(process.env.STORE_WRITER_APP_ID??0);
  for(const ref of GOVERNED_REFS){
    const row={ref,status:'Pending',errors:[]};
    try {
      const branch=api('branches/'+ref);
      if(branch.name!==ref||!SHA.test(branch.commit?.sha??''))err('missing or recreated store ref');
      row.observed_head=branch.commit.sha;
      row.github_branch_protected=branch.protected===true;
      row.policy=evaluateStoreRules(ref,rules,approved);
      const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nession-run-store-audit-'));
      try{
        git(temp,'init','-q');
        git(temp,'fetch','--no-tags','--quiet',
          'https://github.com/'+REPO+'.git','refs/heads/'+ref);
        const fetched=git(temp,'rev-parse','FETCH_HEAD');
        if(fetched!==row.observed_head)err('concurrent ref advance; retry audit on stable snapshot');
        git(temp,'checkout','-q','--detach',fetched);
        const baseline=verifyBaselineInRepo(manifest,ref,temp);
        const signed=anchor?verifyObservedAnchor(anchor,ref,temp):null;
        const start=signed??baseline;
        row.ancestry=auditAnchoredRunStore(temp,ref,start,fetched);
        row.ancestry.trust_anchor_kind=signed?'externally_signed_checkpoint':
          'main_branch_observation_only';
        row.contents=scanSnapshot(temp,ref);
        const tree=git(temp,'rev-parse','HEAD^{tree}');
        row.observed_tree=tree;
        const repeated=api('branches/'+ref);
        if(repeated.commit?.sha!==fetched)
          err('store ref advanced during audit; incomplete snapshot');
        row.status=row.policy.configuration_verified&&signed?'verified_history_and_configuration':
          'history_checked_policy_or_external_anchor_pending';
      }finally{fs.rmSync(temp,{recursive:true,force:true});}
    }catch(e){
      row.status='failure';
      row.errors.push(e.message);
      report.errors.push(ref+': '+e.message);
    }
    report.observations.push(row);
  }
  report.externally_signed_checkpoint=anchor
    ?{sequence:anchor.sequence,verified:true}
    :{verified:false};
  report.immutable_history_anchor_verified=!!anchor&&report.errors.length===0;
  const policyOk=report.observations.every(x=>x.policy?.configuration_verified);
  const historyOk=report.observations.every(x=>x.ancestry);
  report.authorization={
    live_ruleset_configuration_verified:policyOk,
    actual_denied_and_allowed_writer_attempts_verified:false,
    trusted_ingester_identity_migration_verified:false,
  };
  report.result=report.errors.length?'Fail':
    historyOk&&policyOk&&anchor?'Partial: signed_history_and_rules_config':
      'Pending: authorization_and_or_external_anchor';
  fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  const summary=process.env.GITHUB_STEP_SUMMARY;
  if(summary)fs.appendFileSync(summary,'\n## Run Store Governance / Integrity\n\n'+
    '| Ref | History | Ruleset | External checkpoint |\n|---|---|---|---|\n'+
    report.observations.map(r=>'| '+r.ref+' | '+r.status+' | '+
      (r.policy?.configuration_verified?'configured':'not verified')+' | '+
      (anchor?'signed':'none')+' |').join('\n')+'\n\n'+
    'Verdict: '+report.result+'. The result never certifies an actual denial test.\n');
  console.log('Read-only orphan Store audit: '+report.result);
  if(report.errors.length)process.exitCode=1;
}
function selfTest(){
  const keys=crypto.generateKeyPairSync('ed25519');
  const source={schema_version:1,kind:'nession_run_store_anchor',
    repository:REPO,sequence:1,stores:GOVERNED_REFS.map(ref=>({
      ref,head_sha:'a'.repeat(40),tree_sha:'b'.repeat(40),
      manifest_sha256:'c'.repeat(64)}))};
  const signature=crypto.sign(null,Buffer.from(JSON.stringify(source)),
    keys.privateKey).toString('base64');
  assert.deepEqual(verifyExternalAnchor({...source,signature},keys.publicKey),source);
  assert.throws(()=>verifyExternalAnchor({...source,sequence:2,signature},keys.publicKey),/verification failed/);
  assert.throws(()=>verifyExternalAnchor({...source,signature:signature.replace(/^./,'A')},
    keys.publicKey),/verification failed/);
  assert.throws(()=>verifyExternalAnchor({...source,stores:source.stores.slice(1),
    signature},keys.publicKey),/checkpoint/);
  assert.throws(()=>verifyExternalAnchor({...source,signature:'forged'},keys.publicKey),/signature/);
  console.log('Run Store external-anchor signature: real Ed25519 verify and forged/reordered/absent negatives passed');
}
const cmd=process.argv[2];
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(cmd==='self-test')selfTest();
  else if(cmd==='live'&&process.argv[3])await observe(process.argv[3]);
  else err('usage: self-test | live ABS_OUTPUT_JSON');
}
