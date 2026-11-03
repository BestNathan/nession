#!/usr/bin/env node
// #1690 SC-06: one read-only five-mode proof matrix, composed from existing
// source -> privileged ingester -> independently authenticated Git-byte readback.
// PINNED RUN IDs ARE DISCOVERY LOCATORS, NOT TRUSTED CLAIMS. Recheck all identities
// with GitHub REST and independently uploaded verified.jsonl. Artifacts expire:
// missing proofs become Pending, never a fabricated Pass or durable WORM anchor.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^sha256:[a-f0-9]{64}$/;
const N=n=>Number.isSafeInteger(Number(n))&&Number(n)>0;
const fail=msg=>{throw Error('run-store-five-mode-evidence: '+msg);};
// These are *verified candidate locators* from current Actions history, not
// source-of-truth claims. Every collection re-fetches run identities, attempts,
// finite-retention publisher/consumer artifacts and independently verified Git
// bytes. Replace expired examples with newly authenticated live receipts; no
// historical proof survives its evidence TTL automatically.
//
// Success is NOT a prerequisite for an Agent telemetry *source*: a failed Agent
// run can produce valid diagnostic telemetry. Only a successful, trusted-main
// ingester and independent successful readback can attest such a source.
export const PINS=Object.freeze([
  {mode:'case',store:'acceptance-results',
    source:41473925992,ingest:41474512821,readback:41474646163,
    source_sha:'b2f321bcf412c4790c55425c793c67d03339679f',
    source_name:'Acceptance / Cases',source_path:'.github/workflows/acceptance-cases.yml',
    source_branch:'staging',source_event:'push',source_conclusion:'success',
    ingest_name:'Acceptance / Case Ingest',ingest_path:'.github/workflows/acceptance-case-ingest.yml',suffix:'case'},
  {mode:'scenario',store:'acceptance-results',
    source:41583565950,ingest:41583800977,readback:41583837519,
    source_sha:'d275d8c61bfc3ebc92ef3c116bab0e6dd70f831d',
    source_name:'E2E / Scenario Smoke',source_path:'.github/workflows/e2e-scenario-smoke.yml',
    source_branch:'feat/170-session-env-binding',source_event:'pull_request',source_conclusion:'success',
    ingest_name:'E2E / Scenario Ingest',ingest_path:'.github/workflows/e2e-scenario-ingest.yml',suffix:'scenario'},
  {mode:'test',store:'acceptance-results',
    source:41565864619,ingest:41565905545,readback:41565973551,
    source_sha:'4afa87efbab45381df0df5e7c72e6327c440cd87',
    source_name:'E2E / Tests',source_path:'.github/workflows/e2e-tests.yml',
    source_branch:'main',source_event:'push',source_conclusion:'success',
    ingest_name:'E2E / Test Ingest',ingest_path:'.github/workflows/e2e-test-ingest.yml',suffix:'test'},
  {mode:'task',store:'task-results',
    source:39908810295,ingest:39908836622,readback:39908886587,
    source_sha:'093b34b5c8c7bb392741272f756f2f25e9ef4ba0',
    source_name:'Task / Ephemeral Runner',source_path:'.github/workflows/task-runner.yml',
    source_branch:'task/jev-goal-relevance-2221-20261023',source_event:'push',source_conclusion:'success',
    ingest_name:'Task / Result Ingest',ingest_path:'.github/workflows/task-result-ingest.yml',suffix:'task'},
  {mode:'agent-metrics',store:'metrics',
    source:41583746825,ingest:41583797554,readback:41583841783,
    source_sha:'35eb1fab37fc58e25554c0ceb03c3a2e6c28fae1',
    source_name:'Agent / Issue Audit',source_path:'.github/workflows/agent-issue-audit.yml',
    source_branch:'main',source_event:'issues',source_conclusion:'failure',
    ingest_name:'Metrics / Agent Telemetry Ingest',
    ingest_path:'.github/workflows/metrics-agent-telemetry.yml',suffix:'agent'},
]);
const normalizePath=r=>String(r?.path??'').replace(/@refs\/heads\/main$/,'');
const trustedIdentity=r=>r?.repository?.full_name===REPO&&
  r.head_repository?.full_name===REPO&&N(r.id)&&N(r.run_attempt)&&SHA.test(r.head_sha??'');
