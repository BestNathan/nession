// #2274: one untrusted transport candidate for a bounded Qwen patch and the
// same Run's encrypted Claude-native Session. Never a Publisher/Store writer.
import {createHash} from 'node:crypto';
import {discoverClaudeNativeProject,sealClaudeNativeSession}
  from '../providers/claude-native-store.mjs';
const SHA=/^[a-f0-9]{40}$/,HEX=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=x=>createHash('sha256').update(x).digest('hex');
const positive=x=>Number.isSafeInteger(x)&&x>0;
function fail(s){throw Error('Qwen Developer evidence: '+s);}
export function assertQwenModelHasNoStoreAuthority(env){
  for(const k of ['STORE_APP_TOKEN','STORE_WRITER_PRIVATE_KEY',
    'ACTIONS_DISPATCH_TOKEN','AGENT_STORE_CONTROLLER_REMOTE','GITHUB_TOKEN',
    'GH_TOKEN','STAGING_STORE_AES_KEY_B64','STAGING_DISPATCH_KEY',
    'QWEN_RESUME_PRIVATE_KEY_B64','CURSOR_RESUME_PRIVATE_KEY_B64'])
    if(env?.[k])fail('privileged credential in model Worker');
}
// Caller owns signed GitHub/Store admission and independently verified Git
// diff. The trusted Store ingester MUST re-authenticate before publication.
export function sealQwenDevelopmentProposal({
  admission,snapshot,patch,sessionId,configDir,publicKeyPem,runAttempt=1,
}){
  const plan=snapshot?.plan;
  if(admission?.authorized!==true||admission.role!=='developer'||
      !['implement','repair'].includes(admission.task)||
      admission.agent_id!=='dev-qwen-01'||admission.provider!=='claude-code'||
      admission.environment!=='dev-claude-qwen'||
      plan?.agent_id!==admission.agent_id||
      plan.provider!==admission.provider||
      plan.environment!==admission.environment||
      plan.source_sha!==admission.input_sha||
      !SHA.test(plan.source_sha??'')||!HEX.test(plan.harness_digest??'')||
      !HEX.test(admission.action_id??'')||
      !positive(admission.issue)||!positive(admission.run_id)||!positive(runAttempt)||
      patch?.kind!=='qwen_developer_bounded_patch'||
      patch.source_sha!==plan.source_sha||
      patch.agent_id!==plan.agent_id||
      patch.provider!==plan.provider||
      patch.harness_digest!==plan.harness_digest||
      !Array.isArray(patch.paths)||patch.paths.length<1||patch.paths.length>8||
      typeof patch.patch!=='string'||!patch.patch.length||
      Buffer.byteLength(patch.patch)>32*1024||
      patch.patch_bytes!==Buffer.byteLength(patch.patch)||
      patch.patch_sha256!==hash(patch.patch)||
      !UUID.test(sessionId??'')||typeof configDir!=='string'||
      typeof snapshot.workspace!=='string')
    fail('unbound native Session or proposed source patch');
  const projectKey=discoverClaudeNativeProject(configDir,sessionId);
  const metadata={session_id:sessionId,source_sha:plan.source_sha,
    harness_digest:plan.harness_digest,project_key:projectKey,
    cwd_sha256:hash(snapshot.workspace),run_id:admission.run_id,
    attempt:runAttempt,cli_version:plan.cli_version};
  const ciphertext=sealClaudeNativeSession({configDir,metadata,publicKeyPem});
  const origin={issue:admission.issue,action_id:admission.action_id,
    source_sha:plan.source_sha,run_id:admission.run_id,attempt:runAttempt};
  const proof={schema_version:1,kind:'qwen_developer_native_checkpoint_candidate',
    ...origin,metadata,ciphertext_sha256:ciphertext.ciphertext_sha256,
    patch_sha256:patch.patch_sha256,patch_bytes:patch.patch_bytes,
    changed_paths:patch.paths,provider:plan.provider,agent_id:plan.agent_id,
    environment:plan.environment,model:plan.model};
  const result={schema_version:1,kind:'qwen_developer_patch_proposal',
    ...origin,status:'proposed_not_published',provider:plan.provider,
    agent_id:plan.agent_id,environment:plan.environment,model:plan.model,
    native_session_id:sessionId,native_resumed:admission.resume_from!=null,
    native_read_edit_verified:true,patch_sha256:patch.patch_sha256,
    patch_base64:Buffer.from(patch.patch,'utf8').toString('base64'),
    changed_paths:patch.paths,ciphertext_sha256:ciphertext.ciphertext_sha256};
  return Object.freeze({ciphertext,proof,result});
}
