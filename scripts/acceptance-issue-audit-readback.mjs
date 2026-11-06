// Read-only, retrospective proof for a real Issue Audit run.
// Never trust model prose, an Issue comment, or a successful workflow status
// alone: bind an exact GitHub run/attempt, successful trusted job and runner
// environment, concrete GitHub label events and the current Issue contract.
import assert from 'node:assert/strict';
import {auditIssue, KIND_LABELS, AREA_LABELS} from './issue-contract.mjs';
import {parseIssueE2E} from './issue-e2e-contract.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const WORKFLOW='.github/workflows/agent-issue-audit.yml';
const REQUIRED_STEPS=[
  'Self-test audit tooling',
  'Verify selected provider configuration',
  'Audit and repair issue',
  'Upload canonical Agent telemetry',
];
const ENV_KEYS=['ISSUE_NUMBER','ISSUE_AUDIT_PROVIDER','ISSUE_AUDIT_ALLOW_AGENT','ISSUE_AUDIT_CLAUDE_MODEL'];
const MAX_LOG_BYTES=2*1024*1024;

export function parseAuditEnvironmentLog(log) {
  if(typeof log!=='string'||Buffer.byteLength(log)>MAX_LOG_BYTES)
    throw Error('invalid or oversized Issue Audit job log');
  const observed=new Map(ENV_KEYS.map(key=>[key, new Set()]));
  // These are GitHub runner-generated environment lines, not model output.
  const re=/^\d{4}-\d{2}-\d{2}T[^\n]+?Z {3}(ISSUE_NUMBER|ISSUE_AUDIT_PROVIDER|ISSUE_AUDIT_ALLOW_AGENT|ISSUE_AUDIT_CLAUDE_MODEL): ([^\r\n]+)$/gm;
  for(const match of log.matchAll(re))observed.get(match[1]).add(match[2].trim());
  const env={};
  for(const key of ENV_KEYS){
    const values=[...observed.get(key)];
    if(values.length!==1)throw Error('missing or inconsistent audited runner environment: '+key);
    env[key]=values[0];
  }
  return env;
}

