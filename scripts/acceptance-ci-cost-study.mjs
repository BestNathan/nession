#!/usr/bin/env node
// #1876 SC-07: bounded, SHA-pinned historical CI timings from original
// GitHub runs/jobs/logs. Historical pins are discovery only. The source
// Run/Attempt/Job timestamps and measured receipts are read and verified fresh.
// Quantiles over tiny samples are descriptive, not a forecast or SLA.
import assert from 'node:assert/strict';

const REPO = 'BestNathan/nession';
const SHA = /^[a-f0-9]{40}$/;
const WF_E2E = '.github/workflows/e2e-tests.yml';
const WF_QUALITY = '.github/workflows/ci-quality.yml';
const WF_PROOF = '.github/workflows/ci-web-dist-reuse-proof.yml';
const SAMPLE = Object.freeze([
  {id:39022264575,sha:'19c107463906821b2bf363b24178f28e8bebe30c',type:'full',period:'before',event:'push'},
  {id:39023926837,sha:'597fc54ad7db9e3b7ac6431656fddfae5f6f79f4',type:'full',period:'before',event:'push'},
  {id:39044192153,sha:'0989ca9be69f2a11a9da75e0bf367bc806f519d2',type:'full',period:'after',event:'push'},
  {id:39044760769,sha:'d2091652d6ce062c94f7b6b48addab20dec29a3d',type:'full',period:'after',event:'push'},
  {id:39023355851,sha:'c751b76b150add74791ab24c60507d814ab25bfc',type:'selected',period:'before',event:'pull_request'},
  {id:39041376254,sha:'adf9c7c2a35966116a8ec4fd0d31ef93a2fdb210',type:'selected',period:'after',event:'pull_request'},
  {id:39043603600,sha:'43c734c666e785a9eddb59403a50ea8ede474592',type:'selected',period:'after',event:'pull_request'},
  {id:39027536991,sha:'3951a427935a24950a789827834f506dea103743',type:'not-required',period:'before',event:'pull_request'},
  {id:39031997222,sha:'9ab3775e6802dd3db99d3ee9e73c11b3a91e0530',type:'not-required',period:'after',event:'pull_request'},
]);
const QUALITY = Object.freeze([
  {id:39022264666,sha:'19c107463906821b2bf363b24178f28e8bebe30c',period:'before'},
  {id:39023926807,sha:'597fc54ad7db9e3b7ac6431656fddfae5f6f79f4',period:'before'},
  {id:39044192116,sha:'0989ca9be69f2a11a9da75e0bf367bc806f519d2',period:'after'},
  {id:39044760686,sha:'d2091652d6ce062c94f7b6b48addab20dec29a3d',period:'after'},
]);
const PROOF = Object.freeze([
  {id:39044530016,sha:'0989ca9be69f2a11a9da75e0bf367bc806f519d2'},
  {id:39045237466,sha:'d2091652d6ce062c94f7b6b48addab20dec29a3d'},
]);
const rounded=(n)=>Math.round(n*100)/100;
const duration=(a,b)=>{
  const t1=Date.parse(a??''),t2=Date.parse(b??'');
  assert.ok(Number.isFinite(t1)&&Number.isFinite(t2)&&t2>=t1,'invalid source time ordering');
  return rounded((t2-t1)/1000);
};
function stepDuration(job,name) {
  const steps=job.steps?.filter(s=>s.name===name&&s.conclusion==='success')??[];
  if(steps.length!==1)return null;
  return duration(steps[0].started_at,steps[0].completed_at);
}
const sumDefined=(xs)=>rounded(xs.filter(x=>x!==null).reduce((a,b)=>a+b,0));
function sourceRun(pin,run,jobResponse,workflow,jobNames) {
  assert.equal(run?.id,pin.id);
  assert.equal(run?.run_attempt,1,'unexpected rerun changes baseline cohort');
  assert.equal(run?.head_sha,pin.sha);
  assert.ok(SHA.test(pin.sha));
  assert.equal(run?.name,workflow==='e2e'?'E2E / Tests':workflow==='quality'?
    'CI / Quality Gate':'CI / Web Dist Reuse Proof');
  assert.equal(run?.path,workflow==='e2e'?WF_E2E:workflow==='quality'?WF_QUALITY:WF_PROOF);
  assert.equal(run?.event,pin.event??(workflow==='proof'?'workflow_run':'push'));
  assert.equal(run?.status,'completed');
  assert.equal(run?.conclusion,'success');
  assert.equal(run?.repository?.full_name,REPO);
  assert.equal(run?.head_repository?.full_name,REPO);
  assert.ok(Array.isArray(jobResponse?.jobs)&&jobResponse.jobs.length>0&&
    jobResponse.jobs.length<=100&&jobResponse.total_count<=100);
  const jobs=jobResponse.jobs.filter(j=>jobNames.includes(j.name));
  assert.equal(jobs.length,jobNames.length,'missing/ambiguous source jobs');
  for(const job of jobs){
    assert.equal(job.run_id,run.id);
    assert.equal(job.run_attempt,1);
    assert.equal(job.head_sha,pin.sha);
    assert.equal(job.status,'completed');
    assert.equal(job.conclusion,'success');
  }
  const job_seconds=sumDefined(jobs.map(j=>duration(j.started_at,j.completed_at)));
  return {run_id:run.id,sha:run.head_sha,event:run.event,source:run.html_url,
    period:pin.period??'after',kind:pin.type??workflow,
    wall_seconds:duration(run.created_at,run.updated_at),
    queue_seconds:duration(run.created_at,jobs.reduce((min,j)=>
      Date.parse(j.started_at)<Date.parse(min)?j.started_at:min,jobs[0].started_at)),
    runner_seconds:job_seconds,jobs};
}
function logReceipt(log,prefix){
  if(typeof log!=='string'||log.length>4194304)throw Error('unbounded timing log');
  const rows=log.split(/\r?\n/).filter(x=>x.includes(prefix));
  if(rows.length!==1)return null;
  const raw=rows[0].slice(rows[0].indexOf(prefix)+prefix.length).trim();
  if(raw.length>16384)throw Error('oversized timing record');
  return JSON.parse(raw);
}
export function measureSample(pin,run,jobs,log){
  if(!SAMPLE.some(x=>x.id===pin?.id&&x.sha===pin?.sha))throw Error('unknown sample');
  const proof=sourceRun(pin,run,jobs,'e2e',['e2e']);
  const job=proof.jobs[0];
  const baselineWeb=stepDuration(job,'Run cd web && npm ci && npm run build');
  const npmWeb=stepDuration(job,'Install Web preview dependencies');
  const separateBuild=stepDuration(job,'Build Web on cold/mismatched artifact');
  const stageReceipt=logReceipt(log,'WEB_BUILD_TIMINGS_V1 ');
  if(stageReceipt) {
    assert.equal(stageReceipt.status,'Pass');
    assert.equal(stageReceipt.target_sha,pin.sha);
    assert.ok(Number.isSafeInteger(stageReceipt.total_duration_ms) &&
      stageReceipt.total_duration_ms>0);
    assert.deepEqual(stageReceipt.stages.map(s=>s.stage),
      ['typescript','vite','font_licenses']);
    for(const stage of stageReceipt.stages)assert.ok(
      stage.status==='success'&&Number.isSafeInteger(stage.duration_ms)&&stage.duration_ms>=0);
    assert.ok(separateBuild!==null,'stage timing proof without real build');
  }
  const full=logReceipt(log,'E2E_FULL_GATE_PROVISION_V1 ');
  const selected=logReceipt(log,'E2E_SELECTED_RUN_RECEIPT_V1 ');
  const none=logReceipt(log,'E2E_NOT_REQUIRED_RECEIPT_V1 ');
  if(pin.type==='full'&&full)assert.ok(full.sha===pin.sha&&
    full.run_id===pin.id&&full.provisions===1);
  if(pin.type==='selected'&&selected)assert.ok(selected.sha===pin.sha&&
    selected.run_id===pin.id&&selected.provisioned_runtimes===1);
  if(pin.type==='not-required') {
    assert.ok(none&&none.sha===pin.sha&&none.run_id===pin.id&&
      none.plan_mode==='not-required');
    for(const name of ['Install Rust toolchain','Install tmux','Build Rust binaries'])
      assert.equal(job.steps.find(s=>s.name===name)?.conclusion,'skipped');
  }
  const breakdown={
    browser_preparation_seconds:stepDuration(job,'Run cd e2e'),
    web_npm_install_seconds:npmWeb,
    web_typescript_seconds:stageReceipt?
      rounded(stageReceipt.stages[0].duration_ms/1000):null,
    web_vite_seconds:stageReceipt?
      rounded(stageReceipt.stages[1].duration_ms/1000):null,
    web_font_license_seconds:stageReceipt?
      rounded(stageReceipt.stages[2].duration_ms/1000):null,
    web_cold_build_seconds:separateBuild,
    web_legacy_npm_and_build_seconds:baselineWeb,
    rust_build_seconds:stepDuration(job,'Build Rust binaries')??
      stepDuration(job,'Run cargo build -p nession-server -p nession-agent'),
    design_standalone_seconds:stepDuration(job,'Run canonical browser design gate')??
      stepDuration(job,'Run canonical browser design gate (standalone)'),
    e2e_step_seconds:stepDuration(job,'Run E2E tests'),
    preview_parity_seconds:stepDuration(job,'Verify runnable Web preview and proxy parity'),
    // After deduplication the design suite RUNS INSIDE the Full/Selected E2E
    // step; a zero-second verdict step does not imply free browser execution.
    design_embedded_in_e2e:pin.period==='after'&&pin.type!=='not-required',
    full_stack_provisions:full?.provisions??selected?.provisioned_runtimes??null,
    web_reuse_status:log.includes('"status":"hit"')?'hit':
      log.includes('WEB_BUILD_REUSE_V1')?'miss':null,
  };
  return {...proof,jobs:undefined,breakdown,
    sample_quality:'observed exact successful Run/Attempt/Job timestamps; no fabricated substep'};
}
const median=(data)=>{
  if(!data.length)return null;
  const a=[...data].sort((x,y)=>x-y);
  return rounded(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2);
};
const p90=(data)=>{
  if(!data.length)return null;
  const a=[...data].sort((x,y)=>x-y);
  return a[Math.ceil(a.length*.9)-1];
};
export function summarizeCost(samples,quality,proofs){
  const modes=['full','selected','not-required'];
  const rows=[];
  for(const type of modes)for(const period of ['before','after']){
    const src=samples.filter(x=>x.kind===type&&x.period===period);
    const values=src.map(x=>x.runner_seconds);
    rows.push({mode:type,period,samples:src.length,runner_median_seconds:median(values),
      runner_p90_seconds:p90(values),
      small_sample_warning:src.length<5,
      actual_run_ids:src.map(x=>x.run_id)});
  }
  const joined=samples.filter(x=>x.kind==='full').map(x=>{
    const q=quality.find(q=>q.sha===x.sha);
    assert.ok(q,'missing matched exact-SHA Quality Gate');
    const p=proofs.find(p=>p.sha===x.sha);
    return {sha:x.sha,period:x.period,e2e_run_id:x.run_id,
      quality_run_id:q.run_id,consumer_run_id:p?.run_id??null,
      scope_runner_seconds:rounded(x.runner_seconds+q.runner_seconds+(p?.runner_seconds??0)),
      e2e_runner_seconds:x.runner_seconds,quality_runner_seconds:q.runner_seconds,
      proof_consumer_runner_seconds:p?.runner_seconds??0};
  });
  const paired= ['before','after'].map(period=>{
    const vals=joined.filter(x=>x.period===period).map(x=>x.scope_runner_seconds);
    return {period,n:vals.length,scope_median_runner_seconds:median(vals),
      scope_p90_runner_seconds:p90(vals)};
  });
  return {schema_version:1,kind:'sc07_verified_ci_cost_study',
    scope:'historical fixed cohorts with independently re-read GitHub source runs',
    cohorts:rows,exact_sha_quality_and_e2e_cost:joined,
    paired_scope_summary:paired,
    caveats:['p90 is descriptive only at n<5',
      'legacy npm install + TS/Vite build is indivisible in historical workflow logs',
      'post-dedup design tests are inside the actual E2E duration, not zero-cost',
      'selected pre/post IDs and not-required histories are small samples',
      'dedicated Web proof is extra runner occupation; not E2E cache speedup']};
}
export async function collectVerifiedCiCostStudy({issueNumber,repo,get,getText}){
  if(issueNumber!==1876)return null;
  if(repo!==REPO)throw Error('wrong CI cost study repository');
  const load=async(pin,workflow,jobNames,log)=>(async()=>{
    const [run,jobs]=await Promise.all([
      get('/repos/'+repo+'/actions/runs/'+pin.id),
      get('/repos/'+repo+'/actions/runs/'+pin.id+'/attempts/1/jobs?per_page=100'),
    ]);
    if(log){
      assert.equal(jobs.jobs?.filter(j=>j.name==='e2e').length,1);
      const id=jobs.jobs.find(j=>j.name==='e2e').id;
      return measureSample(pin,run,jobs,
        await getText('/repos/'+repo+'/actions/jobs/'+id+'/logs',4194304));
    }
    const result=sourceRun(pin,run,jobs,workflow,jobNames);
    return {...result,jobs:undefined};
  })();
  const [samples,quality,proofs]=await Promise.all([
    Promise.all(SAMPLE.map(p=>load(p,'e2e',['e2e'],true))),
    Promise.all(QUALITY.map(p=>load(p,'quality',['web-check','rust-check'],false))),
    Promise.all(PROOF.map(p=>load(p,'proof',['verify'],false))),
  ]);
  return {...summarizeCost(samples,quality,proofs),samples};
}
export function selfTestCiCostStudy(){
  const pin=SAMPLE[0],start='2026-10-17T00:00:00Z';
  const run={id:pin.id,run_attempt:1,head_sha:pin.sha,name:'E2E / Tests',path:WF_E2E,
    event:pin.event,status:'completed',conclusion:'success',created_at:start,
    updated_at:'2026-10-17T00:04:00Z',repository:{full_name:REPO},
    head_repository:{full_name:REPO}};
  const job={name:'e2e',id:2,run_id:pin.id,run_attempt:1,head_sha:pin.sha,
    status:'completed',conclusion:'success',
    started_at:'2026-10-17T00:00:20Z',completed_at:'2026-10-17T00:03:40Z',
    steps:[{name:'Run E2E tests',conclusion:'success',started_at:'2026-10-17T00:01:00Z',
      completed_at:'2026-10-17T00:03:00Z'}]};
  const jobs={jobs:[job],total_count:1};
  const x=measureSample(pin,run,jobs,'');
  assert.equal(x.runner_seconds,200);
  assert.equal(x.queue_seconds,20);
  assert.equal(x.breakdown.e2e_step_seconds,120);
  for(const [r,j] of [
    [{...run,head_sha:'a'.repeat(40)},jobs],
    [{...run,conclusion:'failure'},jobs],
    [run,{jobs:[{...job,run_attempt:2}],total_count:1}],
    [run,{jobs:[],total_count:0}],
    [run,{jobs:[{...job,completed_at:'2026-10-16T00:00:00Z'}],total_count:1}],
  ]) assert.throws(()=>measureSample(pin,r,j,''));
  assert.equal(median([1,3,5,7]),4);
  assert.equal(p90([1,3,5,7]),7);
  assert.equal(summarizeCost([{...x,kind:'full',period:'before'}],
    [{sha:x.sha,run_id:1,runner_seconds:10}],[]).exact_sha_quality_and_e2e_cost[0].scope_runner_seconds,210);
  console.log('CI cost study: source SHA/run/job/time negatives, bounded quantiles pass');
}
if(process.argv[1]?.endsWith('acceptance-ci-cost-study.mjs')&&process.argv[2]==='self-test')
  selfTestCiCostStudy();
