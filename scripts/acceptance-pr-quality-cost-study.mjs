// #2917: bounded, trusted-main, read-only CI timing evidence for its PR-stage
// performance criterion. Pins are discovery hints; GitHub run/job/commit
// identity and observed step outcomes are independently re-read every time.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const REPO='BestNathan/nession';
const BASE='4a5436a8770fed9367a0820eef38417b77525943';
const SHA=/^[0-9a-f]{40}$/;
const qualityPath='.github/workflows/ci-quality.yml';
const casesPath='.github/workflows/acceptance-case-smoke.yml';
const e2ePath='.github/workflows/e2e-tests.yml';
export const pinnedPrQualitySamples=Object.freeze([
  {
    category:'fixture-only',
    before:{id:42371357810,sha:'968fb5294499fbf5da70b27652deb8a24512bb47'},
    after:{id:42379218472,sha:'c341ffa70359860c825e8673c95565115d439bbf'},
    files:['e2e/fixtures/agent-development/ci-scope-measurement.md'],
    caseRun:42379218579,e2eRun:42379218482,
    afterJobs:{'rust-check':'skipped','tooling-check':'skipped','web-tests':'skipped'},
  },
  {
    category:'web-only',
    before:{id:42377591120,sha:'b161d0545eed7c01405f0d8eac338a28b735779e'},
    after:{id:42379309835,sha:'1f15e14c4609db7e81e29b3ec93d19a8188c549f'},
    files:['web/ci-scope-measurement.md'],
    caseRun:42379309850,e2eRun:42379309857,
    afterJobs:{'rust-check':'skipped','tooling-check':'success','web-tests':'success'},
  },
  {
    category:'mixed-terminal',
    before:{id:42375105508,sha:'e5b4eec319ff7a21446d47fe4e328c06dd88d1e4'},
    after:{id:42379657576,sha:'5d5c5f4a383cf236dfa3811287dd11eed39f7d92'},
    files:['crates/nession-agent/src/session/terminal/runtime.rs',
      'web/src/platform/terminal-runtime/streamReconciler.ts'],
    caseRun:42379657591,e2eRun:42379657588,
    afterJobs:{'rust-check':'success','tooling-check':'success','web-tests':'success'},
  },
]);

