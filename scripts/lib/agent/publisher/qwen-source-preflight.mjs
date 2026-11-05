// #2274: main-owned READ-ONLY Qwen Publisher admission. This is the only
// bridge from a signed unprivileged Developer patch into trusted Publisher
// bytes. No Store writer credential, GitHub POST or model call occurs here.
import {verifyWorkerClaimForAck} from '../orchestration/worker-reconcile.mjs';
import {authorizeWorkerFromStore} from '../orchestration/worker-preflight.mjs';
import {validateQwenDevelopmentCandidate}
  from '../orchestration/qwen-development-ingest-candidate.mjs';
import {readCommittedQwenRunReceipt}
  from '../orchestration/qwen-development-commit.mjs';
import {verifyCommittedCheckpoint} from '../store/remote.mjs';
import {preflightAgentPatch} from './patch-preflight.mjs';

const HEX=/^[0-9a-f]{64}$/;
const SHA=/^[0-9a-f]{40}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
function fail(s){throw Error('trusted Qwen Publisher source: '+s);}
export async function preflightTrustedQwenPublisher({
  remote,registry,run,claim,reader,rootKey,
  result,proof,ciphertext,sourceCheckout,
}){
  if(!Buffer.isBuffer(rootKey)||rootKey.length!==32||
      !remote||typeof remote!=='string'||
      typeof sourceCheckout!=='string'||!sourceCheckout.startsWith('/')||
      !run||run.run_attempt!==1||
      !['implement'].includes(claim?.inputs?.task)||
      claim.inputs.agent_id!=='dev-qwen-01')
    fail('missing signed bounded Qwen Publisher request');
  // This verifies the HMAC ticket against the original owner/main issuer,
  // the exact completed bot-owned Worker Run and the original source SHA.
  const signed=await verifyWorkerClaimForAck({
    run,claim,key:rootKey,reader});
  const admission=authorizeWorkerFromStore({remote,registry,
    role:'developer',runId:run.id,input:claim.inputs});
  if(!admission.authorized||
      admission.agent_id!=='dev-qwen-01'||
      admission.provider!=='claude-code'||
      admission.environment!=='dev-claude-qwen'||
      signed.issue!==admission.issue||
      signed.action_id!==admission.action_id||
      signed.source_run_id!==admission.run_id)
    fail('signed Qwen Store ACK differs from authenticated source Run');
  const candidate=validateQwenDevelopmentCandidate({
    admission,run,result,proof,ciphertext});
  const identity=candidate.identity;
  const checkpoint=readCommittedQwenRunReceipt(remote,identity,
    run,admission.action_id,admission.input_sha,candidate.metadata);
  if(!checkpoint||!positive(checkpoint.version)||!SHA.test(checkpoint.commit_sha)||
      !HEX.test(checkpoint.ciphertext_sha256))
    fail('missing exact immutable Qwen Store Run/checkpoint receipt');
  verifyCommittedCheckpoint({remote,identity,
    commit_sha:checkpoint.commit_sha,
    version:checkpoint.version,
    ciphertext_sha256:checkpoint.ciphertext_sha256});
  // The publisher never trusts the model's file list as an authorization
  // grant. It uses an existing protected-path owner, checks original Git
  // source, applies the real Git diff to an isolated disposable copy,
  // verifies actual file contents, and executes none of the source.
  const patch=Buffer.from(candidate.proposal.patch_base64,'base64').toString('utf8');
  const before=preflightAgentPatch({checkout:sourceCheckout,
    source_sha:admission.input_sha,patch,
    allowed_paths:candidate.proposal.changed_paths});
  const changed=before.files.map(file=>file.path).sort();
  if(before.source_sha!==admission.input_sha||
      before.patch_sha256!==candidate.proposal.patch_sha256||
      JSON.stringify(changed)!==JSON.stringify(candidate.proposal.changed_paths)||
      before.files.some(file=>file.operation==='create'))
    fail('applied source Git patch diverges from immutable Developer result');
  const evidence={schema_version:1,
    kind:'trusted_qwen_publisher_preflight_only',
    status:'preflight_only',
    issue:admission.issue,action_id:admission.action_id,
    worker_run_id:run.id,worker_run_attempt:run.run_attempt,
    worker_sha:run.head_sha,
    source_sha:admission.input_sha,
    checkpoint_version:checkpoint.version,
    checkpoint_commit_sha:checkpoint.commit_sha,
    ciphertext_sha256:checkpoint.ciphertext_sha256,
    harness_digest:candidate.metadata.harness_digest,
    native_session_id:candidate.metadata.session_id,
    agent_id:admission.agent_id,
    patch_sha256:before.patch_sha256,
    file_manifest:before.files};
  // The patch is allowed through ONLY as the previously authenticated exact
  // Worker Artifact, never a textual model response. Future Publisher
  // write-ahead intent may use this immutable verification without rerunning
  // Claude Code or granting the Worker GitHub write access.
  return Object.freeze({evidence,patch});
}
