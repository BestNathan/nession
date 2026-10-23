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
  const harnessDigest=checksum({
    schema_version:1,role:'developer',provider:'claude-code',
    agent_id:admission.agent_id,environment:agent.environment,
    source_sha:admission.input_sha,model:selectedModel,
    endpoint:selectedEndpoint,cli_version:cliVersion,tools:TOOLS,
    native_format:'claude-jsonl-v1',sandbox:'docker-v1',
  });
  return Object.freeze({
    provider:'claude-code',agent_id:admission.agent_id,
    environment:agent.environment,source_sha:admission.input_sha,
    model:selectedModel,cli_version:cliVersion,harness_digest:harnessDigest,
    tools:TOOLS,readonly_program:true,
  });
}

export function verifyQwenNativeContinuation(admission,plan,metadata){
  if(!admission?.resume_from||!plan||!metadata||
      plan.provider!=='claude-code'||plan.agent_id!==admission.agent_id||
      plan.source_sha!==admission.input_sha||
      metadata.source_sha!==plan.source_sha||
      metadata.harness_digest!==plan.harness_digest||
      metadata.cli_version!==plan.cli_version||
      !UUID.test(metadata.session_id??''))
    fail('incompatible or unbound native Session resume');
  // Resume keeps the exact native UUID and original provenance; never reseed
  // a fresh conversation to impersonate a resumed, committed one.
  return Object.freeze({session_id:metadata.session_id,
    source_sha:plan.source_sha,harness_digest:plan.harness_digest});
}