function assertRun(run,{id,sha},name,workflow,conclusion='success'){
  assert.ok(Number.isSafeInteger(id)&&id>0&&SHA.test(sha));
  assert.equal(run?.id,id,'run ID differs from trusted pin');
  assert.equal(run?.run_attempt,1,'rerun attempt requires a new proof');
  assert.equal(run?.head_sha,sha,'run source SHA differs from trusted pin');
  assert.equal(run?.name,name,'wrong workflow display name');
  assert.equal(run?.path,workflow,'wrong workflow path');
  assert.equal(run?.event,'pull_request','unexpected event');
  assert.equal(run?.repository?.full_name,REPO,'foreign repository');
  assert.equal(run?.head_repository?.full_name,REPO,'foreign head repository');
  assert.equal(run?.status,'completed','run incomplete');
  assert.equal(run?.conclusion,conclusion,'unexpected run verdict');
  const a=Date.parse(run?.created_at??''),b=Date.parse(run?.updated_at??'');
  assert.ok(Number.isFinite(a)&&Number.isFinite(b)&&b>=a&&b-a<=7200000,
    'invalid or unbounded run duration');
  return Math.round((b-a)/1000);
}
function uniqueJob(jobs,name,run,expected){
  assert.ok(Array.isArray(jobs?.jobs)&&Number.isInteger(jobs.total_count)&&
    jobs.total_count===jobs.jobs.length&&jobs.total_count<=100,
    'missing, truncated or unbounded job inventory');
  const matches=jobs.jobs.filter(j=>j.name===name);
  assert.equal(matches.length,1,'missing or duplicated job: '+name);
  const job=matches[0];
  assert.equal(job.run_id,run.id,'job belongs to another run');
  assert.equal(job.run_attempt,run.run_attempt,'job belongs to another attempt');
  assert.equal(job.head_sha,run.head_sha,'job belongs to another SHA');
  assert.equal(job.status,'completed','job incomplete: '+name);
  assert.equal(job.conclusion,expected,'unexpected job verdict: '+name);
  return job;
}
function successfulStep(job,name){
  const matches=job.steps?.filter(s=>s.name===name)??[];
  assert.equal(matches.length,1,'missing/duplicate step '+name+' in '+job.name);
  assert.equal(matches[0].conclusion,'success','step not successful: '+name);
}
export function verifyPinnedQualityRun(sample,period,run,jobs){
  const pin=sample[period];
  assert.ok(pinnedPrQualitySamples.includes(sample)&&['before','after'].includes(period),
    'unapproved Quality sample');
  const seconds=assertRun(run,pin,'CI / Quality Gate',qualityPath);
  const scope=uniqueJob(jobs,'scope',run,'success');
  const aggregate=uniqueJob(jobs,'web-check',run,'success');
  const rustExpected=period==='after'?sample.afterJobs['rust-check']:
    sample.category==='mixed-terminal'?'success':'skipped';
  const rust=uniqueJob(jobs,'rust-check',run,rustExpected);
  if(rustExpected==='success') successfulStep(rust,'Verify Rust and Acceptance Gates');
  if(period==='after'){
    successfulStep(scope,'Classify the exact PR or main-push change');
    successfulStep(aggregate,'Enforce applicable Quality results at the stable check name');
    for(const name of ['tooling-check','web-tests']){
      const job=uniqueJob(jobs,name,run,sample.afterJobs[name]);
      if(job.conclusion==='success'){
        if(name==='tooling-check')successfulStep(job,'Verify repository tooling Gates');
        if(name==='web-tests')for(const step of [
          'Verify Web and design Gates',
          'Verify negative fixtures and Acceptance harness contracts',
          'Verify Web artifact integrity and negative fixtures'
        ])successfulStep(job,step);
      }
    }
    uniqueJob(jobs,'web-dist',run,'skipped'); // PR never publishes a Main dist.
  }else{
    // Prior workflow performed Tooling then Web in one serialized web-check.
    assert.equal(jobs.jobs.some(j=>j.name==='tooling-check'||j.name==='web-tests'),false,
      'historical serial workflow unexpectedly already parallel');
    for(const step of ['Verify repository tooling Gates',
      'Verify Web and design Gates',
      'Verify negative fixtures and Acceptance harness contracts',
      'Verify Web artifact integrity and negative fixtures'
    ])successfulStep(aggregate,step);
  }
  return {run_id:run.id,run_attempt:1,sha:run.head_sha,
    source_url:'https://github.com/BestNathan/nession/actions/runs/'+run.id,
    wall_seconds:seconds,checked_jobs:period==='after'?
      ['scope','web-check','rust-check','tooling-check','web-tests','web-dist']:
      ['scope','web-check','rust-check'],quality_verdict:'success'};
}
function verifyCase(sample,run,jobs){
  const seconds=assertRun(run,{id:sample.caseRun,sha:sample.after.sha},
    'Acceptance / Case Smoke',casesPath);
  const job=uniqueJob(jobs,'case-smoke',run,'success');
  successfulStep(job,'Select PR-linked Case-method proofs (trusted main policy)');
  for(const name of ['Build runtime','Install selected Case runner dependencies',
    'Install browser Case runtime']){
    const matches=job.steps?.filter(x=>x.name===name)??[];
    assert.equal(matches.length,1,'missing Case provisioning step '+name);
    assert.equal(matches[0].conclusion,'skipped','unneeded Case provisioning was run');
  }
  return {run_id:run.id,run_attempt:1,sha:run.head_sha,
    wall_seconds:seconds,verdict:'success',runtime_provisioning:'skipped'};
}
function verifyE2e(sample,run,jobs){
  const failClosed=sample.category==='mixed-terminal';
  const seconds=assertRun(run,{id:sample.e2eRun,sha:sample.after.sha},
    'E2E / Tests',e2ePath,failClosed?'failure':'success');
  const job=uniqueJob(jobs,'e2e',run,failClosed?'failure':'success');
  const steps=job.steps?.filter(s=>s.name==='Run E2E tests')??[];
  assert.equal(steps.length,1,'E2E test step missing');
  assert.equal(steps[0].conclusion,failClosed?'failure':'success',
    'E2E run verdict was not actually enforced');
  return {run_id:run.id,run_attempt:1,sha:run.head_sha,wall_seconds:seconds,
    verdict:failClosed?'failed_closed':'success',
    note:failClosed?'Disposable probe had no trusted linked Issue E2E obligation; not an E2E Pass':
      'Selected E2E check succeeded'};
}
export function verifyProbeCommit(sample,commit){
  assert.equal(commit?.sha,sample.after.sha,'unexpected probe commit');
  assert.equal(commit.parents?.length,1,'probe must have exactly one parent');
  assert.equal(commit.parents[0].sha,BASE,'probe is not based on pinned Main');
  const paths=commit.files?.map(x=>x.filename).sort();
  assert.deepEqual(paths,[...sample.files].sort(),'unexpected probe source changes');
  return paths;
}
export async function collectVerifiedPrQualityCost({repo,issueNumber,stage,targetSha,get,getText}){
  if(repo!==REPO||issueNumber!==2917||stage!=='pre-merge'||!SHA.test(targetSha)){
    throw Error('PR Quality timing collector is restricted to #2917 pre-merge');
  }
  const data=await Promise.all(pinnedPrQualitySamples.map(async sample=>{
    const [br,bj,ar,aj,cr,cj,er,ej,commit]=await Promise.all([
      get('/repos/'+repo+'/actions/runs/'+sample.before.id),
      get('/repos/'+repo+'/actions/runs/'+sample.before.id+'/attempts/1/jobs?per_page=100'),
      get('/repos/'+repo+'/actions/runs/'+sample.after.id),
      get('/repos/'+repo+'/actions/runs/'+sample.after.id+'/attempts/1/jobs?per_page=100'),
      get('/repos/'+repo+'/actions/runs/'+sample.caseRun),
      get('/repos/'+repo+'/actions/runs/'+sample.caseRun+'/attempts/1/jobs?per_page=100'),
      get('/repos/'+repo+'/actions/runs/'+sample.e2eRun),
      get('/repos/'+repo+'/actions/runs/'+sample.e2eRun+'/attempts/1/jobs?per_page=100'),
      get('/repos/'+repo+'/commits/'+sample.after.sha),
    ]);
    const before=verifyPinnedQualityRun(sample,'before',br,bj);
    const after=verifyPinnedQualityRun(sample,'after',ar,aj);
    const change_paths=verifyProbeCommit(sample,commit);
    const case_smoke=verifyCase(sample,cr,cj);
    const e2e=verifyE2e(sample,er,ej);
    if(sample.category==='mixed-terminal'){
      const e2eJob=uniqueJob(ej,'e2e',er,'failure');
      const log=await getText('/repos/'+repo+'/actions/jobs/'+e2eJob.id+'/logs',600000);
      assert.ok(log.includes('Unresolved Issue E2E obligations require a trusted audit decision'),
        'missing authenticated E2E fail-closed explanation');
    }
    return {category:sample.category,change_paths,before,after,case_smoke,e2e,
      observed_improvement_percent:Math.round((1-after.wall_seconds/before.wall_seconds)*100)};
  }));
  const fixture=data.find(x=>x.category==='fixture-only');
  const web=data.find(x=>x.category==='web-only');
  assert.ok(fixture.after.wall_seconds<60,'Fixture-only Quality target not met');
  assert.ok(web.after.wall_seconds>=180&&web.after.wall_seconds<=240,
    'Web-only 3-4 minute Quality target not met');
  return {schema_version:1,kind:'verified_pr_quality_performance_study',
    target_sha:targetSha,repository:REPO,issue_number:2917,
    stage:'pre-merge',probe_base_sha:BASE,probe_pr:2931,
    measurements:data,
    critical_path:'scope -> concurrent tooling-check/web-tests -> required web-check',
    preservation:'Canonical Quality checks must pass when applicable. Case Smoke selects before provisioning. Mixed E2E failed closed; it was NOT accepted as Pass.',
    limits:'Single non-identical-SHA category comparisons, cache/runner/content differ; measured observation, not statistically guaranteed SLA'};
}
// #4533: bounded proof of the original routing repair and the real combined
 // deployment diff. Pins locate immutable evidence; they never confer a Pass.
