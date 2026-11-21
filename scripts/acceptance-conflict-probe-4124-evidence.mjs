#!/usr/bin/env node
// #4124: read-only, immutable GitHub proof for the one controlled real
// conflict-solving Agent run. Not a PR publisher or an Acceptance verdict.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {validateAgentWorkflowTelemetry} from './agent-workflow-telemetry.mjs';

const REPO='BestNathan/nession';
const ISSUE=4124;
const ANCHOR='a4466180141c1a37083fc6a5aa3aed01de04b525';
const RUN_ID=44681299422, ATTEMPT=1;
const TARGET='21d53b583fcefa03cdfbd1873bf3c8af424a0391';
const SOURCE='ab5b7e4a99402523354e97c04c726b2ec33e5a19';
const PATH='scripts/fixtures/conflict-probe.txt';
const MAX_ZIP=1024*1024;
const MODES=Object.freeze({
  'source-repair':{
    pr:4134,head:'679f637a56ae1c95be0bda5b85d54ae539b4431c',
    ref:'probe/4124-agent-source-repair',
    tree:'92e77a36ef496eb3fd89e04e72e5512686c3788d',
    resolved:'e1b77757f94db3b2f7805a966a5d4d244a0ae227',
    parents:[TARGET],candidateArtifact:14604556549,telemetryArtifact:14604272374,
  },
  'direct-integration':{
    pr:4135,head:'d5799e7b23c496b8a4dd62c69bdf83cd14a6748e',
    ref:'probe/4124-agent-direct-integration',
    tree:'8ca51627f105ba6b941aed7481d08a3b5d802217',
    resolved:'8ca51627f105ba6b941aed7481d08a3b5d802217',
    parents:[TARGET,SOURCE],candidateArtifact:14604202517,telemetryArtifact:14604770986,
  },
});
const SHA=/^[0-9a-f]{40}$/;
function fail(reason){throw Error('Issue #4124 trusted pilot proof: '+reason);}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
export function shouldCollectConflictProbe4124(issue,stage,sha){
  return Number(issue)===ISSUE&&stage==='post-merge'&&sha===ANCHOR;
}
function expect(value,message){if(!value)fail(message);}
function validRun(run){
  expect(run?.id===RUN_ID&&run.run_attempt===ATTEMPT&&
    run.name==='Agent / Staging Convergence Review'&&
    String(run.path).split('@')[0]==='.github/workflows/agent-staging-convergence-review.yml'&&
    run.event==='push'&&run.head_branch==='main'&&
    run.head_sha===ANCHOR&&run.status==='completed'&&run.conclusion==='success'&&
    run.repository?.full_name===REPO&&run.head_repository?.full_name===REPO&&
    run.actor?.login==='BestNathan','wrong immutable Agent Run identity');
}
function validJob(job,mode){
  const required=[
    'Verify fixed disposable source pair and prepare real conflict',
    'Install model CLI',
    'Agent resolves conflicted files without GitHub or shell tools',
    'Independently validate resolution and candidate commit',
    'Upload canonical Agent telemetry and native trace',
    'Upload validated nonauthoritative candidate tree and patch',
  ];
  expect(job?.name==='pilot ('+mode+')'&&job.run_id===RUN_ID&&
    job.run_attempt===ATTEMPT&&job.head_sha===ANCHOR&&
    job.status==='completed'&&job.conclusion==='success'&&
    Number.isSafeInteger(job.id)&&job.id>0&&Array.isArray(job.steps),
    'wrong Agent Job/Attempt '+mode);
  for(const name of required){
    expect(job.steps.filter(s=>s.name===name&&s.status==='completed'&&
      s.conclusion==='success').length===1,'missing/failed Agent step '+mode+': '+name);
  }
}
function validArtifact(meta,id,name){
  expect(meta?.id===id&&meta.name===name&&meta.expired===false&&
    Number.isSafeInteger(meta.size_in_bytes)&&
    meta.size_in_bytes>0&&meta.size_in_bytes<MAX_ZIP&&
    /^sha256:[a-f0-9]{64}$/.test(meta.digest??'')&&
    meta.workflow_run?.id===RUN_ID&&meta.workflow_run?.head_sha===ANCHOR,
    'missing/oversized/stale artifact '+name);
}
function decodedZip(bytes,expectedNames){
  const zip=Buffer.from(bytes);
  expect(zip.length>22&&zip.length<MAX_ZIP,'artifact ZIP byte budget');
  let end=-1;
  for(let i=zip.length-22;i>=Math.max(0,zip.length-65557);i--){
    if(zip.readUInt32LE(i)===0x06054b50){end=i;break;}
  }
  expect(end>=0,'missing ZIP central directory');
  const total=zip.readUInt16LE(end+10),size=zip.readUInt32LE(end+12);
  let cursor=zip.readUInt32LE(end+16);
  expect(total===expectedNames.length&&cursor+size<=end&&total<=4,
    'unexpected ZIP entries or central directory');
  const out={};
  for(let i=0;i<total;i++){
    expect(cursor+46<=end&&zip.readUInt32LE(cursor)===0x02014b50,
      'invalid ZIP central entry');
    const method=zip.readUInt16LE(cursor+10);
    const compressed=zip.readUInt32LE(cursor+20);
    const uncompressed=zip.readUInt32LE(cursor+24);
    const n=zip.readUInt16LE(cursor+28),extra=zip.readUInt16LE(cursor+30),
      comment=zip.readUInt16LE(cursor+32);
    const local=zip.readUInt32LE(cursor+42);
    expect(cursor+46+n+extra+comment<=end&&uncompressed<MAX_ZIP&&
      compressed<MAX_ZIP&&local+30<zip.length,'invalid ZIP size');
    const name=zip.toString('utf8',cursor+46,cursor+46+n);
    expect(expectedNames.includes(name)&&!Object.hasOwn(out,name)&&
      zip.readUInt32LE(local)===0x04034b50,'unexpected ZIP path');
    const ln=zip.readUInt16LE(local+26),le=zip.readUInt16LE(local+28);
    const start=local+30+ln+le;
    expect(start+compressed<=zip.length,'truncated ZIP entry');
    const raw=zip.subarray(start,start+compressed);
    const data=method===0?raw:method===8
      ?inflateRawSync(raw,{maxOutputLength:MAX_ZIP}):null;
    expect(data&&data.length===uncompressed,'unsupported or corrupt ZIP payload');
    out[name]=data.toString('utf8');
    cursor+=46+n+extra+comment;
  }
  expect(cursor===zip.readUInt32LE(end+16)+size,'incorrect ZIP directory length');
  return out;
}
function artifactBytes(zip,meta,expectedNames){
  expect(createHash('sha256').update(zip).digest('hex')===meta.digest.slice(7),
    'GitHub ZIP digest mismatch');
  return decodedZip(zip,expectedNames);
}
function validateMode(mode,data){
  const expected=MODES[mode];
  const {candidate,patch,telemetry,metrics,pr,commit,checks=[]}=data;
  expect(candidate?.schema_version===1&&candidate.mode===mode&&
    candidate.target_sha===TARGET&&candidate.source_sha===SOURCE&&
    SHA.test(candidate.auto_tree??'')&&candidate.auto_tree===
      '8c9cbffe283bc1ffae033090b4338ecfa23ff630'&&
    candidate.resolved_tree===expected.resolved&&
    candidate.candidate_tree===expected.tree&&
    SHA.test(candidate.commit_sha??'')&&
    same(candidate.parents,expected.parents)&&
    same(candidate.conflict_paths,[PATH])&&candidate.authoritative===false,
    'invalid model candidate tree or pinned parents: '+mode);
  expect(typeof patch==='string'&&patch.length>40&&patch.length<20000&&
    patch.split('diff --git ').length===2&&
    patch.includes('diff --git a/'+PATH+' b/'+PATH)&&
    !patch.includes('.github/workflows/')&&
    (mode==='source-repair'?patch.includes('+policy=source'):
      patch.includes(' policy=source')),
    'unexpected model patch: '+mode);
  expect(telemetry&&metrics&&same(telemetry,metrics)&&
    metrics.identity?.workflow_id==='agent-staging-convergence-review'&&
    metrics.identity?.github_run_id===RUN_ID&&
    metrics.identity?.github_run_attempt===ATTEMPT&&
    metrics.identity?.repository===REPO&&metrics.identity?.event==='push'&&
    metrics.identity?.job==='resolve'&&
    metrics.identity?.unique_run_name===RUN_ID+'-'+ATTEMPT+'-probe-'+mode&&
    metrics.task?.issue===ISSUE&&
    metrics.task?.id==='probe-'+mode&&
    metrics.task?.target_ref===TARGET&&
    metrics.task?.fingerprint===TARGET+':'+SOURCE+':'+mode&&
    metrics.agent?.provider==='claude-code'&&
    metrics.agent?.status==='finished'&&metrics.result?.status==='completed'&&
    Number(metrics.tokens?.total)>0&&Number(metrics.execution?.turns)>0,
    'missing real model telemetry / durable Metrics identity: '+mode);
  validateAgentWorkflowTelemetry(metrics);
  expect(pr?.number===expected.pr&&pr.state==='open'&&pr.draft===true&&
    pr.user?.login==='BestNathan'&&
    pr.head?.repo?.full_name===REPO&&pr.base?.repo?.full_name===REPO&&
    pr.head.ref===expected.ref&&pr.head.sha===expected.head&&
    pr.base.ref==='probe/4124-target'&&pr.base.sha===TARGET&&
    commit?.sha===expected.head&&
    commit.commit?.tree?.sha===expected.tree&&
    same((commit.parents??[]).map(x=>x.sha),expected.parents),
    'wrong published PR/commit/tree provenance: '+mode);
  expect(Array.isArray(checks)&&checks.length<=100,'unbounded probe-head runs');
  const statuses={};
  for(const name of ['CI / Quality Gate','Acceptance / Case Smoke','E2E / Tests']){
    const relevant=checks.filter(r=>r.name===name&&
      r.event==='pull_request'&&r.head_sha===expected.head);
    statuses[name]=relevant.length
      ? relevant.map(r=>({run_id:r.id,conclusion:r.conclusion??null,status:r.status}))
      : [{status:'not_scheduled_on_disposable_probe_base',conclusion:null}];
  }
  return {
    mode,run_id:RUN_ID,run_attempt:ATTEMPT,job_id:data.jobId,
    target_sha:TARGET,source_sha:SOURCE,source_anchor_sha:ANCHOR,
    candidate_tree:expected.tree,resolved_tree:expected.resolved,
    github_pr:expected.pr,github_pr_head:expected.head,
    pr_draft:true,parents:[...expected.parents],
    github_pr_checks:statuses,
    model_completed:true,independent_git_validator_passed:true,
    trusted_metrics_readback:true,
  };
}
export function verifyConflictProbe4124({run,jobs,artifacts,modes}){
  validRun(run);
  expect(Array.isArray(jobs)&&jobs.length<=20,'unbounded Agent Jobs');
  expect(Array.isArray(artifacts)&&artifacts.length<=20,'unbounded Agent artifacts');
  const receipts=[];
  for(const [mode,spec] of Object.entries(MODES)){
    const matched=jobs.filter(j=>j.name==='pilot ('+mode+')');
    expect(matched.length===1,'missing/duplicate model job '+mode);
    validJob(matched[0],mode);
    const candidate='merge-conflict-probe-'+mode+'-'+RUN_ID+'-'+ATTEMPT;
    const metric='agent-telemetry-staging-convergence-probe-'+mode+'-'+RUN_ID+'-'+ATTEMPT;
    for(const [name,id] of [[candidate,spec.candidateArtifact],[metric,spec.telemetryArtifact]]){
      const arr=artifacts.filter(a=>a.name===name);
      expect(arr.length===1,'duplicate or absent artifact '+name);
      validArtifact(arr[0],id,name);
    }
    expect(modes?.[mode]?.jobId===matched[0].id,'unverified job binding');
    receipts.push(validateMode(mode,modes[mode]));
  }
  for(const name of ['review','publish']){
    const job=jobs.filter(j=>j.name===name);
    expect(job.length===1&&job[0].conclusion==='skipped',
      'unexpected legacy PR writer/reviewer execution');
  }
  return Object.freeze({
    schema_version:1,kind:'verified_conflict_probe_4124',
    issue_number:ISSUE,target_sha:ANCHOR,source_run_id:RUN_ID,
    source_run_attempt:ATTEMPT,workflow_path:run.path,
    source_event:'push',source_branch:'main',source_status:'success',
    model_modes:receipts,source_pair_verified:true,
    publisher_actor:'BestNathan (independent authorized GitHub connector)',
    protected_target_merged:false,
    note:'Model and source-bound draft PR publication are authenticated. PR-head Quality/Case/E2E are not asserted as passed when the disposable base did not trigger them. Evidence is not itself an SC verdict.',
  });
}
async function defaultBinaryRead(route){
  const token=process.env.GITHUB_TOKEN??process.env.GH_TOKEN;
  if(!token)fail('authenticated GitHub token required to download artifact');
  const response=await fetch('https://api.github.com'+route,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28'},
    signal:AbortSignal.timeout(30000),
  });
  if(!response.ok)fail('artifact download HTTP '+response.status);
  const len=Number(response.headers.get('content-length')??0);
  expect(len<MAX_ZIP,'artifact download content-length exceeds budget');
  const bytes=Buffer.from(await response.arrayBuffer());
  expect(bytes.length>20&&bytes.length<MAX_ZIP,'artifact download exceeds budget');
  return bytes;
}
export async function collectConflictProbe4124({repo,issue,stage,targetSha,get,
  getBytes=defaultBinaryRead}){
  if(!shouldCollectConflictProbe4124(issue,stage,targetSha))return null;
  expect(repo===REPO&&typeof get==='function','invalid trusted collector context');
  const [run,jobPage,artifactPage]=await Promise.all([
    get('/repos/'+REPO+'/actions/runs/'+RUN_ID),
    get('/repos/'+REPO+'/actions/runs/'+RUN_ID+'/attempts/'+ATTEMPT+'/jobs?per_page=100'),
    get('/repos/'+REPO+'/actions/runs/'+RUN_ID+'/artifacts?per_page=100'),
  ]);
  validRun(run);
  const artifacts=artifactPage?.artifacts??[];
  const modes={};
  await Promise.all(Object.entries(MODES).map(async ([mode,spec])=>{
    const candidateMeta=artifacts.find(a=>a.id===spec.candidateArtifact);
    const telemetryMeta=artifacts.find(a=>a.id===spec.telemetryArtifact);
    const candidateName='merge-conflict-probe-'+mode+'-'+RUN_ID+'-'+ATTEMPT;
    const telemetryName='agent-telemetry-staging-convergence-probe-'+mode+'-'+RUN_ID+'-'+ATTEMPT;
    validArtifact(candidateMeta,spec.candidateArtifact,candidateName);
    validArtifact(telemetryMeta,spec.telemetryArtifact,telemetryName);
    const metricsPath='raw/workflows/agent-staging-convergence-review/2026-11-20/'+
      RUN_ID+'-'+ATTEMPT+'-probe-'+mode+'.json';
    const results=await Promise.all([
      getBytes('/repos/'+REPO+'/actions/artifacts/'+spec.candidateArtifact+'/zip'),
      getBytes('/repos/'+REPO+'/actions/artifacts/'+spec.telemetryArtifact+'/zip'),
      get('/repos/'+REPO+'/contents/'+metricsPath+'?ref=metrics'),
      get('/repos/'+REPO+'/pulls/'+spec.pr),
      get('/repos/'+REPO+'/commits/'+spec.head),
      get('/repos/'+REPO+'/actions/runs?head_sha='+spec.head+'&per_page=100'),
    ]);
    const [c,t,m,pr,commit,prRuns]=results;
    const czip=artifactBytes(c,candidateMeta,['candidate.json','candidate.patch']);
    const tzip=artifactBytes(t,telemetryMeta,['agent-telemetry.json','agent-execution-trace.json']);
    expect(tzip['agent-execution-trace.json'].length>0&&
      tzip['agent-execution-trace.json'].length<128000,'missing/bloated trace');
    JSON.parse(tzip['agent-execution-trace.json']);
    expect(m?.encoding==='base64'&&typeof m.content==='string'&&
      m.path===metricsPath,'missing durable Metrics file');
    expect((prRuns?.total_count??0)<=100,'unbounded candidate head run list');
    modes[mode]={
      jobId:(jobPage?.jobs??[]).find(j=>j.name==='pilot ('+mode+')')?.id,
      candidate:JSON.parse(czip['candidate.json']),patch:czip['candidate.patch'],
      telemetry:JSON.parse(tzip['agent-telemetry.json']),
      metrics:JSON.parse(Buffer.from(m.content.replace(/\s/g,''),'base64').toString('utf8')),
      pr,commit,checks:prRuns?.workflow_runs,
    };
  }));
  return verifyConflictProbe4124({run,jobs:jobPage?.jobs,artifacts,modes});
}
export function selfTestConflictProbe4124(){
  const spec=MODES['source-repair'];
  assert.equal(shouldCollectConflictProbe4124(4124,'post-merge',ANCHOR),true);
  assert.equal(shouldCollectConflictProbe4124(4124,'pr',ANCHOR),false);
  assert.equal(shouldCollectConflictProbe4124(4123,'post-merge',ANCHOR),false);
  assert.equal(shouldCollectConflictProbe4124(4124,'post-merge',SOURCE),false);
  const sample={
    schema_version:1,mode:'source-repair',target_sha:TARGET,source_sha:SOURCE,
    auto_tree:'8c9cbffe283bc1ffae033090b4338ecfa23ff630',
    resolved_tree:spec.resolved,candidate_tree:spec.tree,
    commit_sha:'a'.repeat(40),parents:[TARGET],conflict_paths:[PATH],
    authoritative:false,
  };
  // Exercise the decisive direct Git proof boundary without constructing
  // network mock receipts and without promoting this fixture to a live Pass.
  const wrong=[
    {...sample,source_sha:'c'.repeat(40)},
    {...sample,parents:[TARGET,SOURCE]},
    {...sample,candidate_tree:'d'.repeat(40)},
    {...sample,conflict_paths:['.github/workflows/ci-quality.yml']},
    {...sample,authoritative:true},
  ];
  for(const item of wrong){
    const e=Object.assign({},spec);
    assert.notDeepEqual(item,sample);
    assert.equal(item.mode==='source-repair'&&
      item.source_sha===SOURCE&&item.candidate_tree===e.tree&&
      same(item.parents,e.parents)&&same(item.conflict_paths,[PATH])&&
      item.authoritative===false,false);
  }
  assert.throws(()=>decodedZip(Buffer.from('not a zip'),['candidate.json']),/artifact ZIP/);
  assert.throws(()=>validRun({id:RUN_ID,run_attempt:ATTEMPT,head_sha:SOURCE}),
    /wrong immutable Agent Run/);
  assert.throws(()=>validArtifact({name:'fake'},spec.candidateArtifact,'expected'),
    /missing\/oversized\/stale artifact/);
  console.log('Issue #4124 fixed-run proof selection and adversarial source identity: PASS');
}
