// #2274: immutable Qwen Developer provider admission, before any model call.
// An Agent ID is an allowlisted capability, not a model/secret supplied by an Issue.
// This does not authorize execution by itself: Worker preflight must already have
// authenticated the exact signed Outbox action against the committed Store.
import {createHash} from 'node:crypto';

const SHA=/^[a-f0-9]{40}$/;
const HEX=/^[a-f0-9]{64}$/;
const QWEN=/^qwen[a-z0-9._-]*$/i;
const VERSION=/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][0-9a-f]{3}-[a-f0-9]{12}$/i;
const TOOLS=Object.freeze(['Read','Edit','Write']);
function fail(message){throw Error('Qwen Developer policy: '+message);}
function checksum(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}

export function qwenDeveloperModel(env){
  const selected=env?.ANTHROPIC_MODEL;
  if(typeof selected!=='string'||!QWEN.test(selected))
    fail('selected Environment must explicitly declare a Qwen ANTHROPIC_MODEL');
  return selected;
}

export function qwenGatewayEndpoint(env){
  const raw=env?.ANTHROPIC_BASE_URL;
  if(typeof raw!=='string'||raw.length>1024)fail('missing or invalid Qwen endpoint');
  let url;
  try{url=new URL(raw);}catch{fail('malformed Qwen endpoint');}
  if(url.protocol!=='https:'||!url.hostname||url.username||url.password||
      url.search||url.hash||raw!==url.href&&raw!==url.href.slice(0,-1))
    fail('Qwen endpoint must be a canonical HTTPS URL without credentials or query');
  if(!env.ANTHROPIC_AUTH_TOKEN&&!env.ANTHROPIC_API_KEY)
    fail('missing selected Environment Gateway credentials; no provider fallback');
  return url.href;
}

export function bindQwenDeveloper(admission,registry,environment,{
  cliVersion, model, endpoint,
}={}) {
  if(!admission||admission.authorized!==true||admission.role!=='developer'||
      !['implement','repair'].includes(admission.task)||
      !Number.isSafeInteger(admission.issue)||admission.issue<1||
      !SHA.test(admission.input_sha??'')||
      !Number.isSafeInteger(admission.run_id)||admission.run_id<1||
      !HEX.test(admission.action_id??''))
    fail('missing signed Store-backed Developer admission');
  const agent=registry?.instances?.[admission.agent_id];
  if(!agent||agent.role!=='developer'||agent.provider!=='claude-code'||
      agent.environment!=='dev-claude-qwen'||
      admission.provider!==agent.provider||
      admission.environment!==agent.environment)
    fail('registered Qwen Developer role/provider/Environment mismatch');
  if(typeof cliVersion!=='string'||!VERSION.test(cliVersion))
    fail('Claude Code version must be pinned, never latest');
  const selectedModel=qwenDeveloperModel(environment);
  const selectedEndpoint=qwenGatewayEndpoint(environment);
  if(model!=null&&model!==selectedModel)fail('model differs from selected Environment');
  if(endpoint!=null&&endpoint!==selectedEndpoint)fail('endpoint differs from selected Environment');
  // The same model and Endpoint must be present for future encrypted native
  // Resume. No credential or Issue content is ever included in this digest.
  // The native Session survives source-SHA changes at a Reviewer repair
  // boundary. Source identity is authenticated separately by the signed
  // Outbox ticket and committed checkpoint, while this digest pins exactly
  // the Provider, model, gateway, CLI, tools and isolation compatibility.
  const harnessDigest=checksum({
    schema_version:1,role:'developer',provider:'claude-code',
    agent_id:admission.agent_id,environment:agent.environment,
    model:selectedModel,endpoint:selectedEndpoint,cli_version:cliVersion,
    tools:TOOLS,native_format:'claude-jsonl-v1',sandbox:'docker-v1',
  });
  return Object.freeze({
    provider:'claude-code',agent_id:admission.agent_id,
    environment:agent.environment,source_sha:admission.input_sha,
    model:selectedModel,cli_version:cliVersion,harness_digest:harnessDigest,
    tools:TOOLS,readonly_program:true,
  });
}

// The caller has already authenticated the exact signed Outbox resume_from
// and immutable Store commitment. This is the Provider-native *compatibility*
// check before decrypt/CLI, not an alternative source of checkpoint authority.
export function verifyQwenNativeContinuation(admission,plan,metadata){
  const origin=admission?.resume_from;
  const shape=(value,keys)=>value&&typeof value==='object'&&
    !Array.isArray(value)&&Object.keys(value).sort().join(',')===
      [...keys].sort().join(',');
  const positive=n=>Number.isSafeInteger(n)&&n>0;
  const repair=admission?.task==='repair';
  const validOrigin=repair?shape(origin,[
    'checkpoint_version','checkpoint_commit_sha','ciphertext_sha256',
    'source_sha','source_run_id']):shape(origin,[
    'parent_action_id','ordinal','checkpoint_version',
    'checkpoint_commit_sha','ciphertext_sha256']);
  if(admission?.authorized!==true||admission.role!=='developer'||
      !['implement','repair'].includes(admission.task)||
      admission.agent_id!==plan?.agent_id||
      admission.provider!=='claude-code'||plan.provider!=='claude-code'||
      admission.environment!==plan.environment||
      admission.input_sha!==plan.source_sha||
      !validOrigin||!positive(origin.checkpoint_version)||
      !SHA.test(origin.checkpoint_commit_sha??'')||
      !HEX.test(origin.ciphertext_sha256??'')||
      (repair?(!SHA.test(origin.source_sha??'')||
        origin.source_sha===plan.source_sha||
        !positive(origin.source_run_id)):
        (!HEX.test(origin.parent_action_id??'')||
          !positive(origin.ordinal)))||
      !metadata||!UUID.test(metadata.session_id??'')||
      !positive(metadata.run_id)||!positive(metadata.attempt)||
      metadata.source_sha!==(repair?origin.source_sha:plan.source_sha)||
      (repair&&metadata.run_id!==origin.source_run_id)||
      metadata.harness_digest!==plan.harness_digest||
      metadata.cli_version!==plan.cli_version)
    fail('incompatible or unbound native Session resume');
  // A prior task's source SHA is retained for provenance on repair. The new
  // target SHA remains the independently signed current admission input.
  return Object.freeze({session_id:metadata.session_id,
    source_sha:metadata.source_sha,target_sha:plan.source_sha,
    harness_digest:plan.harness_digest});
}