export function attestIssueAuditReadback({
  repo, targetSha, sourceRun, jobs, log, issue, events,
  targetIssueNumber, ancestorConfirmed, sourceCodeUnchanged,
  proof = null,
}) {
  if(repo!==REPO||!SHA.test(String(targetSha))||
     !Number.isSafeInteger(targetIssueNumber)||targetIssueNumber<1)
    throw Error('invalid Issue Audit readback scope');
  const run=sourceRun;
  const expectedEvent=proof?.event??'issue_comment';
  const historical=proof?.historical===true;
  const requiredLabels=proof?.requiredLabels??['bug','cli','terminal'];
  const requiredWriteLabels=proof?.requiredWriteLabels??['bug','cli','terminal'];
  if(!['issues','issue_comment'].includes(expectedEvent) ||
     !Array.isArray(requiredLabels)||!requiredLabels.length||
     !Array.isArray(requiredWriteLabels)||!requiredWriteLabels.length||
     requiredLabels.some(x=>typeof x!=='string'||!x)||
     requiredWriteLabels.some(x=>typeof x!=='string'||!x))
    throw Error('invalid Issue Audit proof requirements');
  if(!run||!Number.isSafeInteger(run.id)||run.id<1||
     !Number.isSafeInteger(run.run_attempt)||run.run_attempt<1||
     !SHA.test(String(run.head_sha))||
     run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO||
     run.name!=='Agent / Issue Audit'||run.path!==WORKFLOW||
     run.event!==expectedEvent||run.head_branch!=='main'||
     run.status!=='completed'||run.conclusion!=='success'||
     (historical && run.actor?.login!=='BestNathan')||
     (run.head_sha!==targetSha&&(!ancestorConfirmed||(!historical&&!sourceCodeUnchanged))))
    throw Error('unverified Issue Audit source run identity or ancestry');
  if(!Array.isArray(jobs)||jobs.length>100)
    throw Error('invalid Issue Audit exact-attempt jobs');
  const agents=jobs.filter(j=>j?.name==='agent');
  if(agents.length!==1)throw Error('missing or ambiguous trusted Issue Audit agent job');
  const job=agents[0];
  if(job.run_id!==run.id||job.run_attempt!==run.run_attempt||
     job.head_sha!==run.head_sha||job.status!=='completed'||
     job.conclusion!=='success'||!Array.isArray(job.steps)||
     !Number.isSafeInteger(job.id)||job.id<=0)
    throw Error('unverified Issue Audit agent job identity');
  for(const name of REQUIRED_STEPS){
    const steps=job.steps.filter(s=>s?.name===name);
    if(steps.length!==1||steps[0].status!=='completed'||steps[0].conclusion!=='success')
      throw Error('unproven Issue Audit trusted step: '+name);
  }
  const env=parseAuditEnvironmentLog(log);
  if(env.ISSUE_NUMBER!==String(targetIssueNumber)||
     env.ISSUE_AUDIT_PROVIDER!=='qwen'||
     env.ISSUE_AUDIT_ALLOW_AGENT!=='true'||
     !/^qwen[\w.\-]*$/i.test(env.ISSUE_AUDIT_CLAUDE_MODEL))
    throw Error('wrong Issue Audit fixed target/provider/authorization');
  if(!issue||issue.number!==targetIssueNumber||issue.state!=='open'||
     !Array.isArray(issue.labels)||typeof issue.body!=='string')
    throw Error('Issue Audit target readback unavailable');
  const after=auditIssue(issue);
  if(!after.ok)throw Error('Issue Audit target failed canonical Issue Contract readback');
  const e2e=parseIssueE2E(issue.body,{requireDeclaration:true});
  if(!e2e||e2e.errors.length)throw Error('Issue Audit target has invalid protected E2E evidence');
  const labels=issue.labels.map(l=>typeof l==='string'?l:l?.name).filter(Boolean);
  const kinds=labels.filter(l=>KIND_LABELS.has(l));
  const areas=labels.filter(l=>AREA_LABELS.has(l));
  if(kinds.length!==1||areas.length===0||
     requiredLabels.some(label=>!labels.includes(label)))
    throw Error('Issue Audit target missing repaired canonical labels');
  if (proof?.expectedE2EIds != null) {
    if(!Array.isArray(proof.expectedE2EIds)||!proof.expectedE2EIds.length||
       JSON.stringify([...e2e.selectedIds].sort()) !==
       JSON.stringify([...proof.expectedE2EIds].sort()))
      throw Error('Issue Audit target E2E selection differs from required repair');
  }
  // No label event may be inferred from the Issue's current labels alone.
  // Require explicit GitHub-authenticated writer events during this exact job.
  if(!Array.isArray(events)||events.length>100||!job.started_at||!job.completed_at)
    throw Error('missing bounded GitHub label event history');
  const start=Date.parse(job.started_at),end=Date.parse(job.completed_at);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)
    throw Error('invalid Issue Audit execution time bounds');
  const changes=events.filter(e=>e?.event==='labeled'&&
    e.actor?.login==='github-actions[bot]'&&
    Date.parse(e.created_at)>=start&&Date.parse(e.created_at)<=end);
  for(const label of requiredWriteLabels){
    if(changes.filter(e=>e.label?.name===label).length!==1)
      throw Error('missing/ambiguous authenticated Issue Audit label write: '+label);
  }
  // Source-owned createIssueUpdateTool enforces E2E digest+rows before every
  // structural update, and passed exact-run self-tests. This receipt observes
  // the current canonical declaration; it does not invent a raw model draft.
  return {
    source_run_id:run.id, source_attempt:run.run_attempt,
    source_sha:run.head_sha, target_sha:targetSha, target_issue:targetIssueNumber,
    source_job_id:job.id, provider:'qwen', model:env.ISSUE_AUDIT_CLAUDE_MODEL,
    status:historical?'authenticated-historical-repair-readback':'authenticated-repair-readback',
    source_event:run.event,
    kinds,areas, labels,
    protected_e2e_digest:e2e.digest,
    protected_e2e_selected_ids:e2e.selectedIds,
    protected_e2e_rows:e2e.rows.size,
    issue_contract_pass:true,
    trusted_steps:REQUIRED_STEPS,
    label_event_ids:changes.filter(e=>requiredWriteLabels.includes(e.label?.name)).map(e=>e.id),
    provenance:'GitHub exact Run/Attempt/Job, runner env, label events, canonical target Issue Contract and E2E parser',
    source_url:run.html_url,
  };
}

export async function collectIssueAuditReadback({
  repo,targetSha,sourceRunId,targetIssueNumber,request,readLog,
  isAncestor=()=>false,sourceUnchanged=()=>false,proof=null,
}){
  if(repo!==REPO||!SHA.test(String(targetSha))||
     !Number.isSafeInteger(sourceRunId)||sourceRunId<1||
     !Number.isSafeInteger(targetIssueNumber)||targetIssueNumber<1)
    throw Error('invalid Issue Audit readback locator');
  const root='/repos/'+repo;
  const sourceRun=await request(root+'/actions/runs/'+sourceRunId);
  if(!sourceRun||sourceRun.id!==sourceRunId)
    throw Error('mismatched Issue Audit run locator');
  const [jobs,issue,events]=await Promise.all([
    request(root+'/actions/runs/'+sourceRunId+'/attempts/'+sourceRun.run_attempt+'/jobs?per_page=100'),
    request(root+'/issues/'+targetIssueNumber),
    request(root+'/issues/'+targetIssueNumber+'/events?per_page=100'),
  ]);
  const exactJobs=jobs?.jobs;
  const agent=Array.isArray(exactJobs)?exactJobs.filter(x=>x.name==='agent'):[];
  const log=agent.length===1?await readLog(root+'/actions/jobs/'+agent[0].id+'/logs',MAX_LOG_BYTES):null;
  return attestIssueAuditReadback({repo,targetSha,sourceRun,jobs:exactJobs,log,
    issue,events,targetIssueNumber,
    ancestorConfirmed:sourceRun.head_sha===targetSha||isAncestor(sourceRun.head_sha,targetSha),
    sourceCodeUnchanged:sourceRun.head_sha===targetSha||
      (proof?.historical===true ? false : sourceUnchanged(sourceRun.head_sha,targetSha)),
    proof,
  });
}

