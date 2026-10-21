import {createHash} from 'node:crypto';
import {preflightAgentPatch} from './patch-preflight.mjs';

const SHA40=/^[a-f0-9]{40}$/;
const SHA64=/^[a-f0-9]{64}$/;
const ZIP_SHA=/^sha256:[a-f0-9]{64}$/;
const FIXTURE_PATH='e2e/fixtures/agent-development/1997-canary.txt';
const FIXTURE_CONTENT='Durable Worker fixture: complete\nPrevious value: pending\n';
export const CONTROLLED_1997_POLICY=Object.freeze({
  issue:1997,
  action_id:'dac10d570c30557fe629b8605ecb44d33335eb967e24a52931467ac7b93b5e31',
  run_id:39448549052,attempt:1,
  worker_sha:'271b48e494b6bd54843403b831709d6365f30530',
  source_sha:'220266b9233ec97b1beacbc54e5cc7f82d3cece2',
  file:FIXTURE_PATH,content:FIXTURE_CONTENT,
  parent_checkpoint_commit_sha:'f9abdeca3cc26780fb0a7b2ed7000d2dd28cf142',
  checkpoint_version:3,
  checkpoint_commit_sha:'eb891ee2154d02ddb758d50f0f694e70a343ffdf',
  checkpoint_ciphertext_sha256:'7afed3f229d371b850fda3fcc77fb0f601f2c588ccab6210d878b2f7501321a0',
  native_session_id:'agent-7d5b4a61-1476-4ce7-a38a-82907aa3b1a6',
  harness_digest:'ba54d9fb8b8ab9ec6ca2ac17727b02db21176437a2258123b753977fd32bbf68',
  ingester_run_id:39465467460,ingester_attempt:1,
  ingester_sha:'72ae0f9b9ecfcb469094c8b05dab129f75a3869c',
  claim_artifact_id:12276388775,
  claim_artifact_digest:'sha256:3d125a1d0c4ba508a5067ee95c10042394c48934ab548a23d31ae4266415c6c6',
  result_artifact_id:12275629206,
  result_artifact_digest:'sha256:a2ba4d173805e3aba61af4419790c73444a34931843d63f9b12782b78c5fe61d',
  workflow_state_version:16,
  workflow_commit_sha:'cdf5ca4b2b7ebecc95062847763b8672a575e65c',
});
// The real controlled Publisher must use this immutable main-owned policy,
// never construct equivalent authority from model JSON, PR body or Issue text.
export function prepareControlled1997PublisherProposal({checkout,result,receipt}){
  return prepareBoundedPublisherProposal({
    checkout,policy:CONTROLLED_1997_POLICY,result,receipt,
  });
}
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
     !SHA64.test(policy.harness_digest??'')||
     !/^agent-[A-Za-z0-9-]{4,100}$/.test(policy.native_session_id??'')||
     !SHA40.test(policy.workflow_commit_sha??'')||
     !ZIP_SHA.test(policy.claim_artifact_digest??'')||
     !ZIP_SHA.test(policy.result_artifact_digest??'')||
     !positive(policy.claim_artifact_id)||!positive(policy.result_artifact_id)||
     !positive(policy.workflow_state_version)||!positive(policy.ingester_attempt)||
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
    ['ingester_attempt',policy.ingester_attempt],
    ['checkpoint_version',policy.checkpoint_version],
    ['checkpoint_commit_sha',policy.checkpoint_commit_sha],
    ['ciphertext_sha256',policy.checkpoint_ciphertext_sha256],
    ['session_id',policy.native_session_id],['harness_digest',policy.harness_digest],
    ['claim_artifact_id',policy.claim_artifact_id],
    ['claim_artifact_digest',policy.claim_artifact_digest],
    ['result_artifact_id',policy.result_artifact_id],
    ['result_artifact_digest',policy.result_artifact_digest],
    ['workflow_state_version',policy.workflow_state_version],
    ['workflow_commit_sha',policy.workflow_commit_sha],
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
