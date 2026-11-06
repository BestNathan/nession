// #2274: trusted, credentialed *pre-CAS* Qwen Developer artifact verifier.
// Caller MUST independently authenticate GitHub Run + ZIP digest, signed
// dispatch ticket, and committed Outbox ACK. Never invoke this in a model job.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openClaudeNativeSession} from '../providers/claude-native-store.mjs';
import {sealCheckpoint} from '../store/checkpoint.mjs';

const SHA=/^[a-f0-9]{40}$/,HEX=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MODEL=/^qwen[a-z0-9._-]*$/i;
const FILE=/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;
const WORKFLOW='.github/workflows/agent-develop.yml';
const MAX_PATCH=32*1024;
// The existing Store permits at most 16 MiB of outer encrypted payload.
// Since the inner RSA ciphertext is base64-wrapped into that AES payload,
// cap its raw bytes so a verified candidate can actually be persisted.
const MAX_NATIVE_CIPHER=10*1024*1024;
const digest=data=>createHash('sha256').update(data).digest('hex');
const positive=x=>Number.isSafeInteger(x)&&x>0;
function fail(x){throw Error('trusted Qwen Developer candidate: '+x);}
function exact(obj,fields){
  return obj&&typeof obj==='object'&&!Array.isArray(obj)&&
    Object.keys(obj).length===fields.length&&
    Object.keys(obj).every(k=>fields.includes(k));
}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function safePaths(paths){
  if(!Array.isArray(paths)||paths.length<1||paths.length>8||
      paths.some(p=>typeof p!=='string'||p.length>240||!FILE.test(p)||
        p.split('/').some(x=>['.','..','.git','.github','.claude',
          'node_modules'].includes(x)))||
      new Set(paths).size!==paths.length||
      paths.join('\0')!==[...paths].sort().join('\0'))
    fail('invalid proposed file allowlist');
}
const ORIGIN=['issue','action_id','source_sha','run_id','attempt'];
const META=['session_id','source_sha','harness_digest','project_key',
  'cwd_sha256','run_id','attempt','cli_version'];
const PROOF=['schema_version','kind',...ORIGIN,'metadata','ciphertext_sha256',
  'patch_sha256','patch_bytes','changed_paths','provider','agent_id',
  'environment','model'];
const RESULT=['schema_version','kind',...ORIGIN,'status','provider','agent_id',
  'environment','model','native_session_id','native_resumed',
  'native_read_edit_verified','patch_sha256','patch_base64',
  'changed_paths','ciphertext_sha256'];
const ENVELOPE=['schema_version','kind','metadata','encryption',
  'ciphertext','ciphertext_sha256'];
const ENC=['algorithm','iv','tag','wrapped_key'];

