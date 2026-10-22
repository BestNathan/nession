'use strict';
// #1974 SC-04: the owning implementation PR's exact attested HEAD has
// independently completed Quality, Case Smoke, E2E and canonical Agent
// Acceptance. No manual checkbox is promoted, and this Case never treats a
// missing run as Pass.
const assert=require('node:assert/strict');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {
  REPO,issueRecords,isResultV2,fetchJson,HEX40,
}=require('../../../shared/agent-store-1997.cjs');
const {report,fail}=require('../../../shared/trusted-run-store-proof.cjs');

const root=path.resolve(__dirname,'../../../../..');
const REQUIRED=[
  {label:'Quality Gate',name:'CI / Quality Gate',path:'.github/workflows/ci-quality.yml',events:['pull_request']},
  {label:'Case Smoke',name:'Acceptance / Case Smoke',path:'.github/workflows/acceptance-case-smoke.yml',events:['pull_request']},
  {label:'E2E',name:'E2E / Tests',path:'.github/workflows/e2e-tests.yml',events:['pull_request']},
];
const AGENT={label:'Agent Acceptance',name:'Acceptance / Orchestrator',
  path:'.github/workflows/acceptance-orchestrator.yml',events:['pull_request_target']};
function pending(summary,evidence){
  console.log(JSON.stringify({status:'pending',summary,evidence}));
}
function matches(run,spec){
  return run?.name===spec.name&&
    String(run.path??'').replace(/@refs\/heads\/[^\s]+$/,'')===spec.path&&
    spec.events.includes(run.event);
}

async function main(){
  const target=process.env.NESSION_ACCEPTANCE_TARGET_SHA||'';
  assert.match(target,HEX40,'exact target SHA required');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),target,
    'Case checkout SHA mismatch');
  assert.equal(process.env.GITHUB_REF_NAME,'main','post-merge Case must run on main');

  const {storeSha,results}=await issueRecords();
  const v2=results.filter(item=>isResultV2(item.doc));
  if(!v2.length){
    pending(
      'No authenticated Result v2 exists, so the owning implementation PR and its exact-HEAD gates are not established. No exact-SHA verdict is inferred.',
      [{type:'store',value:'agent-store='+storeSha+' result_records='+results.length}]);
    return;
  }
  assert.equal(v2.length,1,'expected exactly one authenticated #1997 Result v2');
  const receipt=v2[0].doc;
  const binding=receipt.implementing_pr;
  assert.ok(binding&&Number.isSafeInteger(binding.number)&&binding.number>0,'missing implementing PR');
  assert.equal(binding.repository,REPO);
  assert.equal(binding.head_sha_at_attestation,receipt.result.target_sha);
  assert.match(binding.head_sha_at_attestation,HEX40);

  const sha=binding.head_sha_at_attestation;
  const listed=await fetchJson('/actions/runs?head_sha='+sha+'&per_page=100');
  assert.ok(Array.isArray(listed?.workflow_runs),'GitHub run listing unavailable');
  const runs=listed.workflow_runs;
  const missing=[],failed=[];
  for(const spec of [...REQUIRED,AGENT]){
    const candidates=runs.filter(run=>matches(run,spec));
    const success=candidates.find(run=>run.status==='completed'&&run.conclusion==='success');
    if(success)continue;
    const completed=candidates.find(run=>run.status==='completed');
    if(completed)failed.push(spec.label+'='+completed.conclusion+' (run '+completed.id+')');
    else missing.push(spec.label);
  }
  if(failed.length) throw new Error('exact-HEAD gate failed: '+failed.join('; '));
  if(missing.length){
    pending(
      'The authenticated implementation PR HEAD has not yet produced every required exact-SHA gate.',
      [
        {type:'pr',value:'#'+binding.number+' attested_head='+sha},
        {type:'missing',value:missing.join(', ')},
        {type:'observed',value:runs.filter(run=>run.head_sha===sha).map(run=>run.name+'='+run.conclusion).sort().slice(0,12).join(', ')},
      ]);
    return;
  }

  report(
    'The owning PR HEAD has successful exact-SHA Quality, Case Smoke, E2E and canonical Agent Acceptance runs, independent of the Issue checkbox.',
    [
      {type:'pr',value:'#'+binding.number+' attested_head='+sha},
      {type:'gates',value:'Quality + Case Smoke + E2E + Agent Acceptance completed/success'},
      {type:'store',value:'agent-store='+storeSha+' result='+v2[0].path},
    ]);
}
main().catch(fail);