const complete=r=>trustedIdentity(r)&&r.status==='completed'&&r.conclusion==='success';
function requireArtifact(list,run,name){
  if(!Array.isArray(list?.artifacts)||list.artifacts.length>100)fail('untrusted artifact list');
  const matches=list.artifacts.filter(x=>x.name===name);
  if(matches.length===0)return null; // Retained Actions artifacts have a finite TTL.
  if(matches.length!==1)fail('duplicate artifact identity');
  const a=matches[0];
  if(a.expired===true)return null; // Historical proof TTL elapsed: Pending, not tampering or Pass.
  if(!N(a.id)||a.expired!==false||!DIGEST.test(a.digest??'')||
     !N(a.size_in_bytes)||a.workflow_run?.id!==run.id||
     a.workflow_run?.head_sha!==run.head_sha)fail('invalid provenance/expiry/digest for '+name);
  return a;
}
export function attestFiveMode(pin,source,ingest,readback,ingestArtifacts,readbackArtifacts,statements){
  if(!PINS.some(p=>JSON.stringify(p)===JSON.stringify(pin)))
    fail('unknown or altered evidence locator');
  if(!trustedIdentity(source)||source.status!=='completed'||
     source.conclusion!==pin.source_conclusion||
     source.id!==pin.source||source.event!==pin.source_event||
     source.name!==pin.source_name||normalizePath(source)!==pin.source_path||
     source.head_branch!==pin.source_branch||source.head_sha!==pin.source_sha)
    fail('untrusted source workflow/event/conclusion/attempt/SHA/branch');
  if(!complete(ingest)||ingest.id!==pin.ingest||ingest.event!=='workflow_run'||
     ingest.name!==pin.ingest_name||normalizePath(ingest)!==pin.ingest_path||
     ingest.head_branch!=='main')fail('untrusted ingester workflow/attempt');
  if(!complete(readback)||readback.id!==pin.readback||readback.event!=='workflow_run'||
     readback.name!=='Store / Receipt Readback'||
     normalizePath(readback)!=='.github/workflows/store-receipt-readback.yml'||
     readback.head_branch!=='main'||readback.head_sha!==ingest.head_sha)
    fail('untrusted separate readback workflow/attempt');
  const when=x=>Date.parse(x);
  if(!Number.isFinite(when(source.updated_at))||!Number.isFinite(when(ingest.created_at))||
     !Number.isFinite(when(ingest.updated_at))||!Number.isFinite(when(readback.created_at))||
     when(source.updated_at)>when(ingest.created_at)||
     when(ingest.updated_at)>when(readback.created_at))
    fail('out-of-order producer/ingester/readback');
  const publisherName='run-store-receipt-'+ingest.id+'-'+ingest.run_attempt+'-'+pin.suffix;
  const consumerName='run-store-receipt-readback-'+readback.id+'-'+readback.run_attempt;
  const publisher=requireArtifact(ingestArtifacts,ingest,publisherName);
  const consumer=requireArtifact(readbackArtifacts,readback,consumerName);
  if(!publisher||!consumer)return null;
  if(!Array.isArray(statements)||statements.length<1||statements.length>40)
    fail('missing/oversized independently verified statements');
  const matches=statements.filter(s=>String(s?.ingester_run_id)===String(ingest.id)&&
    String(s?.source_run_id)===String(source.id));
  if(matches.length!==1)fail('missing or ambiguous exact source-bound positive readback');
  const s=matches[0];
  if(s.kind!=='run_store_receipt_readback'||
     s.trust_level!=='github_actions_authenticated_not_independent_anchor'||
     s.store!==pin.store||s.source_workflow!==pin.ingest_path||
     String(s.ingester_attempt)!==String(ingest.run_attempt)||
     String(s.upstream_run_id)!==String(source.id)||
     Number(s.artifact_id)!==publisher.id||!SHA.test(s.commit_sha??'')||
     !N(s.checked_records)||!N(s.changed_records)||
     Number(s.changed_records)>Number(s.checked_records))
    fail('not an authenticated, positive, source-bound Git-byte readback');
  return Object.freeze({
    mode:pin.mode,store:pin.store,status:'Verified',
    source_run_id:source.id,source_attempt:source.run_attempt,source_sha:source.head_sha,
    source_workflow:pin.source_path,
    ingest_run_id:ingest.id,ingest_attempt:ingest.run_attempt,ingest_sha:ingest.head_sha,
    publisher_artifact_id:publisher.id,publisher_artifact_zip_digest:publisher.digest,
    readback_run_id:readback.id,readback_attempt:readback.run_attempt,
    consumer_artifact_id:consumer.id,consumer_artifact_zip_digest:consumer.digest,
    commit_sha:s.commit_sha,checked_records:Number(s.checked_records),
    changed_records:Number(s.changed_records),
    trust_level:'github_actions_authenticated_not_independent_anchor',
  });
}
function downloadedStatements(readback){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-five-mode-proof-'));
  try{
    execFileSync('gh',['run','download',String(readback.id),'--repo',REPO,
      '--name','run-store-receipt-readback-'+readback.id+'-'+readback.run_attempt,
      '--dir',dir],{timeout:40000,stdio:['ignore','pipe','pipe']});
    const file=path.join(dir,'verified.jsonl');
    if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink()||
       fs.statSync(file).size>128*1024)fail('no bounded verified.jsonl in separate readback');
    const lines=fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean);
    if(!lines.length||lines.length>40)fail('no positive/bounded verified statements');
    return lines.map(x=>JSON.parse(x));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