const secretRoutingPins=Object.freeze([
  {pr:4534,issue:4533,id:45605842346,sha:'e395e7326021503780592e8812be8ab8e66be3f1',
    paths:['scripts/ci/quality-scope.mjs','scripts/ci/quality-scope.test.mjs'],workflow:'skipped'},
  {pr:4530,issue:4529,id:45664399850,sha:'d1e545ef69c2ba35724ac77637e07454aa8525',
    paths:['.github/workflows/deploy-seal-gitops-secret.yml','scripts/ci/seal-gitops-secret.mjs','scripts/ci/seal-gitops-secret.test.mjs'],workflow:'success'},
]);
function verifySecretRoutingPr(pin,pr,files){
  assert.equal(pr?.number,pin.pr);
  assert.equal(pr?.merged,true);
  assert.equal(pr?.head?.sha,pin.sha);
  assert.equal(pr?.head?.repo?.full_name,REPO);
  assert.equal(pr?.base?.repo?.full_name,REPO);
  assert.equal(pr?.base?.ref,'main');
  assert.ok(SHA.test(pr.merge_commit_sha));
  assert.ok(String(pr.body??'').split(/\r?\n/).some(line=>
    line==='Fixes #'+pin.issue||line==='Refs #'+pin.issue),'missing Issue binding');
  assert.equal(pr.changed_files,pin.paths.length);
  assert.ok(Array.isArray(files));
  assert.deepEqual(files.map(f=>f.filename).sort(),[...pin.paths].sort());
}
function verifySecretRoutingQuality(pin,run,jobs){
  assertRun(run,pin,'CI / Quality Gate',qualityPath);
  const scope=uniqueJob(jobs,'scope',run,'success');
  successfulStep(scope,'Classify the exact PR or main-push change');
  const tooling=uniqueJob(jobs,'tooling-check',run,'success');
  successfulStep(tooling,'Verify repository tooling Gates');
  const aggregate=uniqueJob(jobs,'web-check',run,'success');
  successfulStep(aggregate,'Enforce applicable Quality results at the stable check name');
  for(const name of ['rust-check','web-tests','web-dist','instruction-check'])
    uniqueJob(jobs,name,run,'skipped');
  uniqueJob(jobs,'workflow-check',run,pin.workflow);
  return {pr_number:pin.pr,sha:pin.sha,run_id:run.id,run_attempt:run.run_attempt,
    scope_job_id:scope.id,tooling_job_id:tooling.id,
    jobs:jobs.jobs.map(j=>({name:j.name,id:j.id,conclusion:j.conclusion})),
    source_url:'https://github.com/'+REPO+'/actions/runs/'+run.id};
}
function verifySecretRoutingLogs(toolingLog,scopeLog){
  assert.ok(/✓ ci-pr-routing-selftest(?:\r?\n|$)/.test(toolingLog),
    'exact-head routing regression Gate did not report success');
  const totals=[...toolingLog.matchAll(/(\d+) gates: (\d+) passed, 0 failed, 0 errors/g)];
  assert.equal(totals.length,1,'missing or ambiguous tooling Gate summary');
  assert.ok(Number(totals[0][1])>0&&totals[0][1]===totals[0][2],
    'tooling Gate totals disagree');
  const lines=[...scopeLog.matchAll(/Quality applicability: (\{[^\r\n]+\})/g)];
  assert.equal(lines.length,1,'missing or ambiguous real deployment scope');
  const scope=JSON.parse(lines[0][1]);
  assert.deepEqual(scope,{paths:3,rust:false,web:false,tooling:true,
    workflow:true,instruction:false,applicability:'scoped'});
  return {routing_gate:'ci-pr-routing-selftest',tooling_gates_passed:Number(totals[0][1]),
    deployment_scope:scope};
}
export async function collectSecretRoutingQuality({repo,issueNumber,stage,targetSha,get,getText}){
  assert.equal(repo,REPO);
  assert.equal(issueNumber,4533);
  assert.equal(stage,'pr');
  assert.equal(targetSha,secretRoutingPins[0].sha,'not the original implementation head');
  const root='/repos/'+REPO;
  const receipts=await Promise.all(secretRoutingPins.map(async pin=>{
    const [pr,files,run,jobs]=await Promise.all([
      get(root+'/pulls/'+pin.pr),get(root+'/pulls/'+pin.pr+'/files?per_page=100'),
      get(root+'/actions/runs/'+pin.id),
      get(root+'/actions/runs/'+pin.id+'/attempts/1/jobs?per_page=100'),
    ]);
    verifySecretRoutingPr(pin,pr,files);
    return verifySecretRoutingQuality(pin,run,jobs);
  }));
  const [toolingLog,scopeLog]=await Promise.all([
    getText(root+'/actions/jobs/'+receipts[0].tooling_job_id+'/logs',8388608),
    getText(root+'/actions/jobs/'+receipts[1].scope_job_id+'/logs',1048576),
  ]);
  return {kind:'verified_secret_routing_quality_v1',target_sha:targetSha,
    issue_number:4533,implementation:receipts[0],deployment:receipts[1],
    ...verifySecretRoutingLogs(toolingLog,scopeLog)};
}
function selfTestSecretRoutingQuality(){
  const pin=secretRoutingPins[0],pr={number:pin.pr,merged:true,
    head:{sha:pin.sha,repo:{full_name:REPO}},base:{ref:'main',repo:{full_name:REPO}},
    merge_commit_sha:'a'.repeat(40),body:'Fixes #4533',changed_files:2};
  const files=pin.paths.map(filename=>({filename}));
  verifySecretRoutingPr(pin,pr,files);
  assert.throws(()=>verifySecretRoutingPr(pin,{...pr,merged:false},files));
  assert.throws(()=>verifySecretRoutingPr(pin,{...pr,body:'Refs #999'},files));
  assert.throws(()=>verifySecretRoutingPr(pin,pr,[...files,{filename:'web/x.ts'}]));
  const run={id:pin.id,run_attempt:1,head_sha:pin.sha,name:'CI / Quality Gate',
    path:qualityPath,event:'pull_request',repository:{full_name:REPO},
    head_repository:{full_name:REPO},status:'completed',conclusion:'success',
    created_at:'2026-11-25T11:35:00Z',updated_at:'2026-11-25T11:39:00Z'};
  const specs=[['scope','success','Classify the exact PR or main-push change'],
    ['tooling-check','success','Verify repository tooling Gates'],
    ['web-check','success','Enforce applicable Quality results at the stable check name'],
    ...['rust-check','web-tests','web-dist','instruction-check','workflow-check'].map(n=>[n,'skipped'])];
  const jobs={total_count:specs.length,jobs:specs.map(([name,conclusion,step],i)=>({
    id:i+1,name,conclusion,status:'completed',run_id:run.id,run_attempt:1,
    head_sha:pin.sha,steps:step?[{name:step,conclusion:'success'}]:[]}))};
  verifySecretRoutingQuality(pin,run,jobs);
  assert.throws(()=>verifySecretRoutingQuality(pin,{...run,head_sha:'b'.repeat(40)},jobs));
  assert.throws(()=>verifySecretRoutingQuality(pin,{...run,run_attempt:2},jobs));
  for(const name of ['tooling-check','scope','rust-check']){
    const invalid=structuredClone(jobs);
    invalid.jobs.find(j=>j.name===name).conclusion='failure';
    assert.throws(()=>verifySecretRoutingQuality(pin,run,invalid));
  }
  const stale=structuredClone(jobs);stale.jobs[1].head_sha='b'.repeat(40);
  assert.throws(()=>verifySecretRoutingQuality(pin,run,stale));
  const incomplete=structuredClone(jobs);incomplete.jobs[1].steps=[];
  assert.throws(()=>verifySecretRoutingQuality(pin,run,incomplete));
  const scope='Quality applicability: '+JSON.stringify({paths:3,rust:false,web:false,
    tooling:true,workflow:true,instruction:false,applicability:'scoped'});
  const log='✓ ci-pr-routing-selftest\n82 gates: 82 passed, 0 failed, 0 errors';
  assert.equal(verifySecretRoutingLogs(log,scope).tooling_gates_passed,82);
  assert.throws(()=>verifySecretRoutingLogs(log.replace('✓','✗'),scope));
  assert.throws(()=>verifySecretRoutingLogs(log,scope.replace('"rust":false','"rust":true')));
}