// Source authorization must come from the verified Store, not an Artifact
// claiming its own admission. This routine checks the *bound payload* only.
export function validateQwenDevelopmentCandidate({
  admission,run,result,proof,ciphertext,
}){
  if(admission?.authorized!==true||admission.role!=='developer'||
      admission.agent_id!=='dev-qwen-01'||admission.provider!=='claude-code'||
      admission.environment!=='dev-claude-qwen'||
      !['implement','repair'].includes(admission.task)||
      !positive(admission.issue)||!HEX.test(admission.action_id??'')||
      !SHA.test(admission.input_sha??'')||!positive(admission.run_id)||
      run?.id!==admission.run_id||run.run_attempt!==1||
      run.status!=='completed'||run.conclusion!=='success'||
      run.name!=='Agent / Development'||run.path!==WORKFLOW||
      run.event!=='workflow_dispatch'||run.head_branch!=='main'||
      run.repository?.full_name!=='BestNathan/nession'||
      run.head_repository?.full_name!=='BestNathan/nession'||
      run.actor?.login!=='github-actions[bot]'||
      !SHA.test(run.head_sha??''))
    fail('no authenticated successful exact-Run Developer admission');
  if(!exact(result,RESULT)||!exact(proof,PROOF)||
      !exact(proof.metadata,META)||!exact(ciphertext,ENVELOPE)||
      !exact(ciphertext.encryption,ENC)||
      result.schema_version!==1||proof.schema_version!==1||
      result.kind!=='qwen_developer_patch_proposal'||
      proof.kind!=='qwen_developer_native_checkpoint_candidate'||
      ciphertext.schema_version!==1||
      ciphertext.kind!=='claude-native-encrypted-snapshot'||
      result.status!=='proposed_not_published'||
      result.native_read_edit_verified!==true||
      result.native_resumed!==(admission.resume_from!=null)||
      !UUID.test(result.native_session_id??'')||
      !MODEL.test(proof.model??'')||!MODEL.test(result.model??''))
    fail('unsupported Developer artifact format or provider claim');
  const expected={issue:admission.issue,action_id:admission.action_id,
    source_sha:admission.input_sha,run_id:run.id,attempt:run.run_attempt};
  for(const [k,v] of Object.entries(expected))
    if(result[k]!==v||proof[k]!==v)fail('cross-Action/Run/source candidate replay');
  for(const key of ['provider','agent_id','environment','model'])
    if(result[key]!==proof[key]||
       (key!=='model'&&result[key]!==admission[key]))
      fail('candidate provider/Agent identity mismatch');
  const meta=proof.metadata;
  if(meta.session_id!==result.native_session_id||
      meta.source_sha!==expected.source_sha||
      meta.run_id!==expected.run_id||meta.attempt!==expected.attempt||
      !HEX.test(meta.harness_digest??'')||
      !HEX.test(meta.cwd_sha256??'')||
      !/^[A-Za-z0-9._-]{1,240}$/.test(meta.project_key??'')||
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(meta.cli_version??'')||
      !same(meta,ciphertext.metadata))
    fail('native Session provenance differs from authenticated source');
  const patchRaw=result.patch_base64;
  if(typeof patchRaw!=='string'||patchRaw.length<1||
      patchRaw.length>Math.ceil(MAX_PATCH/3)*4)
    fail('missing or oversized bounded proposed patch');
  const patch=Buffer.from(patchRaw,'base64');
  if(patch.toString('base64')!==patchRaw||!patch.length||
      patch.length>MAX_PATCH||patch.includes(0)||
      patch.toString('utf8').includes('\ufffd')||
      result.patch_sha256!==digest(patch)||proof.patch_sha256!==digest(patch)||
      proof.patch_bytes!==patch.length||
      !HEX.test(result.patch_sha256??''))
    fail('noncanonical, mismatched or unsafe proposed patch');
  safePaths(proof.changed_paths);
  // Independently inspect every Git diff header; a forged result may not
  // claim "hello.js" while smuggling an edit of "other.js" in the patch.
  // The trusted Publisher must still Git-apply/validate the exact source.
  const patchText=patch.toString('utf8');
  const headerPaths=[...patchText.matchAll(/^diff --git a\/([^\n]+) b\/([^\n]+)$/gm)]
    .map(m=>{
      if(m[1]!==m[2])fail('renamed or mismatched patch paths');
      return m[1];
    });
  if(headerPaths.length!==proof.changed_paths.length||
      !same([...headerPaths].sort(),proof.changed_paths))
    fail('proposed Git patch does not match attested changed paths');
  if(!same(result.changed_paths,proof.changed_paths)||
      result.ciphertext_sha256!==ciphertext.ciphertext_sha256||
      proof.ciphertext_sha256!==ciphertext.ciphertext_sha256||
      !HEX.test(ciphertext.ciphertext_sha256??''))
    fail('patch manifest or encrypted Session digest mismatch');
  const encrypted=Buffer.from(ciphertext.ciphertext??'','base64');
  if(!encrypted.length||encrypted.length>MAX_NATIVE_CIPHER||
      encrypted.toString('base64')!==ciphertext.ciphertext||
      digest(encrypted)!==ciphertext.ciphertext_sha256)
    fail('invalid encrypted native Session bytes');
  // The Publisher still independently verifies the patch against the
  // expected Git source and selected Task. This does not publish anything.
  return Object.freeze({identity:{role:'developer',
    agent_id:admission.agent_id,issue:admission.issue},
    metadata:{provider:'claude-code',session_id:meta.session_id,
      source_sha:meta.source_sha,harness_digest:meta.harness_digest},
    proposal:{source_sha:expected.source_sha,
      patch_sha256:result.patch_sha256,changed_paths:[...result.changed_paths],
      patch_base64:patchRaw},native_metadata:meta});
}

// Authenticate the RSA/AES-GCM native JSONL before Store publication. Rewrap
// only ciphertext into the existing Store's AES-GCM checkpoint; the provider
// private key and Store key never cross into the Worker or model invocation.
export function sealQwenCandidateForStore({
  admission,run,result,proof,ciphertext,privateKeyPem,storeKey,nextVersion,
}){
  const bound=validateQwenDevelopmentCandidate({
    admission,run,result,proof,ciphertext});
  if(!Buffer.isBuffer(storeKey)||storeKey.length!==32||
      !positive(nextVersion)||typeof privateKeyPem!=='string')
    fail('trusted Store/Resume key or checkpoint version unavailable');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'trusted-qwen-session-'));
  let native;
  try{
    const restored=path.join(temp,'restored');
    const opened=openClaudeNativeSession({record:ciphertext,privateKeyPem,
      expected:proof.metadata,configDir:restored});
    if(opened.session_id!==bound.metadata.session_id)
      fail('native Session restoration changed UUID');
    // The original RSA envelope is retained as the native payload.
    // The future trusted pre-model restore uses openClaudeNativeSession;
    // no reconstructed transcript or plaintext ever enters the Store.
    native=Buffer.from(JSON.stringify({schema_version:1,
      kind:'qwen-claude-native-envelope',
      rsa_envelope:ciphertext,metadata:proof.metadata,
      patch_sha256:bound.proposal.patch_sha256,
      action_id:admission.action_id,run_id:run.id,attempt:run.run_attempt}));
    const sealed=sealCheckpoint(bound.identity,nextVersion,native,
      storeKey,bound.metadata);
    return Object.freeze({sealed,identity:bound.identity,
      metadata:bound.metadata,proposal:bound.proposal});
  }finally{
    native?.fill(0);
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