async function request(endpoint){
  const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
  if(typeof token!=='string'||token.length<8)fail('no read-only GitHub token');
  const response=await fetch('https://api.github.com/repos/'+REPO+endpoint,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28'},
    signal:AbortSignal.timeout(30000)});
  if(!response.ok)fail('GitHub API read '+response.status+' for '+endpoint);
  return response.json();
}
async function collect(output){
  if(process.env.GITHUB_REPOSITORY!==REPO||
     process.env.GITHUB_REF!=='refs/heads/main'||
     !SHA.test(process.env.GITHUB_SHA??''))fail('main-only trusted read-only audit required');
  if(!path.isAbsolute(output))fail('absolute output path required');
  const rows=[];
  for(const pin of PINS){
    const [source,ingest,readback]=await Promise.all([
      request('/actions/runs/'+pin.source),request('/actions/runs/'+pin.ingest),
      request('/actions/runs/'+pin.readback)]);
    const [ia,ra]=await Promise.all([
      request('/actions/runs/'+pin.ingest+'/artifacts?per_page=100'),
      request('/actions/runs/'+pin.readback+'/artifacts?per_page=100')]);
    const expected='run-store-receipt-readback-'+readback.id+'-'+readback.run_attempt;
    const available=requireArtifact(ra,readback,expected);
    const proof=available?attestFiveMode(pin,source,ingest,readback,ia,ra,
      downloadedStatements(readback)):null;
    rows.push(proof??{mode:pin.mode,store:pin.store,status:'Pending',
      reason:'authenticated Actions artifact expired/missing; historical proof cannot be promoted'});
  }
  const verified=rows.filter(x=>x.status==='Verified').length;
  const report={schema_version:1,kind:'five_mode_authenticated_run_store_readback',
    repository:REPO,observed_main_sha:process.env.GITHUB_SHA,
    checked_at:new Date().toISOString(),coverage:verified,total:5,
    verdict:verified===5?'Verified':'Pending',
    external_anchor_verified:false,authorization_denials_verified:false,
    note:'Finite-retention GitHub run/artifact/Git-byte provenance; no signed/WORM anchor, Ruleset or negative permission proof',
    records:rows};
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    '### Five-mode authenticated readback\n\n'+
    rows.map(x=>'- '+x.mode+': '+x.status+
      (x.status==='Verified'?' (source='+x.source_run_id+', ingest='+x.ingest_run_id+
        ', readback='+x.readback_run_id+', changed='+x.changed_records+')':'')+'\n').join('')+
    '\nNo authorization-denial or external WORM anchor is claimed.\n');
  console.log(JSON.stringify({coverage:verified,total:5,verdict:report.verdict}));
}
function selfTest(){
  assert.deepEqual(PINS.map(p=>p.mode),['case','scenario','test','task','agent-metrics']);
  const p=PINS[0],sha=p.source_sha;
  const base={repository:{full_name:REPO},head_repository:{full_name:REPO},
    head_branch:'main',head_sha:sha,status:'completed',conclusion:'success',run_attempt:1};
  const source={...base,id:p.source,name:p.source_name,path:p.source_path,
    event:p.source_event,head_branch:p.source_branch,
    conclusion:p.source_conclusion,updated_at:'2026-11-02T12:00:00Z'};
  const ingest={...base,id:p.ingest,name:p.ingest_name,path:p.ingest_path,event:'workflow_run',
    created_at:'2026-11-02T12:01:00Z',updated_at:'2026-11-02T12:02:00Z'};
  const readback={...base,id:p.readback,name:'Store / Receipt Readback',
    path:'.github/workflows/store-receipt-readback.yml',event:'workflow_run',
    created_at:'2026-11-02T12:03:00Z'};
  const artifact=(run,id,name)=>({id,name,expired:false,digest:'sha256:'+'a'.repeat(64),
    size_in_bytes:100,workflow_run:{id:run.id,head_sha:run.head_sha}});
  const ia={artifacts:[artifact(ingest,111,'run-store-receipt-'+ingest.id+'-1-case')]};
  const ra={artifacts:[artifact(readback,222,'run-store-receipt-readback-'+readback.id+'-1')]};
  const stmt={kind:'run_store_receipt_readback',
    trust_level:'github_actions_authenticated_not_independent_anchor',
    store:p.store,source_workflow:p.ingest_path,
    ingester_run_id:String(ingest.id),ingester_attempt:'1',
    source_run_id:String(source.id),upstream_run_id:String(source.id),
    artifact_id:111,commit_sha:'c'.repeat(40),checked_records:2,changed_records:2};
  const good=[p,source,ingest,readback,ia,ra,[stmt]];
  const run=(...args)=>attestFiveMode(...args);
  assert.equal(run(...good).changed_records,2);
  assert.equal(run(...good).status,'Verified');
  assert.equal(run(p,source,ingest,readback,{artifacts:[]},ra,[stmt]),null);
  assert.equal(run(p,source,ingest,readback,ia,{artifacts:[]},[stmt]),null);
  const bad=(idx,value)=>{const xs=[...good];xs[idx]=value;assert.throws(()=>run(...xs),
    /untrusted|unclassified|unknown|positive|missing|invalid|out-of-order|duplicate|ambiguous|not an authenticated/);};
  bad(1,{...source,head_sha:'d'.repeat(40)});
  bad(1,{...source,name:'foreign workflow'});
  bad(1,{...source,event:'workflow_dispatch'});
  bad(1,{...source,conclusion:'failure'});
  bad(1,{...source,head_branch:'pull/1/merge'});
  bad(2,{...ingest,event:'pull_request'});
  bad(2,{...ingest,head_branch:'untrusted'});
  bad(3,{...readback,path:p.ingest_path});
  bad(3,{...readback,created_at:'2026-11-02T11:50:00Z'});
  assert.equal(run(p,source,ingest,readback,{artifacts:ia.artifacts.map(x=>({...x,expired:true}))},ra,[stmt]),null);
  bad(4,{artifacts:ia.artifacts.map(x=>({...x,digest:'invalid'}))});
  bad(5,{artifacts:[...ra.artifacts,...ra.artifacts]});
  for(const patch of [{changed_records:0},{changed_records:3},{artifact_id:999},
    {upstream_run_id:'999'},{ingester_attempt:'2'},{commit_sha:'fake'},
    {store:'metrics'},{source_workflow:'.github/workflows/attacker.yml'},
    {trust_level:'independent_WORM_anchor'}])
    bad(6,[{...stmt,...patch}]);
  bad(6,[stmt,stmt]);
  const task=PINS.find(x=>x.mode==='task');
  assert.match(task.source_branch,/^task\//);
  assert.notEqual(task.source_sha,PINS[0].source_sha);
  // The authenticated Metrics writer may legitimately persist telemetry from
  // an unsuccessful Agent producer. This does NOT allow a failed ingester.
  const agent=PINS.find(x=>x.mode==='agent-metrics');
  assert.equal(agent.source_event,'issues');
  assert.equal(agent.source_conclusion,'failure');
  const agentSource={...source,id:agent.source,name:agent.source_name,
    event:agent.source_event,conclusion:agent.source_conclusion,
    path:agent.source_path,head_branch:agent.source_branch,head_sha:agent.source_sha};
  const agentIngest={...ingest,id:agent.ingest,name:agent.ingest_name,
    path:agent.ingest_path,head_sha:'f'.repeat(40)};
  const agentReadback={...readback,id:agent.readback,head_sha:agentIngest.head_sha};
  const agentIA={artifacts:[artifact(agentIngest,333,
    'run-store-receipt-'+agent.ingest+'-1-agent')]};
  const agentRA={artifacts:[artifact(agentReadback,444,
    'run-store-receipt-readback-'+agent.readback+'-1')]};
  const agentStatement={...stmt,store:agent.store,source_workflow:agent.ingest_path,
    ingester_run_id:String(agent.ingest),source_run_id:String(agent.source),
    upstream_run_id:String(agent.source),artifact_id:333};
  assert.equal(run(agent,agentSource,agentIngest,agentReadback,
    agentIA,agentRA,[agentStatement]).status,'Verified');
  assert.throws(()=>run(agent,{...agentSource,conclusion:'success'},
    agentIngest,agentReadback,agentIA,agentRA,[agentStatement]),/untrusted source/);
  assert.throws(()=>run(agent,agentSource,{...agentIngest,conclusion:'failure'},
    agentReadback,agentIA,agentRA,[agentStatement]),/untrusted ingester/);
  // The readback must be carried by a workflow that can succeed at the
  // evaluated SHA, on every main push. It used to run only inside
  // Store / Governance Audit, whose fail-closed policy alert fails that run and
  // therefore discarded this unrelated, genuinely passing observation. Pinning
  // both halves means a move back into the failing owner fails loudly instead
  // of silently making the evidence uncitable again.
  const wf=fs.readFileSync('.github/workflows/store-five-mode-readback.yml','utf8');
  assert.match(wf,/run-store-five-mode-evidence\.mjs collect/);
  assert.match(wf,/permissions:\s*\n  contents: read\s*\n  actions: read/);
  assert.doesNotMatch(wf,/contents: write|RUN_STORE_WRITER_APP_PRIVATE_KEY/);
  assert.match(wf,/push:\s*\n    branches: \[main\]/);
  assert.doesNotMatch(fs.readFileSync('.github/workflows/store-governance-audit.yml','utf8'),
    /run-store-five-mode-evidence\.mjs/);
  console.log('five-mode authenticated Git-byte receipts: source/ingester/readback, positive and hostile negatives passed');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{
    if(process.argv[2]==='self-test')selfTest();
    else if(process.argv[2]==='collect'&&process.argv[3])await collect(process.argv[3]);
    else fail('usage: self-test | collect ABS_OUTPUT');
  }catch(e){console.error('::error::'+String(e.message));process.exitCode=1;}
}
