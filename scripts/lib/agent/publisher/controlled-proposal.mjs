import {createHash} from 'node:crypto';
import {preflightAgentPatch} from './patch-preflight.mjs';

const SHA40=/^[a-f0-9]{40}$/;
const SHA64=/^[a-f0-9]{64}$/;
const ZIP_SHA=/^sha256:[a-f0-9]{64}$/;
const FIXTURE_PATH='e2e/fixtures/agent-development/1997-canary.txt';
const FIXTURE_CONTENT='Durable Worker fixture: complete\nPrevious value: pending\n';
function deny(reason){throw Error('Trusted Publisher proposal: '+reason);}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const positive=x=>Number.isSafeInteger(x)&&x>0;
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
function bound(value,expected,label){
  if(value!==expected)deny('mismatched '+label);
}
function safeContent(value){
  if(typeof value!=='string'||value.length===0||
     Buffer.byteLength(value)>128*1024||/[\r\0]/.test(value)||
     !value.endsWith('\n')||value.slice(0,-1).split('\n').length>256)
    deny('unsafe trusted file bytes');
  return Buffer.from(value,'utf8');
}
// This is a pure, credential-free generator, not a GitHub Publisher.
// The policy is MAIN-owned and must be constructed from independently verified
// GitHub Run/Artifact + linear Store readback, not Worker JSON or PR text.
export function prepareBoundedPublisherProposal({checkout,policy,result,receipt}){
  if(!plain(policy)||!plain(result)||!plain(receipt)||
     policy.issue!==1997||policy.file!==FIXTURE_PATH||
     policy.content!==FIXTURE_CONTENT||!SHA40.test(policy.source_sha??'')||
     !SHA40.test(policy.worker_sha??'')||
     !SHA40.test(policy.parent_checkpoint_commit_sha??'')||
     !SHA40.test(policy.checkpoint_commit_sha??'')||
     !SHA40.test(policy.ingester_sha??'')||
     !SHA64.test(policy.action_id??'')||
     !SHA64.test(policy.checkpoint_ciphertext_sha256??'')||
     !positive(policy.run_id)||!positive(policy.attempt)||
     !positive(policy.checkpoint_version)||!positive(policy.ingester_run_id))
    deny('invalid MAIN-owned bounded fixture policy');
  const bytes=safeContent(policy.content);
  if(result.schema_version!==1||result.kind!=='developer_proposal'||
     result.status!=='proposed_not_published'||
     result.native_read_edit_verified!==true||
     result.native_resumed!==true||result.prior_turn_word_observed!==true||
     !plain(result.issue_sync)||!SHA64.test(result.issue_sync.body_sha256??'')||
     !SHA64.test(result.issue_sync.comments_sha256??''))
    deny('no proven native resumed Developer edit');
  for(const [key,expected] of [
    ['issue',policy.issue],['action_id',policy.action_id],
    ['source_sha',policy.source_sha],['run_id',policy.run_id],
    ['attempt',policy.attempt],['file',policy.file],
    ['parent_checkpoint_commit_sha',policy.parent_checkpoint_commit_sha],
    ['content_sha256',digest(bytes)],
  ])bound(result[key],expected,'Developer result '+key);
  if(receipt.schema_version!==1||
     receipt.kind!=='authenticated_development_checkpoint_receipt'||
     !['yielded','replayed'].includes(receipt.status)||
     !positive(receipt.claim_artifact_id)||!positive(receipt.result_artifact_id)||
     !ZIP_SHA.test(receipt.claim_artifact_digest??'')||
     !ZIP_SHA.test(receipt.result_artifact_digest??'')||
     !SHA64.test(receipt.harness_digest??'')||
     !/^agent-[A-Za-z0-9-]{4,100}$/.test(receipt.session_id??''))
    deny('missing trusted encrypted checkpoint and immutable Artifact attestation');
  for(const [key,expected] of [
    ['issue',policy.issue],['action_id',policy.action_id],
    ['run_id',policy.run_id],['attempt',policy.attempt],
    ['worker_sha',policy.worker_sha],['source_sha',policy.source_sha],
    ['ingester_run_id',policy.ingester_run_id],['ingester_sha',policy.ingester_sha],
    ['checkpoint_version',policy.checkpoint_version],
    ['checkpoint_commit_sha',policy.checkpoint_commit_sha],
    ['ciphertext_sha256',policy.checkpoint_ciphertext_sha256],
  ])bound(receipt[key],expected,'trusted checkpoint receipt '+key);
  // No edit bytes are copied from model JSON. A trusted policy holds the exact
  // expected public canary bytes; the real Worker had already verified them
  // before sealing native state and emitting its SHA256 result.
  const data=bytes.toString('utf8').slice(0,-1).split('\n');
  const blobSha=createHash('sha1').update(Buffer.concat([
    Buffer.from('blob '+bytes.length+'\0','utf8'),bytes,
  ])).digest('hex');
  const file=policy.file;
  const patch=[
    'diff --git a/'+file+' b/'+file,
    'new file mode 100644',
    'index 0000000..'+blobSha.slice(0,7),
    '--- /dev/null',
    '+++ b/'+file,
    '@@ -0,0 +1,'+data.length+' @@',
    ...data.map(line=>'+'+line),
    '',
  ].join('\n');
  const preflight=preflightAgentPatch({
    checkout,source_sha:policy.source_sha,patch,
    allowed_paths:[file],create_paths:[file],
  });
  if(preflight.files.length!==1||
     preflight.files[0].path!==file||
     preflight.files[0].operation!=='create'||
     preflight.files[0].new_sha256!==digest(bytes)||
     preflight.files[0].old_sha256!==null)
    deny('preflight disagrees with trusted Developer content digest');
  return {
    schema_version:1,kind:'trusted_publisher_preflight_only',
    issue:policy.issue,action_id:policy.action_id,
    worker_run_id:policy.run_id,worker_run_attempt:policy.attempt,
    source_sha:policy.source_sha,checkpoint_commit_sha:policy.checkpoint_commit_sha,
    checkpoint_version:policy.checkpoint_version,
    source_result_sha256:result.content_sha256,
    patch_sha256:preflight.patch_sha256,
    preflight,patch,
    // No PR number, branch name or publication outcome is asserted here.
    status:'preflight_only',
  };
}
