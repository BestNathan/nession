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

// Retrospective proof locator, NOT a claim that a neighboring successful
// workflow ran this Issue's Agent. All values are re-authenticated from GitHub.
export const SIDEBAR_AUDIT_REPAIR_PROOF=Object.freeze({
  acceptanceIssue:2855,criterion:'SC-03',
  sourceRunId:42218594977,sourceAttempt:1,targetIssueNumber:2851,
  event:'issues',historical:true,
  requiredLabels:['requirement','web','ui','verification:scoped'],
  requiredWriteLabels:['requirement','verification:scoped'],
  expectedE2EIds:['sidebar-session-first','ui-contract-web','fixture-visual','fixture-visual-app'],
});

export function verifiedIssueAuditCriterion(context, normalized) {
  if(Number(context?.issue?.number)!==SIDEBAR_AUDIT_REPAIR_PROOF.acceptanceIssue||
     context?.stage!=='post-merge') return normalized;
  const selected=normalized.criteria?.find(item=>item.criterion===SIDEBAR_AUDIT_REPAIR_PROOF.criterion);
  if(!selected||selected.result==='Fail'||selected.result==='N/A')return normalized;
  const proof=context?.ci_evidence?.authenticated_issue_audit_repair_readback;
  const valid=proof?.status==='authenticated-historical-repair-readback'&&
     proof.source_run_id===SIDEBAR_AUDIT_REPAIR_PROOF.sourceRunId&&
     proof.source_attempt===SIDEBAR_AUDIT_REPAIR_PROOF.sourceAttempt&&
     proof.target_issue===SIDEBAR_AUDIT_REPAIR_PROOF.targetIssueNumber&&
     proof.source_event===SIDEBAR_AUDIT_REPAIR_PROOF.event&&
     proof.provider==='qwen'&&proof.issue_contract_pass===true&&
     proof.owner_trigger_verified===true&&
     proof.source_main_ancestry_confirmed===true&&
     proof.verified_risk_tier==='verification:scoped'&&
     Number.isSafeInteger(proof.source_job_id)&&proof.source_job_id>0&&
     Array.isArray(proof.label_event_ids)&&proof.label_event_ids.length===2&&
     Array.isArray(proof.protected_e2e_selected_ids)&&
     JSON.stringify([...proof.protected_e2e_selected_ids].sort())===
     JSON.stringify([...SIDEBAR_AUDIT_REPAIR_PROOF.expectedE2EIds].sort());
  // A model's Pass is NEVER evidence. With no complete signed receipt,
  // preserve a truthful Pending rather than accept a speculative verdict.
  if(!valid){
    if(selected.result==='Pass')
      throw Error('SC-03 Issue Audit Pass lacks authenticated exact-target Agent execution/readback');
    return normalized;
  }
  // An exact historical source repair (this entire SC assertion) was already
  // proved deterministically, including source-main ancestry. A model Pending
  // because the unrelated generic source_ancestry list is empty cannot veto
  // this independent verified receipt. An observed Fail is never overwritten.
  // Never let model prose attribute this Pass to the wrong run or a skipped
  // sibling. The trusted exact-run receipt owns the evidence and summary.
  return {...normalized,criteria:normalized.criteria.map(item=>
    item.criterion!==SIDEBAR_AUDIT_REPAIR_PROOF.criterion ? item : {
      ...item,
      result:'Pass',
      evidence:[{type:'authenticated-issue-audit',value:
        'run '+proof.source_run_id+'/'+proof.source_attempt+
        ', agent job '+proof.source_job_id+
        ', target #'+proof.target_issue+', source '+proof.source_sha+
        ', owner-triggered main ancestor, tier '+proof.verified_risk_tier+
        ', verified canonical Issue/E2E and bot label writes'}],
      summary:'Historical Qwen Issue Audit produced a valid persistent repair and risk-tier classification for target #2851',
    })};
}

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
    // These are identity checks that already passed above, not additional
    // claims by the model or a generic source_ancestry discovery list.
    owner_trigger_verified:historical && run.actor?.login==='BestNathan',
    source_main_ancestry_confirmed:run.head_sha===targetSha||ancestorConfirmed,
    verified_risk_tier:labels.find(label=>label.startsWith('verification:'))??null,
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
  // #2860: a completed Issue Audit WORKFLOW whose agent job is skipped or
  // whose fixed target is not #2851 must never become proof for #2855 SC-03.
  const recipe=SIDEBAR_AUDIT_REPAIR_PROOF;
  const reqBody=[
    '## Requirements: sidebar repaired', 'A work-first Web sidebar',
    '### Success Criteria', '- [ ] SC-01 preserve Session navigation',
    '## Acceptance Plan',
    '\x60\x60\x60yaml','acceptance:','  SC-01:','    when: pr','    method: case','\x60\x60\x60',
    '## Acceptance Report','| Criterion | Result | Evidence |',
    '|---|---|---|','| SC-01 | Pending | Browser Case at PR head |',
    '## E2E Verification','### New','- sidebar-session-first',
    '### Regression','- ui-contract-web','- fixture-visual','- fixture-visual-app',
    '## E2E Report','| ID | Type | Result | Evidence |',
    '|---|---|---|---|',
    '| sidebar-session-first | New | Pending | - |',
    '| ui-contract-web | Regression | Pending | - |',
    '| fixture-visual | Regression | Pending | - |',
    '| fixture-visual-app | Regression | Pending | - |',
    '### Knowledge Impact','- Decision: Update',
    '- Related knowledge: docs/design/interaction/web.md',
    '- Reason: Shell structure changed',
    '- Owner and timing: Web owner during PR',
    '- Evidence: source-based audit run',
    '## Product alignment','- [x] work first','**Status:** In Discussion',
  ].join('\n');
  const auditedIssue={
    number:recipe.targetIssueNumber,title:'Requirement: Sidebar repaired',
    state:'open',created_at:'2026-11-06T10:31:22Z',
    labels:recipe.requiredLabels.map(name=>({name})),body:reqBody,
  };
  assert.deepEqual(auditIssue(auditedIssue).errors,[],
    'the authenticated sample must pass the full Issue Contract');
  const historicalRun={...sourceRun,id:recipe.sourceRunId,run_attempt:recipe.sourceAttempt,
    event:'issues',actor:{login:'BestNathan'}};
  const historicalJob={...agent,id:918,run_id:recipe.sourceRunId};
  const historicalLog=log.replace('ISSUE_NUMBER: 2811','ISSUE_NUMBER: 2851');
  const historicalEvents=recipe.requiredWriteLabels.map((name,i)=>({
    id:201+i,event:'labeled',label:{name},
    actor:{login:'github-actions[bot]'},created_at:'2026-11-06T06:44:20Z',
  }));
  const verified={
    repo,targetSha:target,sourceRun:historicalRun,jobs:[historicalJob],
    log:historicalLog,issue:auditedIssue,events:historicalEvents,
    targetIssueNumber:recipe.targetIssueNumber,ancestorConfirmed:true,
    sourceCodeUnchanged:false,proof:recipe,
  };
  const witnessed=attestIssueAuditReadback(verified);
  assert.equal(witnessed.source_event,'issues');
  assert.equal(witnessed.status,'authenticated-historical-repair-readback');
  assert.equal(witnessed.owner_trigger_verified,true);
  assert.equal(witnessed.source_main_ancestry_confirmed,true);
  assert.equal(witnessed.verified_risk_tier,'verification:scoped');
  assert.deepEqual(witnessed.protected_e2e_selected_ids.sort(),
    [...recipe.expectedE2EIds].sort());
  for(const [patch,reason] of [
    [{sourceRun:{...historicalRun,event:'workflow_dispatch'}},/identity/],
    [{sourceRun:{...historicalRun,actor:{login:'github-actions[bot]'}}},/identity/],
    [{ancestorConfirmed:false},/ancestry/],
    [{jobs:[{...historicalJob,conclusion:'skipped'}]},/agent job identity/],
    [{jobs:[{...historicalJob,name:'contract'}]},/trusted Issue Audit agent job/],
    [{jobs:[{...historicalJob,run_attempt:2}]},/agent job identity/],
    [{jobs:[{...historicalJob,steps:historicalJob.steps.map(s=>
      s.name==='Audit and repair issue'?{...s,conclusion:'skipped'}:s)}]},/trusted step/],
    [{log:historicalLog.replace('ISSUE_NUMBER: 2851','ISSUE_NUMBER: 2855')},/fixed target/],
    [{issue:{...auditedIssue,number:2855}},/target readback/],
    [{events:[]},/label write/],
    [{events:historicalEvents.map(e=>({...e,actor:{login:'BestNathan'}}))},/label write/],
    [{events:historicalEvents.map(e=>({...e,created_at:'2026-11-06T07:00:00Z'}))},/label write/],
    [{issue:{...auditedIssue,body:reqBody.replace('- sidebar-session-first','- substituted-test')}},/E2E selection|Issue Contract/],
  ])assert.throws(()=>attestIssueAuditReadback({...verified,...patch}),reason);
  const historicalRequest=async path=>{
    if(path.endsWith('/actions/runs/'+recipe.sourceRunId))return historicalRun;
    if(path.includes('/attempts/1/jobs?'))return {jobs:[historicalJob]};
    if(path.endsWith('/issues/'+recipe.targetIssueNumber))return auditedIssue;
    if(path.includes('/issues/'+recipe.targetIssueNumber+'/events'))return historicalEvents;
    throw Error('unexpected Issue Audit source '+path);
  };
  const fetched=await collectIssueAuditReadback({
    repo,targetSha:target,sourceRunId:recipe.sourceRunId,
    targetIssueNumber:recipe.targetIssueNumber,proof:recipe,
    request:historicalRequest,readLog:async()=>historicalLog,
    isAncestor:()=>true,
  });
  assert.equal(fetched.source_run_id,recipe.sourceRunId);
  console.log('Issue Audit authenticated readback: exact run, target, model, GitHub writes, E2E contract and negative fixtures passed');
}
