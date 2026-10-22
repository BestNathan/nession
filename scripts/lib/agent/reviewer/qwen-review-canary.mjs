#!/usr/bin/env node
// #2223: Qwen Reviewer canary. SMOKE ONLY — this is not the canonical cursor
// Reviewer admission and it performs no GitHub, Issue, Store, review, merge or
// role effect. It reviews the real admitted PR #2176 target with the
// claude-code provider restricted to Read/Grep, validates the verdict with the
// canonical review contract, and writes canonical telemetry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTROLLED_1997_POLICY as POLICY } from '../publisher/controlled-proposal.mjs';
import { claudeCliToolPolicy } from '../harness/native.mjs';
import { normalizeClaudeUsage } from '../providers/claude-code.mjs';
import { normalizeNativeTrace, writeExecutionTrace } from '../telemetry/execution-trace.mjs';
import { promptTelemetry } from '../telemetry/prompt.mjs';
import { providerScopedRunName } from '../telemetry/run-name.mjs';
import { parseNativeEvents } from '../developer-canary.mjs';
import { renderReviewPrompt, reviewModelResult } from '../tasks/review.mjs';
import { buildAgentWorkflowTelemetry, writeAgentWorkflowTelemetry } from '../../../agent-workflow-telemetry.mjs';
const REPO='BestNathan/nession', ISSUE=1997, PR=2176;
const TARGET_SHA='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const BASE_SHA='c6894b59b8be9448cae3c68fd87593516f66b47a';
const CHECKPOINT='eb891ee2154d02ddb758d50f0f694e70a343ffdf';
const FILE=POLICY.file;
const TASK='issue-1997-review-canary';
const SHA=/^[a-f0-9]{40}$/;
const READ_TOOLS=['Read','Grep'];
// The explicit smoke identity: same authenticated target/file facts, but a
// Qwen reviewer instance and a kind that can never be mistaken for #2177.
const SMOKE_IDENTITY=Object.freeze({
  kind:'reviewer_smoke_admission_only',status:'await_smoke_review',agent_id:'review-qwen-01',
});
const sha256=value=>createHash('sha256').update(value,'utf8').digest('hex');
export const blobSha=value=>createHash('sha1').update(Buffer.concat([
  Buffer.from('blob '+Buffer.byteLength(value)+'\0'),Buffer.from(value,'utf8'),
])).digest('hex');
function fail(message){throw new Error('Qwen Reviewer Canary: '+message);}
function git(root,...args){
  return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',timeout:90000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe'],
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  }).trim();
}
function providerModel(env){
  const model=env.ACCEPTANCE_CLAUDE_MODEL||env.ANTHROPIC_MODEL;
  if(!/^qwen[a-z0-9._-]*$/i.test(model??''))fail('Qwen model must be explicit');
  return model;
}
function toolUses(events){
  return events.filter(x=>x?.type==='assistant'&&Array.isArray(x?.message?.content))
    .flatMap(x=>x.message.content)
    .filter(block=>block?.type==='tool_use'&&typeof block.id==='string')
    .map(block=>block.name);
}
export function assertReadOnlyTools(names){
  if(!Array.isArray(names)||names.some(name=>!READ_TOOLS.includes(name)))
    fail('non-read tool observed in reviewer canary');
  if(!names.some(name=>READ_TOOLS.includes(name)))fail('no read-only inspection observed');
  return true;
}
export function smokeReviewAdmission(){
  return Object.freeze({
    schema_version:1,kind:SMOKE_IDENTITY.kind,status:SMOKE_IDENTITY.status,
    repository:REPO,issue:ISSUE,role:'reviewer',agent_id:SMOKE_IDENTITY.agent_id,task:'review',
    pr_number:PR,target_sha:TARGET_SHA,base_sha_at_publication:BASE_SHA,
    // Smoke placeholder: this canary does not re-attest the Publisher Store intent.
    publisher_run_id:39609600546,publisher_attempt:1,
    publisher_intent_sha256:'a'.repeat(64),
    original_worker_run_id:39448549052,native_checkpoint_commit_sha:CHECKPOINT,
    expected_file:FILE,expected_file_sha256:sha256(POLICY.content),expected_file_mode:'100644',
  });
}
export function canaryArgs(prompt,model){
  return ['-p',prompt,'--output-format','stream-json','--verbose',
    '--no-session-persistence','--max-turns','24','--model',model,'--strict-mcp-config',
    ...claudeCliToolPolicy(READ_TOOLS,{restricted:true})];
}
function canaryTelemetry(env,startedAt,finishedAt,events,envelope,verdict,admission){
  const tools=toolUses(events);
  const model=providerModel(env);
  return buildAgentWorkflowTelemetry({
    workflow_id:'agent-provider-smoke',github_workflow:'Agent / Provider Smoke',
    job:'qwen-reviewer-canary',repository:env.GITHUB_REPOSITORY,
    event:env.GITHUB_EVENT_NAME,
    github_run_id:Number(env.GITHUB_RUN_ID),github_run_attempt:Number(env.GITHUB_RUN_ATTEMPT),
    unique_run_name:providerScopedRunName({workflowId:'agent-provider-smoke',
      runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT,taskId:TASK,provider:'claude-code'}),
    task:{id:TASK,type:'review',issue:ISSUE,pr:PR,target_ref:TARGET_SHA},
    agent:{provider:'claude-code',id:'review-qwen-01',role:'reviewer',
      model:{id:model,request_model:model},
      prompt:promptTelemetry(renderReviewPrompt(admission,SMOKE_IDENTITY)),
      run_id:envelope?.session_id??null,status:verdict?'finished':'error'},
    execution:{turns:envelope?.num_turns??null,model_requests:null,
      tool_calls:tools,tools_observed:tools.length>0},
    tokens:normalizeClaudeUsage(envelope),
    cost:{raw_usd:null,charged_usd:null,estimated_usd:null},
    timing:{started_at:startedAt,finished_at:finishedAt,
      agent_duration_ms:new Date(finishedAt).getTime()-new Date(startedAt).getTime()},
    result:{status:verdict?'canary-pass':'canary-error'},
  });
}
async function run(dir){
  const env=process.env;
  // A trusted main push or an explicit owner dispatch on main are equivalent
  // trust: the job only ever runs main-owned code with the Environment secrets.
  if(env.GITHUB_REPOSITORY!==REPO||env.GITHUB_REF!=='refs/heads/main'||
      !['push','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)||
      !SHA.test(env.GITHUB_SHA??''))
    fail('only trusted main push or dispatch may run the Qwen Reviewer Canary');
  if(!env.ANTHROPIC_BASE_URL||(!env.ANTHROPIC_API_KEY&&!env.ANTHROPIC_AUTH_TOKEN))
    fail('missing Qwen Gateway credentials');
  if(!dir||!path.isAbsolute(dir))fail('metrics directory must be absolute');
  const model=providerModel(env),admission=smokeReviewAdmission();
  const prompt=renderReviewPrompt(admission,SMOKE_IDENTITY);
  const root=fs.mkdtempSync(path.join(env.RUNNER_TEMP||os.tmpdir(),'qwen-review-canary-'));
  const workspace=path.join(root,'workspace');
  let events=[],envelope=null,verdict=null,error=null;
  const startedAt=new Date().toISOString();
  try{
    // The admitted commit is not in the trusted main checkout. Fetch the
    // public PR ref read-only and materialize the exact tree WITHOUT .git
    // metadata, so restricted mode only sees ordinary repository files.
    git(env.GITHUB_WORKSPACE,'fetch','--quiet','--no-tags','origin','refs/pull/'+PR+'/head');
    if(git(env.GITHUB_WORKSPACE,'rev-parse','FETCH_HEAD')!==TARGET_SHA)
      fail('fetched PR head is not the admitted target SHA');
    const mode=git(env.GITHUB_WORKSPACE,'ls-tree',TARGET_SHA,'--',FILE).split(/\s+/)[0];
    if(mode!=='100644')fail('admitted file is not a regular 100644 blob');
    // Ask git for the blob identity directly; no whitespace parsing of ls-tree.
    const blob=git(env.GITHUB_WORKSPACE,'rev-parse',TARGET_SHA+':'+FILE);
    const expectedBlob=blobSha(POLICY.content);
    if(blob!==expectedBlob)
      fail('admitted file blob differs from the expected content ('+blob+' != '+expectedBlob+')');
    fs.mkdirSync(workspace,{mode:0o700});
    const archive=path.join(root,'target.tar');
    execFileSync('git',['-C',env.GITHUB_WORKSPACE,'archive','--format=tar',
      '--output='+archive,TARGET_SHA],{
      timeout:120000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
    });
    execFileSync('tar',['-xf',archive,'-C',workspace],{
      timeout:120000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],
    });
    const bytes=fs.readFileSync(path.join(workspace,FILE));
    if(bytes.toString('utf8')!==POLICY.content||sha256(bytes.toString('utf8'))!==admission.expected_file_sha256)
      fail('admitted file bytes changed');
    const proc=spawnSync('claude',canaryArgs(prompt.text,model),{
      cwd:workspace,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024,
      env:{...env,DISABLE_AUTOUPDATER:'1',ANTHROPIC_MODEL:model,
        ANTHROPIC_DEFAULT_SONNET_MODEL:model},
    });
    if(proc.error||proc.status!==0){
      // Safe diagnostics only: no raw model text, prompt or tool output.
      const detail=[];
      if(proc.error?.code)detail.push('spawn='+proc.error.code);
      if(proc.signal)detail.push('signal='+proc.signal);
      if(Number.isInteger(proc.status))detail.push('status='+proc.status);
      try{
        const failed=parseNativeEvents(proc.stdout||'');
        if(failed.envelope?.subtype)detail.push('subtype='+failed.envelope.subtype);
        if(failed.envelope?.is_error===true)detail.push('provider_error');
      }catch{}
      fail('restricted Claude Code CLI failed ('+(detail.join(', ')||'no diagnostics')+')');
    }
    const parsed=parseNativeEvents(proc.stdout);
    events=parsed.events;envelope=parsed.envelope;
    if(envelope.is_error===true)fail('Provider returned error');
    assertReadOnlyTools(toolUses(events));
    verdict=reviewModelResult(admission,envelope.result,SMOKE_IDENTITY);
    console.log('Qwen Reviewer Canary: restricted read-only inspection and host-bound '+
      verdict.outcome+' verdict verified (smoke, not canonical admission)');
  }catch(e){error=e;console.error(e.message);}
  finally{
    fs.mkdirSync(dir,{recursive:true});
    const finishedAt=new Date().toISOString();
    const summary=canaryTelemetry(env,startedAt,finishedAt,events,envelope,verdict,admission);
    writeAgentWorkflowTelemetry(path.join(dir,'agent-telemetry.json'),summary);
    const trace=normalizeNativeTrace('claude-code',events,summary,{
      model:events.some(e=>e.type==='assistant'&&e.message?.usage)?'observed':'unobserved',
      tools:toolUses(events).length?'partial':'unobserved',
      skills:'unobserved',mcp:'unobserved',
    });
    writeExecutionTrace(path.join(dir,'agent-execution-trace.json'),trace);
    fs.rmSync(root,{recursive:true,force:true});
  }
  if(error)throw error;
}
function selfTest(){
  const admission=smokeReviewAdmission();
  assert.equal(admission.expected_file_sha256,sha256(POLICY.content));
  // The admitted file's git identity is the real blob at PR #2176 HEAD.
  assert.equal(blobSha(POLICY.content),'c43fc9a41c1c8cd49bb8128a725e0cac6f4acb3f');
  const prompt=renderReviewPrompt(admission,SMOKE_IDENTITY);
  assert.equal(prompt.template_id,'review');
  assert.equal(prompt.template_version,'v1');
  assert.match(prompt.text,new RegExp(TARGET_SHA));
  assert.match(prompt.text,/"pull_request": 2176/);
  // The smoke identity cannot masquerade as the canonical #2177 admission.
  assert.throws(()=>renderReviewPrompt(admission),/authenticated reviewer admission/);
  assert.throws(()=>reviewModelResult(admission,
    JSON.stringify({outcome:'approved',summary:'x',findings:[]})),/authenticated reviewer admission/);
  const verdict=reviewModelResult(admission,JSON.stringify({outcome:'changes_requested',
    summary:'one defect',findings:[{path:FILE,evidence:'content mismatch'}]}),SMOKE_IDENTITY);
  assert.equal(verdict.outcome,'changes_requested');
  assert.equal(verdict.target_sha,TARGET_SHA);
  assert.equal(verdict.pr_number,PR);
  const approved=reviewModelResult(admission,
    JSON.stringify({outcome:'approved',summary:'no blocking defect',findings:[]}),SMOKE_IDENTITY);
  assert.equal(approved.outcome,'approved');
  assert.equal(providerModel({ANTHROPIC_MODEL:'qwen3.7-plus'}),'qwen3.7-plus');
  assert.throws(()=>providerModel({ANTHROPIC_MODEL:'claude-sonnet-5'}),/Qwen model/);
  const args=canaryArgs('prompt','qwen3.7-plus').join(' ');
  for(const flag of ['--restricted','--tools','Grep,Read','--permission-mode dontAsk',
    '--strict-mcp-config','--disallowedTools mcp__*','--no-session-persistence']){
    assert.ok(args.includes(flag),'required Claude flag absent: '+flag);
  }
  assert.ok(args.includes('Bash')===false&&args.includes('Edit')===false);
  const turnIndex=canaryArgs('prompt','qwen3.7-plus').indexOf('--max-turns');
  assert.equal(canaryArgs('prompt','qwen3.7-plus')[turnIndex+1],'24');
  assert.equal(assertReadOnlyTools(['Read','Grep']),true);
  for(const bad of [[],['Read','Edit'],['Bash'],['Grep','Write']])
    assert.throws(()=>assertReadOnlyTools(bad),/read-only|non-read/);
  const events=[{type:'assistant',message:{content:[
    {type:'tool_use',id:'r1',name:'Read'},{type:'tool_use',id:'g1',name:'Grep'}]}}];
  assert.deepEqual(toolUses(events),['Read','Grep']);
  assert.equal(assertReadOnlyTools(toolUses(events)),true);
  assert.throws(()=>parseNativeEvents('{not-json}'),/malformed/);
  console.log('Qwen Reviewer Canary: smoke-identity separation, restricted read/grep flags, verdict binding and tool denial fixtures passed');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  (process.argv[2]==='self-test'?Promise.resolve(selfTest()):
    process.argv[2]==='run'?run(process.argv[3]):Promise.reject(Error('usage: self-test | run METRICS_DIR')))
    .catch(e=>{console.error(e.message);process.exitCode=1;});
}
