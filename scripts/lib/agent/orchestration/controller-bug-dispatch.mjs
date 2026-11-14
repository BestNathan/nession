#!/usr/bin/env node
// #3488: after independently authenticated Store initialization, send the
// one pending real Bug Developer Action through existing Store CAS dispatch.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { executeDurableAgentDispatch } from './dispatch-store.mjs';
import { deriveDispatchKey, sourceAllowed } from './controller-dispatch.mjs';

const REPO = 'BestNathan/nession';
const HEX40=/^[a-f0-9]{40}$/, HEX64=/^[a-f0-9]{64}$/;
function reject(x){throw Error('trusted Bug Developer dispatcher: '+x);}
const positive=x=>Number.isSafeInteger(x)&&x>0;
function inspect(source,root,upstream) {
  const run=source?.run,req=source?.request;
  if(source?.schema_version!==1||source.kind!=='agent_controller_start_request'||
      !run||run.actor!=='github-actions[bot]'||
      run.event!=='workflow_dispatch'||run.ref!=='refs/heads/main'||
      run.repository!==REPO||run.workflow!=='Acceptance / Agent Controller'||
      run.workflow_path!=='.github/workflows/acceptance-agent-controller.yml'||
      !positive(run.source_comment_id)||
      !upstream||upstream.id!==run.run_id||upstream.run_attempt!==1||
      upstream.head_sha!==run.head_sha||upstream.head_branch!=='main'||
      upstream.conclusion!=='success'||upstream.actor?.login!=='github-actions[bot]'||
      req?.issue!==root?.issue||!positive(req.issue)||!HEX40.test(req.sha??'')||
      req.sha!==run.head_sha||req.developer!=='dev-qwen-01'||
      req.reviewer!=='review-qwen-01'||req.acceptor!=='accept-qwen-01'||
      root.created!==true||root.replayed!==false||
      root.version!==1||!HEX40.test(root.commit_sha??'')||
      !HEX64.test(root.first_action_id??''))
    reject('Source Run/Comment, immutable Store root or selected Qwen Developer mismatched');
  return { issue:req.issue, actionId:root.first_action_id };
}
function readJson(file) {
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>64*1024)
    reject('unsafe authenticated Controller file');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
export async function dispatchAuthenticatedBug({source,root,event,sourceRun,remote,token,privateKey,
  registry,issuerRunId,dispatch=executeDurableAgentDispatch}) {
  const {issue,actionId}=inspect(source,root,sourceRun ?? event?.workflow_run);
  if(!positive(issuerRunId)||typeof remote!=='string'||
      !remote.startsWith('https://x-access-token:')||
      !remote.endsWith('@github.com/'+REPO+'.git')||
      !token||!privateKey)
    reject('requires Store Ingest scoped Apps and trusted Actions writer');
  const key=deriveDispatchKey(privateKey);
  try {
    const result=await dispatch({remote,issue,actionId,registry,
      signer:{key,key_id:'main-controller',issuer_run_id:issuerRunId,
        now:Date.now(),ttl_ms:600000},actionsToken:token,
      sourceVerifier:(sha,role,task,context)=>
        sourceAllowed(sha,role,{task,context})});
    if(!['dispatched','ambiguous','reconcile','replayed'].includes(result.status))
      reject('unexpected trusted dispatch outcome');
    return {issue,action_id:actionId,status:result.status,
      ...(result.source_run_id?{run_id:result.source_run_id}:{}),
      ...(result.state_version?{state_version:result.state_version}:{})};
  }finally{key.fill(0);}
}
async function main() {
  const env=process.env;
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPO||
      !['workflow_run','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)||
      env.GITHUB_WORKFLOW!=='Store / Agent Controller Ingest'||
      env.GITHUB_REF!=='refs/heads/main'||!positive(Number(env.GITHUB_RUN_ID))||
      Number(env.GITHUB_RUN_ATTEMPT)!==1)
    reject('trusted main Store Ingest only');
  if(process.argv.length!==5||process.argv[2]!=='dispatch')
    reject('usage: dispatch AUTHENTICATED-REQUEST ROOT-RESULT');
  const source=readJson(process.argv[3]),root=readJson(process.argv[4]);
  const event=readJson(env.GITHUB_EVENT_PATH);
  // Independently fetched GH REST source, already verified by
  // controller-request.mjs verify-source BEFORE any Store App token was minted.
  const sourceRun=env.CONTROLLER_SOURCE_RUN_FILE
    ?readJson(env.CONTROLLER_SOURCE_RUN_FILE):event.workflow_run;
  if(env.GITHUB_EVENT_NAME==='workflow_dispatch'&&!env.CONTROLLER_SOURCE_RUN_FILE)
    reject('bot wake requires authenticated Controller source Run file');
  const registry=readJson('automation/agents/registry.json');
  const outcome=await dispatchAuthenticatedBug({
    source,root,event,sourceRun,registry,
    remote:env.AGENT_STORE_CONTROLLER_REMOTE,
    token:env.ACTIONS_DISPATCH_TOKEN,privateKey:env.STORE_WRITER_PRIVATE_KEY,
    issuerRunId:Number(env.GITHUB_RUN_ID)});
  console.log(JSON.stringify(outcome));
}
if(process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1]))
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
