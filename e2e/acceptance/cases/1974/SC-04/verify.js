'use strict';
// #1974 SC-04: evidence for the *actually* attested Qwen implementation PR
// HEAD. Never hardcode historical #2961/#2963 or infer a pass from merging.
const assert=require('node:assert/strict');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {REPO,fetchJson,HEX40}=require('../../../shared/agent-store-1997.cjs');
const {attestLatestQwenProducer}=require('../../../shared/qwen-live-source.cjs');
const {report,fail}=require('../../../shared/trusted-run-store-proof.cjs');
const root=path.resolve(__dirname,'../../../../..');
const REQUIRED=[
 {label:'Quality',name:'CI / Quality Gate',
   path:'.github/workflows/ci-quality.yml',events:['pull_request']},
 {label:'Case Smoke',name:'Acceptance / Case Smoke',
   path:'.github/workflows/acceptance-case-smoke.yml',events:['pull_request']},
 {label:'E2E',name:'E2E / Tests',
   path:'.github/workflows/e2e-tests.yml',events:['pull_request']},
 {label:'Agent Acceptance',name:'Acceptance / Orchestrator',
   path:'.github/workflows/acceptance-orchestrator.yml',events:['pull_request_target']}
];
function matches(run,spec,sha){
  return run?.head_sha===sha&&
    run.repository?.full_name===REPO&&
    run.head_repository?.full_name===REPO&&
    run.name===spec.name&&
    String(run.path??'').replace(/@refs\/heads\/[^\s]+$/,'')===spec.path&&
    spec.events.includes(run.event)&&
    Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0;
}
function pending(source,summary,evidence=[]){
  console.log(JSON.stringify({status:'pending',summary,
    evidence:[{type:'store',value:'agent-store='+(source.storeSha||'unavailable')},
      ...evidence]}));
}
async function main(){
 const target=process.env.NESSION_ACCEPTANCE_TARGET_SHA||'';
 assert.match(target,HEX40,'exact merged target SHA required');
 assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
   target,'Case checkout SHA mismatch');
 assert.equal(process.env.GITHUB_REF_NAME,'main');

 const source=await attestLatestQwenProducer();
 if(source.status!=='verified'){
   pending(source,'No independent real Qwen Developer v2, Writer and PR attestation: '+
     source.reason);
   return;
 }
 const sha=source.fixture.sha;
 const pull=await fetchJson('/pulls/'+source.fixture.pr);
 assert.equal(pull.head?.sha,sha,'PR HEAD moved since source attestation');
 assert.equal(pull.base?.ref,'main');
 assert.equal(pull.head?.repo?.full_name,REPO);
 const result=await fetchJson('/actions/runs?head_sha='+sha+'&per_page=100');
 assert.ok(Array.isArray(result?.workflow_runs),'Actions exact-head run listing unavailable');
 if(result.workflow_runs.length>=100){
   pending(source,'GitHub exact-HEAD CI window truncated; refusing incomplete proof',
     [{type:'pr',value:'#'+source.fixture.pr+' sha='+sha}]);
   return;
 }
 const missing=[],failed=[],proven=[];
 for(const spec of REQUIRED){
   const sources=result.workflow_runs.filter(r=>matches(r,spec,sha));
   const passed=sources.find(r=>r.status==='completed'&&r.conclusion==='success');
   if(passed){proven.push(spec.label+'='+passed.id+'/'+passed.run_attempt);continue;}
   const completed=sources.find(r=>r.status==='completed');
   if(completed)failed.push(spec.label+'='+completed.conclusion+' run='+completed.id);
   else missing.push(spec.label);
 }
 if(failed.length)throw Error('exact-HEAD required run failed: '+failed.join('; '));
 if(missing.length){
   pending(source,'Source Qwen PR does not yet have every exact-head CI/E2E/Acceptance success',
     [{type:'pr',value:'#'+source.fixture.pr+' sha='+sha},
      {type:'missing',value:missing.join(', ')}]);
   return;
 }
 report('Real source implementation PR HEAD has independently successful exact-SHA Quality, Case Smoke, selected E2E and authenticated Agent Acceptance workflows.',[
   {type:'pr',value:'#'+source.fixture.pr+' sha='+sha},
   {type:'runs',value:proven.join('; ')},
   {type:'store',value:'agent-store='+source.storeSha+
      ' producer='+source.fixture.producerPath},
 ]);
}
main().catch(fail);