export async function selfTestIssueAuditReadback(){
  const sha='a'.repeat(40),target='b'.repeat(40),repo=REPO;
  const sourceRun={id:901,run_attempt:1,head_sha:sha,name:'Agent / Issue Audit',
    path:WORKFLOW,event:'issue_comment',head_branch:'main',
    repository:{full_name:repo},head_repository:{full_name:repo},
    status:'completed',conclusion:'success',html_url:'https://github.com/BestNathan/nession/actions/runs/901'};
  const agent={id:902,name:'agent',run_id:901,run_attempt:1,head_sha:sha,
    status:'completed',conclusion:'success',
    started_at:'2026-11-06T06:43:00Z',completed_at:'2026-11-06T06:44:30Z',
    steps:REQUIRED_STEPS.map(name=>({name,status:'completed',conclusion:'success'}))};
  const log=ENV_KEYS.map(key=>'2026-11-06T06:43:13.412Z   '+key+': '+({
    ISSUE_NUMBER:'2811',ISSUE_AUDIT_PROVIDER:'qwen',
    ISSUE_AUDIT_ALLOW_AGENT:'true',ISSUE_AUDIT_CLAUDE_MODEL:'qwen3.7-plus',
  })[key]).join('\n');
  const issue={number:2811,state:'open',title:'Bug: CLI attach',
    labels:['bug','cli','terminal','verification:integration'].map(name=>({name})),
    body:[
      '## Description','Failure','## Reproduction','Steps','## Investigation Status','Known',
      '## Impact','Operators affected','## Fix Direction','Fix attach','## Location','- client.rs',
      '## E2E Verification','### New','- none: Native CLI','### Regression',
      '- none: No browser','## E2E Report','| ID | Type | Result | Evidence |',
      '|---|---|---|---|',
    ].join('\n')};
  const events=['bug','cli','terminal'].map((name,i)=>({
    id:100+i,event:'labeled',label:{name},actor:{login:'github-actions[bot]'},
    created_at:'2026-11-06T06:44:20Z',
  }));
  const args={repo,targetSha:target,sourceRun,jobs:[agent],log,issue,events,
    targetIssueNumber:2811,ancestorConfirmed:true,sourceCodeUnchanged:true};
  assert.equal(attestIssueAuditReadback(args).target_issue,2811);
  assert.deepEqual(attestIssueAuditReadback(args).areas,['cli','terminal']);
  for(const [patch,pattern] of [
    [{ancestorConfirmed:false},/ancestry/],
    [{sourceCodeUnchanged:false},/ancestry/],
    [{sourceRun:{...sourceRun,event:'workflow_dispatch'}},/identity/],
    [{jobs:[{...agent,run_attempt:2}]},/job identity/],
    [{jobs:[{...agent,steps:agent.steps.map(s=>s.name==='Audit and repair issue'?{...s,conclusion:'failure'}:s)}]},/trusted step/],
    [{log:log.replace('ISSUE_NUMBER: 2811','ISSUE_NUMBER: 5')},/fixed target/],
    [{log:log+'\n2026-11-06T06:43:13.413Z   ISSUE_NUMBER: 5'},/inconsistent/],
    [{events:events.map(e=>e.label.name==='bug'?{...e,actor:{login:'BestNathan'}}:e)},/label write/],
    [{events:events.map(e=>e.label.name==='bug'?{...e,created_at:'2026-11-06T06:50:00Z'}:e)},/label write/],
    [{issue:{...issue,body:issue.body.replace('- none: Native CLI','- broken: invalid')}},/Issue Contract readback|invalid protected E2E/],
    [{issue:{...issue,labels:[]}},/canonical Issue Contract/],
  ])assert.throws(()=>attestIssueAuditReadback({...args,...patch}),pattern);
  const request=async (path)=>{
    if(path.endsWith('/actions/runs/901'))return sourceRun;
    if(path.includes('/attempts/1/jobs'))return {jobs:[agent]};
    if(path.endsWith('/issues/2811'))return issue;
    if(path.includes('/issues/2811/events'))return events;
    throw Error('unexpected '+path);
  };
  const proof=await collectIssueAuditReadback({repo,targetSha:target,
    sourceRunId:901,targetIssueNumber:2811,request,readLog:async()=>log,
    isAncestor:()=>true,sourceUnchanged:()=>true});
  assert.equal(proof.source_run_id,901);
  await assert.rejects(collectIssueAuditReadback({repo,targetSha:target,sourceRunId:901,
    targetIssueNumber:2811,request,readLog:async()=>log,isAncestor:()=>false}),/ancestry/);
  console.log('Issue Audit authenticated readback: exact run, target, model, GitHub writes, E2E contract and negative fixtures passed');
}
