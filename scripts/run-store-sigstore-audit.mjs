#!/usr/bin/env node
// #1690 SC-07: scheduled/read-only forensic audit from the FIRST independently
// witnessed public Sigstore Store checkpoint. Never infer a new baseline from
// the current refs: doing so would silently bless a replaced orphan history.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  REPO,REFS,PREDICATE,SIGNER,validateManifest,verifySignedBundle,
  verifyRestore,temporaryGit,
} from './run-store-sigstore-checkpoint.mjs';

export const FIRST_GOOD=Object.freeze({
  subject_sha256:'d6579886c6150f34b373901b29ad2aecf9d624b91004e7f87675d6dc3062e690',
  main_sha:'ccd0858b6bc06cf5c22e0efc1a9f2100974a568f',
  run_id:41613325000,run_attempt:1,
  rekoring_index:3665505739,
  attestation_id:63042719,
});
const SHA=/^[0-9a-f]{40}$/;
const HASH=/^[0-9a-f]{64}$/;
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const fail=msg=>{throw Error('run-store-signed-integrity-audit: '+msg);};
function gh(args){
  return execFileSync('gh',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],
    maxBuffer:4*1024*1024,timeout:90000,env:{
      ...process.env,
      GH_TOKEN:process.env.GITHUB_TOKEN||process.env.GH_TOKEN,
      GITHUB_TOKEN:process.env.GITHUB_TOKEN||process.env.GH_TOKEN,
    }});
}
function mainOnly(env){
  if(env.GITHUB_REPOSITORY!==REPO||env.GITHUB_REF!=='refs/heads/main'||
    !SHA.test(env.GITHUB_SHA??'')||
    !/^[1-9][0-9]*$/.test(String(env.GITHUB_RUN_ID??''))||
    !/^[1-9][0-9]*$/.test(String(env.GITHUB_RUN_ATTEMPT??''))||
    !['push','schedule','repository_dispatch'].includes(env.GITHUB_EVENT_NAME))
    fail('trusted default-main read-only Workflow required');
}
export function manifestFromOriginalStatement(statement){
  if(statement?.predicateType!==PREDICATE||
     !Array.isArray(statement?.subject)||statement.subject.length!==1||
     statement.subject[0]?.digest?.sha256!==FIRST_GOOD.subject_sha256)
    fail('attestation subject/type is not original witnessed checkpoint');
  const manifest=validateManifest(statement.predicate);
  if(manifest.main_sha!==FIRST_GOOD.main_sha||
     manifest.source_run_id!==FIRST_GOOD.run_id||
     manifest.source_run_attempt!==FIRST_GOOD.run_attempt)
    fail('original signed source/run identity is not pinned');
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n','utf8');
  if(hash(bytes)!==FIRST_GOOD.subject_sha256)
    fail('original predicate does not reconstruct the pinned subject bytes');
  return {manifest,bytes};
}
export function pickOriginalBundle(raw){
  if(!raw||!Array.isArray(raw.attestations)||
     !raw.attestations.length||raw.attestations.length>100)
    fail('missing or excessive original public attestation identities');
  const urls=raw.attestations.map(x=>x?.bundle_url).filter(Boolean);
  if(urls.length<1)fail('original Sigstore bundle unavailable');
  for(const value of urls){
    if(typeof value!=='string'||value.length>3500)continue;
    let u;try{u=new URL(value);}catch{continue;}
    // GitHub REST returns a short-lived, independently hosted signed bundle
    // URL. Reject internal, plaintext, arbitrary-HTTP and attacker locations.
    const host=u.hostname.toLowerCase();
    if(u.protocol!=='https:'||
       !(host.endsWith('.blob.core.windows.net')||
         host.endsWith('.githubusercontent.com')))
      continue;
    return value;
  }
  fail('no permitted GitHub attestation bundle host');
}
export function unpackOriginalEnvelope(bundle){
  const payload=bundle?.dsseEnvelope?.payload;
  if(typeof payload!=='string'||payload.length<100||payload.length>256000||
     !/^[A-Za-z0-9+/=]+$/.test(payload)||
     !Array.isArray(bundle.dsseEnvelope.signatures)||
     bundle.dsseEnvelope.signatures.length<1)
    fail('missing bounded signed Sigstore DSSE envelope');
  const bytes=Buffer.from(payload,'base64');
  if(bytes.length>180000)fail('oversized signed checkpoint statement');
  return manifestFromOriginalStatement(JSON.parse(bytes.toString('utf8')));
}
// GitHub's public Attestations REST bundle_url is served as raw Snappy block
// (.json.sn). Treat it as binary, never UTF-8 text. Verify signed DSSE using
// the existing canonical Sigstore verifier AFTER bounded decoding; decoding
// itself never confers authenticity.
export function decodeSnappyBundle(raw){
  if(!Buffer.isBuffer(raw)||raw.length<2||raw.length>1024*1024)
    fail('invalid or oversized raw Snappy signed bundle');
  let input=0,size=0,mult=1,finished=false;
  for(let i=0;i<5;i++){
    if(input>=raw.length)fail('truncated Snappy length');
    const b=raw[input++];
    size+=(b&0x7f)*mult;
    if((b&0x80)===0){finished=true;break;}
    mult*=128;
  }
  if(!finished||!Number.isSafeInteger(size)||size<2||size>2*1024*1024)
    fail('invalid or unbounded Snappy uncompressed length');
  const out=Buffer.alloc(size);
  let cursor=0;
  while(input<raw.length){
    const tag=raw[input++],kind=tag&3;
    let length=0,offset=0;
    if(kind===0){
      const code=tag>>>2;
      if(code<60)length=code+1;
      else{
        const n=code-59;
        if(input+n>raw.length)fail('truncated Snappy literal length');
        let scalar=0;
        for(let i=0;i<n;i++)scalar+=raw[input++]*2**(8*i);
        length=scalar+1;
      }
      if(length<1||length>size-cursor||input+length>raw.length)
        fail('truncated/oversized Snappy literal');
      raw.copy(out,cursor,input,input+length);
      input+=length;cursor+=length;
      continue;
    }
    if(kind===1){
      length=4+((tag>>>2)&7);
      if(input>=raw.length)fail('truncated Snappy copy1 offset');
      offset=((tag&0xe0)<<3)|raw[input++];
    }else{
      const n=kind===2?2:4;
      length=1+(tag>>>2);
      if(input+n>raw.length)fail('truncated Snappy copy offset');
      offset=0;
      for(let i=0;i<n;i++)offset+=raw[input++]*2**(8*i);
    }
    if(!Number.isSafeInteger(offset)||offset<1||offset>cursor||
       length<1||length>size-cursor)
      fail('invalid Snappy copy bounds');
    for(let i=0;i<length;i++)out[cursor+i]=out[cursor+i-offset];
    cursor+=length;
  }
  if(cursor!==size||input!==raw.length)
    fail('Snappy signed bundle length mismatch');
  return out;
}
async function getOriginalBundle(){
  const listing=JSON.parse(gh(['api','--method','GET',
    'repos/'+REPO+'/attestations/sha256:'+FIRST_GOOD.subject_sha256+
      '?predicate_type='+encodeURIComponent(PREDICATE)]));
  const url=pickOriginalBundle(listing);
  const response=await fetch(url,{signal:AbortSignal.timeout(60000)});
  if(!response.ok)fail('GitHub public signed bundle fetch failed: '+response.status);
  const body=Buffer.from(await response.arrayBuffer());
  if(body.length>1024*1024||body.length<2)fail('invalid signed bundle body');
  // Public GitHub Attestation bundles use raw Snappy .json.sn. A future
  // uncompressed JSON response remains accepted only if all subsequent
  // independent signer, predicate, digest and Rekor checks succeed.
  const bytes=body[0]===0x7b?body:decodeSnappyBundle(body);
  const bundle=JSON.parse(bytes.toString('utf8'));
  return unpackOriginalEnvelope(bundle);
}
function verifyReadOnly(reportFile){
  if(!path.isAbsolute(reportFile)||fs.existsSync(reportFile))
    fail('fresh absolute audit report path required');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-first-anchor-'));
  return getOriginalBundle().then(({manifest,bytes})=>{
    try{
      const subject=path.join(root,'checkpoint.json');
      fs.writeFileSync(subject,bytes,{flag:'wx',mode:0o600});
      const verified=JSON.parse(gh(['attestation','verify',subject,
        '--repo',REPO,'--signer-workflow',SIGNER,
        '--predicate-type',PREDICATE,'--format','json']));
      const witness=verifySignedBundle(manifest,verified,bytes);
      const pinnedLog=verified.some(item=>{
        const entries=item?.attestation?.bundle?.verificationMaterial?.tlogEntries??
          item?.attestation?.verificationMaterial?.tlogEntries??[];
        return Array.isArray(entries)&&entries.some(entry=>
          Number(entry?.logIndex)===FIRST_GOOD.rekoring_index&&
          (entry.inclusionProof||entry.inclusionPromise));
      });
      if(!pinnedLog)fail('verified original Rekor transparency log index absent');
      const restore=temporaryGit(repo=>verifyRestore(manifest,repo));
      if(restore.coverage!==REFS.length||restore.total!==REFS.length||
         restore.results.some(x=>x.status!=='ReadOnlyRestoreVerified'))
        fail('incomplete or unverified baseline-to-live Store audit');
      const report={schema_version:1,
        kind:'run_store_original_signed_baseline_history_audit',
        repository:REPO,verdict:'Verified',audit_source:'independent_first_good_Rekor',
        baseline_class:manifest.initial_checkpoint_class,
        baseline_source_main_sha:FIRST_GOOD.main_sha,
        baseline_source_run_id:FIRST_GOOD.run_id,
        pinned_log_index:FIRST_GOOD.rekoring_index,
        pinned_attestation_id:FIRST_GOOD.attestation_id,
        external_subject_sha256:hash(bytes),
        independent_sigstore_witness_verified:witness.verified===true,
        verified_history:restore.results,
        coverage:restore.coverage,total:REFS.length,
        audited_main_sha:process.env.GITHUB_SHA,
        audit_run_id:Number(process.env.GITHUB_RUN_ID),
        audit_run_attempt:Number(process.env.GITHUB_RUN_ATTEMPT),
        no_production_ref_mutation:true,
        writer_authorization_verified:false,
        alert_channel:'GitHub Actions failure and error annotation if audit fails',
        legacy_records_predating_anchor:'not_retroactively_authenticated',
        generated_at:new Date().toISOString()};
      fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
      console.log('Verified original Rekor #'+FIRST_GOOD.rekoring_index+
        '; four historical Store heads checked against current Git ancestry.');
      return report;
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  });
}
function selfTest(){
  // Positive Snappy block fixtures: literal-only and overlapping COPY_1.
  assert.equal(decodeSnappyBundle(Buffer.from([5,16,104,101,108,108,111]))
    .toString('utf8'),'hello');
  assert.equal(decodeSnappyBundle(Buffer.from([8,4,97,98,9,2]))
    .toString('utf8'),'abababab');
  for(const bad of [
    Buffer.from([5,16,104,101]),                // truncated literal
    Buffer.from([8,4,97,98,9,0]),              // illegal zero offset
    Buffer.from([8,4,97,98,9,3]),              // copy before output start
    Buffer.from([8,4,97,98,9,2,0]),            // extra payload
    Buffer.from([128]),                        // truncated varint
    Buffer.from([255,255,255,255,127,0]),      // too-large decoded body
    Buffer.from([8,4,97,98,9]),                // truncated copy
  ])assert.throws(()=>decodeSnappyBundle(bad));
  assert.equal(REFS.length,4);
  const sample={schema_version:1,kind:'public_sigstore_run_store_checkpoint',
    repository:REPO,main_sha:FIRST_GOOD.main_sha,
    source_run_id:FIRST_GOOD.run_id,source_run_attempt:1,
    initial_checkpoint_class:'new_observation_only_not_retroactive_attestation',
    integrity_policy:'scripts/run-store-integrity.mjs:auditAnchoredRunStore',
    stores:REFS.map(ref=>({ref,head_sha:'a'.repeat(40),tree_sha:'b'.repeat(40),
      tree_entry_count:1,canonical_tree_listing_sha256:'c'.repeat(64)})),
    canonical_store_roots_sha256:'z',
    external_witness:'Sigstore Public Good transparency log; verification required',
    scope_limit:'immutable source snapshot, not writer identity or source receipt attestation'};
  assert.throws(()=>manifestFromOriginalStatement({
    predicateType:PREDICATE,subject:[{digest:{sha256:FIRST_GOOD.subject_sha256}}],
    predicate:sample}),/invalid|untrusted|checkpoint/);
  assert.throws(()=>manifestFromOriginalStatement({predicateType:'other'}));
  assert.throws(()=>pickOriginalBundle({attestations:[]}));
  assert.throws(()=>pickOriginalBundle({attestations:[{bundle_url:'http://127.0.0.1/x'}]}));
  const valid='https://public.blob.core.windows.net/attestations/1.json';
  assert.equal(pickOriginalBundle({attestations:[{bundle_url:valid}]}),valid);
  assert.throws(()=>unpackOriginalEnvelope({dsseEnvelope:{payload:'c2hvcnQ=',signatures:[]}}));
  assert.throws(()=>mainOnly({GITHUB_REPOSITORY:REPO,GITHUB_REF:'refs/heads/evil'}));
  console.log('Original public Rekor baseline is pinned; malformed source, identity, host and DSSE fixtures rejected');
}
async function collect(file){
  mainOnly(process.env);
  try{await verifyReadOnly(file);}
  catch(e){
    if(file&&path.isAbsolute(file)&&!fs.existsSync(file)){
      fs.writeFileSync(file,JSON.stringify({
        schema_version:1,kind:'run_store_original_signed_baseline_history_audit',
        repository:REPO,verdict:'UnverifiedFailClosed',
        audited_main_sha:process.env.GITHUB_SHA,
        audit_run_id:Number(process.env.GITHUB_RUN_ID),
        pinned_external_subject:FIRST_GOOD.subject_sha256,
        alert_reason:String(e.message).slice(0,500),
        no_production_ref_mutation:true,
      },null,2)+'\n',{flag:'wx'});
    }
    throw e;
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{
    if(process.argv[2]==='self-test')selfTest();
    else if(process.argv[2]==='collect')await collect(process.argv[3]);
    else fail('usage: self-test | collect ABS_PATH');
  }catch(e){console.error('::error::Signed Run Store history audit failed closed: '+String(e.message));
    process.exitCode=1;}
}
