#!/usr/bin/env node
// #3536: trusted, read-only proof of an actual Main Full failure -> admission
// -> fingerprint -> Bug (or authenticated analysis-reuse) chain.
// Green publisher runs, static workflow code and successful Full runs are not evidence.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fingerprint} from './e2e-failure-admission.mjs';
import {fingerprintLabel, fingerprintMarker} from './lib/agent/publisher/e2e-failure-bug.mjs';

const REPO='BestNathan/nession';
const FULL='.github/workflows/e2e-full-regression.yml';
const SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^sha256:[a-f0-9]{64}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const hash=s=>createHash('sha256').update(s).digest('hex');
const missing='missing authenticated completed failed Main Full Run/Attempt, immutable diagnostic artifact/Store admission, stable fingerprint and matching Bug Issue or ANALYSIS_REUSED receipt';
function deny(reason){throw Error('unverified live Main Full failure publication: '+reason);}
export function requiresLiveFullFailureProof(text){
  return /\bFull(?: Regression)?\b/i.test(text??'') &&
    /\bfail(?:ed|ure|ing)?\b/i.test(text??'') &&
    /\bBug\b/i.test(text??'') &&
    /\b(observation|publish|flow|deduplicat|enter|record|link|report)\w*\b/i.test(text??'');
}
export function shouldCollectLiveFullFailure(stage,issue){
  if(stage!=='post-merge')return false;
  const section=String(issue?.body??'').match(/### Success Criteria\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]??'';
  return section.split(/\r?\n/).some(line=>/^- \[[ x]\] SC-\d{2,}\b/.test(line)&&
    requiresLiveFullFailureProof(line));
}
function checkedJson(envelope,max=262144){
  if(envelope?.encoding!=='base64'||!Number.isSafeInteger(envelope.size)||
      envelope.size<1||envelope.size>max||typeof envelope.content!=='string')
    deny('Store contents response is missing or unbounded');
  const bytes=Buffer.from(envelope.content.replace(/\s/g,''),'base64');
  if(bytes.length!==envelope.size||bytes.length>max)deny('Store bytes do not match envelope');
  let parsed;
  try{parsed=JSON.parse(bytes.toString('utf8'));}catch{deny('invalid Store JSON');}
  return {value:parsed,bytes};
}
export function attestLiveFullFailure({run,job,artifact,record,index,recordBytes,
  observation,head,state,stateBytes,issue}){
  if(run?.path!==FULL||run.head_branch!=='main'||run.status!=='completed'||
     run.conclusion!=='failure'||!['schedule','workflow_dispatch','push'].includes(run.event)||
     run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO||
     !SHA.test(run.head_sha??'')||!positive(run.id)||!positive(run.run_attempt)||
     !positive(run.workflow_id))deny('source is not a completed failed Main Full Run/Attempt');
  if(job?.name!=='full'||job.run_id!==run.id||job.run_attempt!==run.run_attempt||
     job.head_sha!==run.head_sha||job.status!=='completed'||job.conclusion!=='failure'||
     !positive(job.id)||!Number.isFinite(Date.parse(job.started_at??''))||
     !Number.isFinite(Date.parse(job.completed_at??''))||
     Date.parse(job.started_at)>Date.parse(job.completed_at))
    deny('failed Full job does not bind source Run/Attempt/SHA');
  if(artifact?.name!=='full-regression-'+run.id+'-'+run.run_attempt||
     artifact.expired!==false||!positive(artifact.id)||!DIGEST.test(artifact.digest??'')||
     artifact.workflow_run?.id!==run.id||artifact.workflow_run?.head_sha!==run.head_sha||
     !positive(artifact.size_in_bytes)||artifact.size_in_bytes>1024*1024*1024||
     !Number.isFinite(Date.parse(artifact.created_at??''))||
     Date.parse(artifact.created_at)<Date.parse(job.started_at)||
     Date.parse(artifact.created_at)>Date.parse(job.completed_at))
    deny('missing exact-attempt immutable Full diagnostic artifact');
  const recordPath='runs/'+run.head_sha+'/full-regression/'+run.id+'-'+run.run_attempt+'.json';
  if(record?.schema_version!==1||record.kind!=='e2e_full_failure_observation'||
     record.trust!=='authenticated_github_run_and_artifact_digest'||
     record.evaluation!=='NOT_EVALUATED'||record.agent_dispatch!=='NOT_AUTHORIZED'||
     record.source?.repository!==REPO||record.source.workflow_path!==FULL||
     record.source.workflow_id!==run.workflow_id||record.source.event!==run.event||
     record.source.branch!=='main'||record.source.conclusion!=='failure'||
     record.source.run_id!==run.id||record.source.run_attempt!==run.run_attempt||
     record.source.source_sha!==run.head_sha||record.source.completed_at!==job.completed_at||
     record.artifact?.id!==artifact.id||record.artifact.name!==artifact.name||
     record.artifact.digest!==artifact.digest||
     !DIGEST.test('sha256:'+String(record.evidence?.archive_sha256??''))||
     record.evidence.archive_sha256!==artifact.digest.slice(7)||
     record.candidate?.status!=='FAILED_TESTS_OBSERVED'||
     !Array.isArray(record.candidate.results)||record.candidate.results.length>64||
     !Buffer.isBuffer(recordBytes)||
     index?.kind!=='e2e_full_failure_observation_index'||index.schema_version!==1||
     index.source_sha!==run.head_sha||index.run_id!==run.id||
     index.run_attempt!==run.run_attempt||index.record_path!==recordPath||
     index.record_sha256!==hash(recordBytes))
    deny('immutable acceptance-results observation/index not bound to source');
  const sigs=record.candidate.results.flatMap(r=>
    positive(r?.failed)&&Array.isArray(r.failures)&&r.failures.length<=8
      ?r.failures.map(sig=>({test_id:r.id,...sig})):[]);
  const fingerprints=sigs.map(sig=>fingerprint(sig)).filter(fp=>fp.status==='FINGERPRINTED');
  const fp=observation?.fingerprint;
  if(!fingerprints.some(x=>x.fingerprint===fp))deny('Store observation fingerprint differs from Full failure signature');
  const digest=fp.slice(5);
  if(observation?.schema_version!==1||
     observation.kind!=='e2e_failure_admission_observation'||
     observation.source?.repository!==REPO||observation.source.workflow_path!==FULL||
     observation.source.run_id!==run.id||observation.source.run_attempt!==run.run_attempt||
     observation.source.target_sha!==run.head_sha||
     observation.source.event!==run.event||observation.source.conclusion!=='failure'||
     observation.source.acceptance_record_path!==recordPath||
     observation.artifact?.id!==artifact.id||observation.artifact.digest!==artifact.digest||
     observation.classification!=='candidate_test_failure'||
     !Array.isArray(observation.failure_signatures)||
     !observation.failure_signatures.some(s=>s?.actionable===true&&
       fingerprints.some(x=>x.fingerprint===fingerprint({
         test_id:s.test_id,kind:s.kind,...s.signature}).fingerprint)))
    deny('agent-store admission observation does not match failed Run and fingerprint');
  if(head?.version!==state?.version||!positive(head?.version)||
     head.path!=='e2e-failures/'+digest+'/states/'+String(head.version).padStart(8,'0')+'.json'||
     head.sha256!==hash(stateBytes)||state?.schema_version!==1||
     state.kind!=='e2e_failure_admission_state'||state.fingerprint!==fp||
     !positive(state.epoch)||state.analysis_id!==digest+':'+state.epoch)
    deny('agent-store CAS head/state is not authenticated');
  let outcome;
  if(state.status==='issue_linked'&&positive(state.bug_issue)){
    if(issue?.number!==state.bug_issue||issue.pull_request||
       !['open','closed'].includes(issue.state)||
       !Array.isArray(issue.labels)||
       !issue.labels.some(x=>(typeof x==='string'?x:x?.name)===fingerprintLabel(fp))||
       !String(issue.body??'').includes(fingerprintMarker(fp))||
       !String(issue.body??'').includes('<!-- nession-e2e-failure-analysis: '+state.analysis_id+' -->')||
       state.dispatch_intent?.status!=='acknowledged')
      deny('linked Bug Issue does not match fingerprint and admitted analysis');
    outcome='BUG_LINKED';
  }else if(state.status==='analyzed'&&state.dispatch_intent?.status==='committed'&&
      state.latest_observation?.run_id!==run.id&&
      positive(state.dispatch_run?.run_id)){
    // A later exact-run observation for an already analyzed fingerprint is a
    // deterministic reused analysis, even before a publisher links a Bug.
    outcome='ANALYSIS_REUSED';
  }else deny('no matching Bug Issue or authenticated ANALYSIS_REUSED outcome');
  return {kind:'verified_live_main_full_failure_publication',source_run_id:run.id,
    source_attempt:run.run_attempt,source_sha:run.head_sha,
    artifact_id:artifact.id,artifact_digest:artifact.digest,
    acceptance_record_path:recordPath,fingerprint:fp,
    outcome,bug_issue:outcome==='BUG_LINKED'?state.bug_issue:null};
}
export async function collectLiveFullFailure({repo=REPO,anchorSha,get,isAncestor,
  maxPages=5,pageSize=20}){
  if(repo!==REPO||!SHA.test(anchorSha??'')||typeof get!=='function'||
     typeof isAncestor!=='function'||!Number.isInteger(maxPages)||maxPages<1||maxPages>5||
     !Number.isInteger(pageSize)||pageSize<1||pageSize>20)
    deny('invalid bounded read-only collector scope');
  let examined=0;
  for(let page=1;page<=maxPages&&examined<6;page++){
    const list=await get('/repos/'+repo+'/actions/workflows/e2e-full-regression.yml/runs?'+
      new URLSearchParams({branch:'main',per_page:String(pageSize),page:String(page)}));
    if(!Array.isArray(list?.workflow_runs)||list.workflow_runs.length>pageSize)
      deny('unbounded Main Full run listing');
    for(const run of list.workflow_runs){
      if(examined>=6)break;
      if(run?.conclusion!=='failure'||run.status!=='completed'||
         run.path!==FULL||run.head_branch!=='main'||!SHA.test(run.head_sha??'')||
         !isAncestor(anchorSha,run.head_sha))continue;
      examined++;
      try{
        const [source,jobs,artifacts]=await Promise.all([
          get('/repos/'+repo+'/actions/runs/'+run.id),
          get('/repos/'+repo+'/actions/runs/'+run.id+'/attempts/'+run.run_attempt+'/jobs?per_page=100'),
          get('/repos/'+repo+'/actions/runs/'+run.id+'/artifacts?per_page=100')]);
        if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>100||
           !Array.isArray(artifacts?.artifacts)||artifacts.artifacts.length>100)
          deny('unbounded jobs or artifacts');
        const matching=jobs.jobs.filter(x=>x.name==='full'&&x.run_attempt===run.run_attempt);
        const zip=artifacts.artifacts.filter(x=>x.name==='full-regression-'+run.id+'-'+run.run_attempt);
        if(matching.length!==1||zip.length!==1)deny('missing exact failed Full job/artifact');
        const [rec,idx]=await Promise.all([
          get('/repos/'+repo+'/contents/runs/'+run.head_sha+'/full-regression/'+run.id+'-'+run.run_attempt+'.json?ref=acceptance-results'),
          get('/repos/'+repo+'/contents/indexes/by-sha/'+run.head_sha+'/full-regression/'+run.id+'-'+run.run_attempt+'.json?ref=acceptance-results')]);
        const stored=checkedJson(rec),index=checkedJson(idx).value;
        for(const item of stored.value.candidate?.results??[]){
          if(!positive(item.failed)||!Array.isArray(item.failures))continue;
          for(const sig of item.failures.slice(0,8)){
            const f=fingerprint({test_id:item.id,...sig});
            if(f.status!=='FINGERPRINTED')continue;
            const key=f.fingerprint.slice(5);
            try{
              const [ob,head]=await Promise.all([
                get('/repos/'+repo+'/contents/e2e-failure-observations/'+run.id+'-'+run.run_attempt+'-'+key+'.json?ref=agent-store'),
                get('/repos/'+repo+'/contents/e2e-failures/'+key+'/head.json?ref=agent-store')]);
              const h=checkedJson(head).value;
              const [state,bug]=await Promise.all([
                get('/repos/'+repo+'/contents/'+h.path+'?ref=agent-store'),
                (async()=>null)()]);
              const stateData=checkedJson(state);
              const candidateIssue=positive(stateData.value.bug_issue)
                ?await get('/repos/'+repo+'/issues/'+stateData.value.bug_issue):bug;
              const receipt=attestLiveFullFailure({run:source,job:matching[0],artifact:zip[0],
                record:stored.value,index,recordBytes:stored.bytes,
                observation:checkedJson(ob).value,head:h,state:stateData.value,
                stateBytes:stateData.bytes,issue:candidateIssue});
              return {status:'Verified',receipt};
            }catch{/* Individual missing Store/Issue chain cannot become Pass. */}
          }
        }
      }catch{/* A red workflow by itself cannot become publication proof. */}
    }
    if(list.workflow_runs.length<pageSize)break;
  }
  return {status:'Pending',reason:missing,inspected_failed_sources:examined};
}
export function enforceLiveFullFailure(context,result){
  if(context?.stage!=='post-merge')return result;
  const evidence=context?.ci_evidence?.verified_live_main_full_failure_publication;
  const criteria=(result.criteria??[]).map(item=>{
    const text=context.criteria?.find(c=>c.criterion===item.criterion)?.text;
    if(!requiresLiveFullFailureProof(text)||item.result!=='Pass')return item;
    if(evidence?.status==='Verified'&&evidence.receipt?.kind===
       'verified_live_main_full_failure_publication'&&
       SHA.test(evidence.receipt.source_sha??'')&&positive(evidence.receipt.source_run_id)&&
       positive(evidence.receipt.source_attempt)&&
       ['BUG_LINKED','ANALYSIS_REUSED'].includes(evidence.receipt.outcome))
      return item;
    return {...item,result:'Pending',summary:missing,
      evidence:[{type:'trusted-readback',value:evidence?.reason??missing}]};
  });
  return {...result,criteria};
}
async function selfTest(){
  const sha='a'.repeat(40),digest='b'.repeat(64),key='e2e1:'+digest;
  const run={id:501,run_attempt:2,workflow_id:9,path:FULL,event:'schedule',
    head_branch:'main',head_sha:sha,status:'completed',conclusion:'failure',
    repository:{full_name:REPO},head_repository:{full_name:REPO}};
  const job={id:4,name:'full',run_id:501,run_attempt:2,head_sha:sha,
    status:'completed',conclusion:'failure',
    started_at:'2026-01-01T00:00:00Z',completed_at:'2026-01-01T00:02:00Z'};
  const sig={kind:'assertion_failed',assertion_code:'playwright_unexpected',
    stable_frame:'terminal-attach.spec.ts:42:9',affected_invariant:'terminal-attach',
    environment_specific:false};
  const f=fingerprint({test_id:'terminal-attach',...sig});
  const artifact={id:7,name:'full-regression-501-2',expired:false,
    size_in_bytes:100,digest:'sha256:'+digest,
    created_at:'2026-01-01T00:01:00Z',workflow_run:{id:501,head_sha:sha}};
  const record={schema_version:1,kind:'e2e_full_failure_observation',
    trust:'authenticated_github_run_and_artifact_digest',evaluation:'NOT_EVALUATED',
    agent_dispatch:'NOT_AUTHORIZED',
    source:{repository:REPO,workflow_path:FULL,workflow_id:9,event:'schedule',
      branch:'main',conclusion:'failure',run_id:501,run_attempt:2,
      source_sha:sha,completed_at:job.completed_at},
    artifact:{id:7,name:artifact.name,digest:artifact.digest},
    candidate:{status:'FAILED_TESTS_OBSERVED',results:[{
      id:'terminal-attach',failed:1,failures:[sig]}]},
    evidence:{archive_sha256:digest}};
  const recordBytes=Buffer.from(JSON.stringify(record,null,2)+'\n');
  const index={schema_version:1,kind:'e2e_full_failure_observation_index',
    source_sha:sha,run_id:501,run_attempt:2,
    record_path:'runs/'+sha+'/full-regression/501-2.json',
    record_sha256:hash(recordBytes)};
  const observation={schema_version:1,kind:'e2e_failure_admission_observation',
    fingerprint:f.fingerprint,classification:'candidate_test_failure',
    source:{repository:REPO,workflow_path:FULL,event:'schedule',conclusion:'failure',
      run_id:501,run_attempt:2,target_sha:sha,
      acceptance_record_path:index.record_path},
    artifact:{id:7,digest:artifact.digest},
    failure_signatures:[{test_id:'terminal-attach',kind:'assertion_failed',
      actionable:true,signature:sig}]};
  const state={schema_version:1,kind:'e2e_failure_admission_state',
    fingerprint:f.fingerprint,version:2,epoch:1,analysis_id:f.fingerprint.slice(5)+':1',
    status:'issue_linked',bug_issue:220,dispatch_intent:{status:'acknowledged'}};
  const stateBytes=Buffer.from(JSON.stringify(state,null,2)+'\n');
  const head={version:2,path:'e2e-failures/'+f.fingerprint.slice(5)+'/states/00000002.json',
    sha256:hash(stateBytes)};
  const issue={number:220,state:'open',body:fingerprintMarker(f.fingerprint)+
    '\n<!-- nession-e2e-failure-analysis: '+state.analysis_id+' -->',
    labels:[{name:fingerprintLabel(f.fingerprint)}]};
  const fixture={run,job,artifact,record,index,recordBytes,observation,head,state,stateBytes,issue};
  assert.equal(attestLiveFullFailure(fixture).outcome,'BUG_LINKED');
  for(const invalid of [
    {run:{...run,conclusion:'success'}},
    {run:{...run,path:'.github/workflows/acceptance-e2e-failure-bug.yml'}},
    {run:{...run,event:'pull_request'}},
    {run:{...run,run_attempt:1}},
    {job:{...job,conclusion:'skipped'}},
    {job:{...job,run_attempt:1}},
    {artifact:{...artifact,name:'full-regression-501-1'}},
    {artifact:{...artifact,digest:'sha256:'+'c'.repeat(64)}},
    {index:{...index,record_sha256:'c'.repeat(64)}},
    {observation:{...observation,source:{...observation.source,target_sha:'c'.repeat(40)}}},
    {observation:{...observation,fingerprint:'e2e1:'+'c'.repeat(64)}},
    {state:{...state,bug_issue:221}},
    {head:{...head,sha256:'c'.repeat(64)}},
    {issue:null},{issue:{...issue,labels:[]}},{issue:{...issue,body:''}},
  ])assert.throws(()=>attestLiveFullFailure({...fixture,...invalid}),/unverified live Main Full/);
  const reused={...state,status:'analyzed',bug_issue:null,
    dispatch_intent:{status:'committed'},latest_observation:{run_id:300},
    dispatch_run:{run_id:301}};
  const reusedBytes=Buffer.from(JSON.stringify(reused,null,2)+'\n');
  assert.equal(attestLiveFullFailure({...fixture,state:reused,stateBytes:reusedBytes,
    head:{...head,sha256:hash(reusedBytes)},issue:null}).outcome,'ANALYSIS_REUSED');
  const env=value=>({encoding:'base64',size:Buffer.byteLength(JSON.stringify(value,null,2)+'\n'),
    content:Buffer.from(JSON.stringify(value,null,2)+'\n').toString('base64')});
  const get=async path=>{
    if(path.includes('/workflows/e2e-full-regression.yml/runs?'))
      return {workflow_runs:[run]};
    if(path.endsWith('/actions/runs/501'))return run;
    if(path.includes('/attempts/2/jobs?'))return {jobs:[job]};
    if(path.includes('/actions/runs/501/artifacts?'))return {artifacts:[artifact]};
    if(path.includes('/contents/runs/'))return env(record);
    if(path.includes('/contents/indexes/by-sha/'))return env(index);
    if(path.includes('/contents/e2e-failure-observations/'))return env(observation);
    if(path.includes('/contents/e2e-failures/')&&path.includes('/head.json'))return env(head);
    if(path.includes('/contents/e2e-failures/'))return env(state);
    if(path.includes('/issues/220'))return issue;
    throw Error('unexpected test API '+path);
  };
  assert.equal((await collectLiveFullFailure({anchorSha:sha,get,isAncestor:()=>true})).status,'Verified');
  assert.equal((await collectLiveFullFailure({anchorSha:sha,get,isAncestor:()=>false})).status,'Pending');
  const green=async path=>path.includes('/workflows/')?{workflow_runs:[
    {...run,conclusion:'success',event:'schedule'},
    {...run,id:503,path:'.github/workflows/acceptance-e2e-failure-bug.yml',conclusion:'success'}]}:get(path);
  assert.equal((await collectLiveFullFailure({anchorSha:sha,get:green,isAncestor:()=>true})).status,'Pending');
  const text='Full Regression failed exact-Main-SHA observations enter deduplicated Bug repair flow';
  assert.equal(requiresLiveFullFailureProof(text),true);
  const context={stage:'post-merge',criteria:[{criterion:'SC-03',text}],
    ci_evidence:{verified_live_main_full_failure_publication:{status:'Pending',reason:missing}}};
  const proposed={criteria:[{criterion:'SC-03',result:'Pass',summary:'green Bug publisher run',
    evidence:[{type:'workflow',value:'publisher success'}]}]};
  assert.equal(enforceLiveFullFailure(context,proposed).criteria[0].result,'Pending');
  assert.match(enforceLiveFullFailure(context,proposed).criteria[0].summary,/missing authenticated/);
  assert.equal(enforceLiveFullFailure({...context,ci_evidence:{
    verified_live_main_full_failure_publication:{status:'Verified',
      receipt:attestLiveFullFailure(fixture)}}},proposed).criteria[0].result,'Pass');
  assert.equal(shouldCollectLiveFullFailure('post-merge',{body:
    '### Success Criteria\n- [ ] SC-03 '+text+'\n\n## Acceptance Plan'}),true);
  console.log('live Main Full failure->Bug evidence: positive, reuse, green publisher/Full and identity-mismatch negatives passed');
}
if(process.argv[2]==='self-test')await selfTest();
