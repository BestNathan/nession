#!/usr/bin/env node
// #2010. Real, tightly scoped Developer proof with encrypted SDK-native Session.
// Run ONLY after trusted Store-backed admission. This sandbox receives a
// Provider key, never Git Writer/Controller/Publisher credentials. Untrusted
// model edits are evidence/proposals, NOT accepted commits or PRs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {runCursorSession} from '../providers/cursor.mjs';
import {sealCursorNativeStore} from '../providers/cursor-native-store.mjs';
import {buildAgentWorkflowTelemetry,writeAgentWorkflowTelemetry} from '../../../agent-workflow-telemetry.mjs';

const REPO='BestNathan/nession',HEX40=/^[a-f0-9]{40}$/;
const sha=s=>createHash('sha256').update(s).digest('hex');
function fail(s){throw Error('bounded Developer: '+s);}
function git(...args){return execFileSync('git',args,{encoding:'utf8',timeout:45000,
  maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']}).trim();}
function readAdmission(file){
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>8192)fail('unsafe verified admission');
  const a=JSON.parse(fs.readFileSync(file,'utf8'));
  if(a?.authorized!==true||a.role!=='developer'||a.task!=='implement'||
      a.provider!=='cursor'||a.agent_id!=='dev-cursor-01'||
      a.issue!==1997||a.action_id!==
        '95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae'||
      !HEX40.test(a.input_sha??'')||a.input_sha!=='220266b9233ec97b1beacbc54e5cc7f82d3cece2'||
      Number(process.env.GITHUB_RUN_ID)!==a.run_id||
      process.env.GITHUB_REPOSITORY!==REPO||
      process.env.GITHUB_WORKFLOW!=='Agent / Development'||
      process.env.GITHUB_REF!=='refs/heads/main'||
      process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
      Object.hasOwn(a,'resume_from'))
    fail('only authenticated disposable #1997 initial Cursor slice is enabled');
  return a;
}
async function main(){
  if(process.argv.length!==4)fail('usage: verified-admission.json output-directory');
  if(process.env.STORE_APP_TOKEN||process.env.STORE_WRITER_PRIVATE_KEY||
      process.env.ACTIONS_DISPATCH_TOKEN||process.env.GITHUB_TOKEN||
      process.env.GH_TOKEN||process.env.AGENT_STORE_CONTROLLER_REMOTE)
    fail('privileged credential leaked into model-execution Worker');
  // The SDK's local.sandboxOptions is unsupported on GitHub runners.
  // The sole production execution route is now an OS-isolated Docker process:
  // separate disposable Git checkout, read-only program/SDK mounts, no host
  // runner credentials, no capabilities, no writable root, bounded resources.
  if(process.env.NESSION_DEVELOPER_ISOLATED!=='docker-v1'||
     process.env.GITHUB_WORKSPACE!=='/workspace'||
     process.env.CURSOR_SDK_ROOT!=='/sdk'||
     process.env.RUNNER_TEMP!=='/tmp'||
     !fs.existsSync('/.dockerenv'))
    fail('OS-isolated Docker worker is mandatory, not local SDK sandbox');
  const a=readAdmission(process.argv[2]);
  if(!process.env.CURSOR_API_KEY||!process.env.CURSOR_SDK_ROOT)
    fail('missing pinned real Cursor Provider');
  const sdkPkg=JSON.parse(fs.readFileSync(path.join(
    process.env.CURSOR_SDK_ROOT,'node_modules/@cursor/sdk/package.json'),'utf8'));
  if(!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(sdkPkg.version??'')||
      sdkPkg.version!==process.env.CURSOR_SDK_VERSION)
    fail('Cursor SDK digest/version differs from pinned Environment version');
  const model={id:process.env.CURSOR_MODEL||'composer-2.5',
    fast:(process.env.CURSOR_MODEL_FAST||'true')!=='false'};
  const root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||os.tmpdir(),'nession-dev-slice-'));
  const workspace=path.join(root,'source'),nativeStore=path.join(root,'native-store');
  const out=path.resolve(process.argv[3]);
  const candidate='e2e/fixtures/agent-development/1997-canary.txt';
  const initial='Durable Worker fixture: pending\n';
  const expected='Durable Worker fixture: complete\n';
  let added=false;
  try{
    git('-C',process.env.GITHUB_WORKSPACE,'worktree','add','--detach',workspace,a.input_sha);
    added=true;
    if(git('-C',workspace,'rev-parse','HEAD')!==a.input_sha)
      fail('workspace is not exact signed source SHA');
    const target=path.join(workspace,candidate);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    if(fs.existsSync(target))fail('fixture unexpectedly exists in source checkout');
    fs.writeFileSync(target,initial,{flag:'wx'});
    fs.mkdirSync(nativeStore,{mode:0o700});
    const prompt='You are executing a disposable bounded #1997 Developer verification. '+
      'Use the read tool to inspect ONLY '+candidate+'. Then use the edit tool to '+
      'replace the single word pending with complete in that file. '+
      'Do not change any other file. No shell, network, Git or publisher actions. '+
      'Do not claim PR merge, acceptance or success criteria completion.';
    // SDK confines available native tools to read, grep and edit (no shell);
    // settingSources=[] forbids ambient project configuration injection.
    const {result,meta}=await runCursorSession({
      apiKey:process.env.CURSOR_API_KEY,name:'nession-issue-1997-real-developer',
      requestedModel:model,workspace,storePath:nativeStore,
      tools:['read','grep','edit'],sandbox:false,prompt,
    });
    if(result?.status!=='finished'||meta.status!=='finished'||
        !/^agent-[a-zA-Z0-9-]{4,100}$/.test(meta.agent_id??'')||
        !meta.tool_calls.some(x=>String(x).toLowerCase().includes('read'))||
        !meta.tool_calls.some(x=>String(x).toLowerCase().includes('edit')))
      fail('real native read/edit Provider outcome missing');
    if(fs.readFileSync(target,'utf8')!==expected)
      fail('real Developer did not produce the exact bounded fixture edit');
    const changes=git('-C',workspace,'status','--porcelain','--untracked-files=all')
      .split('\n').filter(Boolean);
    if(changes.length!==1||changes[0]!=='?? '+candidate)
      fail('Worker changed files outside its allowlisted disposable fixture');
    const publicPem=Buffer.from(
      process.env.CURSOR_RESUME_PUBLIC_KEY_B64||'','base64').toString('utf8');
    if(!publicPem.includes('-----BEGIN PUBLIC KEY-----'))
      fail('public-only native Session sealing key missing');
    const harnessDigest=sha(JSON.stringify({schema_version:1,provider:'cursor',
      source_sha:a.input_sha,sdk_version:sdkPkg.version,model,
      tools:['read','grep','edit'],settingSources:[],
      checkpoint_format:'jsonl-v1'}));
    const metadata={agent_id:meta.agent_id,source_sha:a.input_sha,
      harness_digest:harnessDigest,run_id:a.run_id,
      attempt:Number(process.env.GITHUB_RUN_ATTEMPT),sdk_version:sdkPkg.version};
    const sealed=sealCursorNativeStore({directory:nativeStore,metadata,
      publicKeyPem:publicPem});
    fs.mkdirSync(out,{recursive:true,mode:0o700});
    const save=(name,obj)=>fs.writeFileSync(path.join(out,name),
      JSON.stringify(obj,null,2)+'\n',{flag:'wx',mode:0o600});
    save('ciphertext.json',sealed);
    save('proof.json',{schema_version:1,kind:'bounded-development-native-session',
      issue:a.issue,action_id:a.action_id,source_sha:a.input_sha,
      run_id:a.run_id,attempt:metadata.attempt,
      metadata,ciphertext_sha256:sealed.ciphertext_sha256});
    save('result.json',{schema_version:1,kind:'developer_proposal',
      issue:a.issue,action_id:a.action_id,source_sha:a.input_sha,
      run_id:a.run_id,attempt:metadata.attempt,
      status:'proposed_not_published',file:candidate,
      content_sha256:sha(expected),native_read_edit_verified:true});
    const telemetry=buildAgentWorkflowTelemetry({
      workflow_id:'agent-develop',github_workflow:process.env.GITHUB_WORKFLOW,
      github_run_id:a.run_id,github_run_attempt:metadata.attempt,
      repository:REPO,event:'workflow_dispatch',job:'developer',
      task:{id:'issue-1997-development',type:'development',issue:a.issue,
        target_ref:a.input_sha,action_id:a.action_id},
      agent:{provider:'cursor',id:a.agent_id,role:'developer',
        harness_sha256:harnessDigest,model:meta.model,
        run_id:meta.run_id,status:meta.status},
      execution:{turns:meta.turns,model_requests:meta.turns,
        tool_calls:meta.tool_calls,tools_observed:true},
      tokens:meta.usage,cost:meta.cost,
      timing:{started_at:meta.started_at,finished_at:meta.finished_at,
        agent_duration_ms:meta.duration_ms},
      result:{status:'native-checkpoint-proposed'},
    });
    writeAgentWorkflowTelemetry(path.join(out,'agent-telemetry.json'),telemetry);
    console.log('Real Developer read/edit and encrypted native checkpoint verified; no PR published');
  }finally{
    if(added)try{git('-C',process.env.GITHUB_WORKSPACE,'worktree','remove','--force',workspace);}catch{}
    fs.rmSync(root,{recursive:true,force:true});
  }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
}