export function selfTestPrQualityCost(){
  selfTestSecretRoutingQuality();
  const sample=pinnedPrQualitySamples[1],run={
    id:sample.after.id,run_attempt:1,head_sha:sample.after.sha,
    name:'CI / Quality Gate',path:qualityPath,event:'pull_request',
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    status:'completed',conclusion:'success',
    created_at:'2026-11-07T13:57:28Z',updated_at:'2026-11-07T14:01:18Z'};
  const specs=[
    ['scope','success',['Classify the exact PR or main-push change']],
    ['web-check','success',['Enforce applicable Quality results at the stable check name']],
    ['rust-check','skipped',[]],['tooling-check','success',['Verify repository tooling Gates']],
    ['web-tests','success',['Verify Web and design Gates',
      'Verify negative fixtures and Acceptance harness contracts',
      'Verify Web artifact integrity and negative fixtures']],['web-dist','skipped',[]]];
  const jobs={total_count:6,jobs:specs.map(([name,conclusion,steps],i)=>({
    name,conclusion,status:'completed',id:40+i,run_id:run.id,
    run_attempt:1,head_sha:run.head_sha,
    steps:steps.map(name=>({name,conclusion:'success'})),
  }))};
  assert.equal(verifyPinnedQualityRun(sample,'after',run,jobs).wall_seconds,230);
  for(const mutated of [
    {...run,run_attempt:2},{...run,head_sha:'a'.repeat(40)},
    {...run,conclusion:'failure'},{...run,event:'push'},
    {...run,head_repository:{full_name:'malicious/fork'}}]){
    assert.throws(()=>verifyPinnedQualityRun(sample,'after',mutated,jobs));
  }
  for(const name of ['scope','web-check','rust-check','tooling-check','web-tests','web-dist']){
    const miss={...jobs,jobs:jobs.jobs.filter(j=>j.name!==name)};
    miss.total_count=miss.jobs.length;
    assert.throws(()=>verifyPinnedQualityRun(sample,'after',run,miss));
    const altered={...jobs,jobs:jobs.jobs.map(j=>j.name===name?
      {...j,head_sha:'b'.repeat(40)}:j)};
    assert.throws(()=>verifyPinnedQualityRun(sample,'after',run,altered));
  }
  const wrongSkipped={...jobs,jobs:jobs.jobs.map(j=>j.name==='web-tests'?
    {...j,conclusion:'skipped'}:j)};
  assert.throws(()=>verifyPinnedQualityRun(sample,'after',run,wrongSkipped));
  assert.deepEqual(verifyProbeCommit(sample,{sha:sample.after.sha,
    parents:[{sha:BASE}],files:[{filename:sample.files[0]}]}),sample.files);
  assert.throws(()=>verifyProbeCommit(sample,{sha:sample.after.sha,
    parents:[{sha:'a'.repeat(40)}],files:[{filename:sample.files[0]}]}));
  assert.throws(()=>verifyProbeCommit(sample,{sha:sample.after.sha,
    parents:[{sha:BASE}],files:[{filename:'web/sneaky.ts'}]}));

  const caseRun={...run,id:sample.caseRun,name:'Acceptance / Case Smoke',path:casesPath};
  const caseJob={name:'case-smoke',id:71,run_id:caseRun.id,
    run_attempt:1,head_sha:caseRun.head_sha,status:'completed',conclusion:'success',
    steps:['Select PR-linked Case-method proofs (trusted main policy)'].map(name=>
      ({name,conclusion:'success'})).concat(['Build runtime',
      'Install selected Case runner dependencies','Install browser Case runtime']
      .map(name=>({name,conclusion:'skipped'})))};
  const caseJobs={total_count:1,jobs:[caseJob]};
  assert.equal(verifyCase(sample,caseRun,caseJobs).runtime_provisioning,'skipped');
  assert.throws(()=>verifyCase(sample,caseRun,{total_count:1,jobs:[{
    ...caseJob,steps:caseJob.steps.map(s=>s.name==='Build runtime'?
      {...s,conclusion:'success'}:s)}]}));
  const e2eRun={...run,id:sample.e2eRun,name:'E2E / Tests',path:e2ePath};
  const e2eJob={name:'e2e',run_id:e2eRun.id,run_attempt:1,head_sha:e2eRun.head_sha,
    status:'completed',conclusion:'success',
    steps:[{name:'Run E2E tests',conclusion:'success'}]};
  assert.equal(verifyE2e(sample,e2eRun,{total_count:1,jobs:[e2eJob]}).verdict,'success');
  assert.throws(()=>verifyE2e(sample,{...e2eRun,conclusion:'failure'},
    {total_count:1,jobs:[{...e2eJob,conclusion:'failure'}]}));
  // The only failing E2E sample remains an authenticated failure, not a Pass.
  const mixed=pinnedPrQualitySamples[2];
  const mixedRun={...e2eRun,id:mixed.e2eRun,head_sha:mixed.after.sha,
    conclusion:'failure'};
  const mixedJobs={total_count:1,jobs:[{...e2eJob,run_id:mixed.e2eRun,
    head_sha:mixed.after.sha,conclusion:'failure',
    steps:[{name:'Run E2E tests',conclusion:'failure'}]}]};
  assert.equal(verifyE2e(mixed,mixedRun,mixedJobs).verdict,'failed_closed');
  assert.throws(()=>verifyE2e(mixed,{...mixedRun,conclusion:'success'},mixedJobs));
  assert.throws(()=>verifyE2e(mixed,mixedRun,{total_count:1,jobs:[
    {...mixedJobs.jobs[0],steps:[{name:'Run E2E tests',conclusion:'success'}]}]}));
  const workflow=readFileSync(new URL('../.github/workflows/agent-sc-acceptance.yml',
    import.meta.url),'utf8');
  assert.ok(workflow.includes("if: inputs.stage != 'pr' || (inputs.stage == 'pr' && (inputs.issue_number == '2917' || inputs.issue_number == '3001' || inputs.issue_number == '3195' || inputs.issue_number == '4117' || inputs.issue_number == '4448' || inputs.issue_number == '4533'))"),
    'only six explicitly allowlisted PR-stage CI collectors are permitted');
  assert.ok(workflow.includes('scripts/acceptance-ci-evidence.mjs collect-pr-quality'),
    'trusted pre-merge CI evidence command is not routed');
  assert.ok(workflow.includes('scripts/acceptance-4117-pr-evidence.mjs collect'),
    'trusted #4117 original-PR evidence collector is not routed');
  assert.ok(workflow.includes('scripts/acceptance-pr-pages-e2e-evidence.mjs collect'),
    'trusted Pages evidence collector is not routed');
  assert.ok(workflow.includes('scripts/acceptance-pr-pages-migration-evidence.mjs collect'),
    'trusted Pages migration evidence collector is not routed');
  assert.ok(workflow.includes('scripts/acceptance-ci-evidence.mjs collect-pr-fixture'),
    'trusted source-fixture CI evidence command is not routed');
  assert.ok(workflow.includes('[[ "${ACCEPTANCE_STAGE}" != "pr" || "${ISSUE_NUMBER}" == 2917 || "${ISSUE_NUMBER}" == 3001 || "${ISSUE_NUMBER}" == 3195 || "${ISSUE_NUMBER}" == 4117 || "${ISSUE_NUMBER}" == 4448 || "${ISSUE_NUMBER}" == 4533 ]]'),
    'prepare stage must only pass the six approved Issues scoped CI evidence');

  console.log('PR Quality timing: exact Run/Attempt/SHA, required job steps, skip, source change and negative fixture contracts passed');
}
