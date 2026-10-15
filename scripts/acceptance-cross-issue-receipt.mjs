#!/usr/bin/env node
// Read-only, bounded provenance for an already-completed OTHER Issue's Agent
// Acceptance. A mutable Issue witness is a locator, never an authorization or
// a replacement for the source artifact + GitHub attempt jobs.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = 'BestNathan/nession';
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:([0-9a-f]{64})$/;
const MAX_BYTES = 128 * 1024;

export function pinnedCrossIssueAcceptance(body) {
  const section = String(body ?? '').match(/^## Historical Acceptance Evidence\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? '';
  const lines = section.split('\n').filter(s => s.startsWith('Historical Acceptance witness:'));
  if (lines.length > 2) throw Error('too many historical Acceptance witnesses');
  if (new Set(lines).size !== lines.length) throw Error('duplicate historical Acceptance witness');
  return lines.map(line => {
    const m = line.match(/^Historical Acceptance witness: Issue #([1-9]\d*) (SC-\d{2,}); PR #([1-9]\d*) SHA ([0-9a-f]{40}); Agent Run ([1-9]\d*) attempt ([1-9]\d*); E2E Run ([1-9]\d*) attempt ([1-9]\d*)$/);
    if (!m) throw Error('malformed historical Acceptance witness');
    const [issue,pr,run,attempt,e2eRun,e2eAttempt] = [m[1],m[3],m[5],m[6],m[7],m[8]].map(Number);
    if (![issue,pr,run,attempt,e2eRun,e2eAttempt].every(Number.isSafeInteger))
      throw Error('historical Acceptance witness integer overflow');
    return {issue,sc:m[2],pr,sha:m[4],run,attempt,e2eRun,e2eAttempt};
  });
}

function uniqueSuccessfulStep(job, name) {
  if (!Array.isArray(job?.steps)) return false;
  const entries = job.steps.filter(s => s?.name === name);
  return entries.length === 1 && entries[0].status === 'completed' &&
    entries[0].conclusion === 'success';
}

export function attestCrossIssueAcceptance(pin, sourceRun, jobs, artifact, result,
    sourcePr, comparison, e2eSteps, {repo=REPO,targetSha,subjectIssue}={}) {
  if (repo !== REPO || !SHA.test(String(targetSha)) ||
      !Number.isSafeInteger(subjectIssue) || subjectIssue===pin?.issue ||
      !pin || !SHA.test(pin.sha) || !DIGEST.test(artifact?.digest ?? '') ||
      artifact?.expired!==false ||
      artifact?.name!==('acceptance-result-'+pin.issue+'-pre-merge-'+pin.run+'-'+pin.attempt) ||
      artifact.workflow_run?.id!==pin.run ||
      artifact.workflow_run?.head_sha!==sourceRun?.head_sha ||
      artifact.workflow_run?.repository_id!==sourceRun?.repository?.id ||
      !Number.isSafeInteger(artifact.id) || artifact.id<=0 ||
      !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes>MAX_BYTES ||
      sourceRun?.id!==pin.run || sourceRun.run_attempt!==pin.attempt ||
      sourceRun.name!=='Agent / SC Acceptance' ||
      sourceRun.path!=='.github/workflows/agent-sc-acceptance.yml' ||
      sourceRun.event!=='workflow_dispatch' ||
      sourceRun.head_branch!=='main' || !SHA.test(sourceRun.head_sha) ||
      sourceRun.repository?.full_name!==repo ||
      sourceRun.head_repository?.full_name!==repo ||
      sourceRun.status!=='completed' || sourceRun.conclusion!=='success')
    throw Error('historical Acceptance workflow/artifact identity unverified');
  const candidate = name => {
    if (!Array.isArray(jobs?.jobs) || jobs.jobs.length>100) throw Error('untrusted Acceptance job listing');
    const found = jobs.jobs.filter(j => j?.name === name);
    if (found.length!==1) throw Error('missing or ambiguous Acceptance job');
    const j=found[0];
    if (!Number.isSafeInteger(j.id) || j.id<=0 || j.run_id!==pin.run ||
        j.run_attempt!==pin.attempt || j.head_sha!==sourceRun.head_sha ||
        j.status!=='completed' || j.conclusion!=='success')
      throw Error('unverified historical Acceptance job binding');
    return j;
  };
  const executor=candidate('Execute acceptance');
  const updater=candidate('Deterministic Issue updater');
  if (!uniqueSuccessfulStep(executor,'Prepare stage-specific immutable acceptance context') ||
      // A manually supplied deterministic_result_json is not Agent attestation.
      !uniqueSuccessfulStep(executor,'Run read-only Acceptance Agent') ||
      !uniqueSuccessfulStep(executor,'Upload structured Acceptance Result') ||
      !uniqueSuccessfulStep(updater,'Apply Acceptance Report and checkbox projection'))
    throw Error('historical Acceptance source/updater step missing or unsuccessful');
  if (result?.schema_version!==1 || result.issue!==pin.issue ||
      result.stage!=='pre-merge' || result.run_id!==pin.run ||
      result.target_ref!==pin.sha ||
      !/^[0-9a-f]{64}$/.test(result.contract_sha256 ?? '') ||
      !['agent-cursor','agent-deepseek'].includes(result.source) ||
      !Array.isArray(result.selected_criteria) ||
      !result.selected_criteria.includes(pin.sc) ||
      !Array.isArray(result.criteria) ||
      result.criteria.filter(x=>x?.criterion===pin.sc).length!==1 ||
      !result.criteria.some(x=>x?.criterion===pin.sc && x.result==='Pass'))
    throw Error('historical Acceptance artifact lacks selected SC Pass');
  if (sourcePr?.number!==pin.pr || !sourcePr.merged_at ||
      sourcePr?.state!=='closed' || sourcePr?.head?.sha!==pin.sha ||
      sourcePr?.head?.repo?.full_name!==repo ||
      sourcePr?.base?.repo?.full_name!==repo ||
      sourcePr?.base?.ref!=='main' || !SHA.test(sourcePr.merge_commit_sha) ||
      !['ahead','identical'].includes(comparison?.status) ||
      comparison?.merge_base_commit?.sha!==sourcePr.merge_commit_sha ||
      (comparison.behind_by ?? 0)!==0)
    throw Error('historical Acceptance source PR merge ancestry not verified');
  if (e2eSteps?.run_id!==pin.e2eRun || e2eSteps.run_attempt!==pin.e2eAttempt ||
      e2eSteps.head_sha!==pin.sha || e2eSteps.workflow_conclusion!=='failure' ||
      !Array.isArray(e2eSteps.steps))
    throw Error('historical E2E source attempt is unverified');
  const step = name => e2eSteps.steps.filter(s=>s.name===name);
  if (step('Resolve linked Issue E2E obligations').length!==1 ||
      step('Resolve linked Issue E2E obligations')[0].conclusion!=='success' ||
      step('Run E2E tests').length!==1 ||
      step('Run E2E tests')[0].conclusion!=='success' ||
      step('Normalize selected per-file results even on failure').length!==1 ||
      step('Normalize selected per-file results even on failure')[0].conclusion!=='failure')
    throw Error('source E2E planner/reporter distinction is unverified');
  return {
    kind:'source_issue_sc_acceptance_receipt',subject_issue:subjectIssue,
    source_issue:pin.issue,source_sc:pin.sc,source_pr:pin.pr,
    source_sha:pin.sha,source_merge_sha:sourcePr.merge_commit_sha,
    target_sha:targetSha,acceptance_run:pin.run,acceptance_attempt:pin.attempt,
    acceptance_run_head_sha:sourceRun.head_sha,executor_job:executor.id,updater_job:updater.id,
    acceptance_artifact_id:artifact.id,acceptance_artifact_digest:artifact.digest,
    source_sc_result:'Pass',source_e2e_run:pin.e2eRun,
    source_e2e_attempt:pin.e2eAttempt,source_e2e_workflow_conclusion:'failure',
    source_e2e_steps:e2eSteps.steps,
    provenance:'GitHub exact-attempt Acceptance jobs + downloaded SHA256-bound immutable result artifact + merged PR ancestry + separately re-attested exact-attempt E2E steps',
    limitation:'Historical source Issue result; not a new E2E Pass or an authorization to update this Issue',
  };
}

// The zipped artifact is the source of the SC verdict, not editable Issue prose,
// an agent summary, or the existence of an artifact record alone.
export async function downloadedResult(repo, artifact, token) {
  if (repo!==REPO || !Number.isSafeInteger(artifact?.id) ||
      !DIGEST.test(artifact?.digest ?? '')) throw Error('invalid artifact download locator');
  const res=await fetch('https://api.github.com/repos/'+repo+'/actions/artifacts/'+artifact.id+'/zip',{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28','User-Agent':'nession-acceptance-ci-evidence'},
  });
  if (!res.ok || Number(res.headers.get('content-length')??0)>MAX_BYTES)
    throw Error('historical Acceptance artifact unavailable or too large');
  const buffer=Buffer.from(await res.arrayBuffer());
  if (buffer.length>MAX_BYTES ||
      crypto.createHash('sha256').update(buffer).digest('hex')!==artifact.digest.slice(7))
    throw Error('historical Acceptance artifact ZIP digest mismatch');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nession-acceptance-proof-'));
  try {
    const zip=path.join(directory,'artifact.zip');
    fs.writeFileSync(zip,buffer,{mode:0o600});
    const raw=execFileSync('unzip',['-p',zip,'acceptance-result.json'],
      {encoding:'utf8',maxBuffer:MAX_BYTES});
    if (raw.length>MAX_BYTES) throw Error('historical Acceptance JSON too large');
    return JSON.parse(raw);
  } finally {
    fs.rmSync(directory,{recursive:true,force:true});
  }
}

export async function collectCrossIssueAcceptance(repo,body,targetSha,subjectIssue,
    request,attestExactHeadE2eSteps,token=process.env.GITHUB_TOKEN??process.env.GH_TOKEN) {
  const pins=pinnedCrossIssueAcceptance(body);
  if (!pins.length) return [];
  if (repo!==REPO || !token || !SHA.test(targetSha))
    throw Error('historical Acceptance source environment unavailable');
  const results=[];
  for (const pin of pins) {
    const [run,jobs,artifacts,sourcePr,e2eRun,e2eJobs] = await Promise.all([
      request('/repos/'+repo+'/actions/runs/'+pin.run+'/attempts/'+pin.attempt),
      request('/repos/'+repo+'/actions/runs/'+pin.run+'/attempts/'+pin.attempt+'/jobs?per_page=100'),
      request('/repos/'+repo+'/actions/runs/'+pin.run+'/artifacts?per_page=100'),
      request('/repos/'+repo+'/pulls/'+pin.pr),
      request('/repos/'+repo+'/actions/runs/'+pin.e2eRun+'/attempts/'+pin.e2eAttempt),
      request('/repos/'+repo+'/actions/runs/'+pin.e2eRun+'/attempts/'+pin.e2eAttempt+'/jobs?per_page=100'),
    ]);
    if (!Array.isArray(artifacts?.artifacts) || artifacts.artifacts.length>100)
      throw Error('untrusted historical Acceptance artifact listing');
    const expected='acceptance-result-'+pin.issue+'-pre-merge-'+pin.run+'-'+pin.attempt;
    const matches=artifacts.artifacts.filter(a=>a?.name===expected);
    if (matches.length!==1) throw Error('missing or ambiguous historical Acceptance artifact');
    const [comparison,raw] = await Promise.all([
      request('/repos/'+repo+'/compare/'+sourcePr.merge_commit_sha+'...'+targetSha),
      downloadedResult(repo,matches[0],token),
    ]);
    const steps=attestExactHeadE2eSteps(e2eRun,e2eJobs,pin.sha,repo);
    results.push(attestCrossIssueAcceptance(pin,run,jobs,matches[0],raw,
      sourcePr,comparison,steps,{repo,targetSha,subjectIssue}));
  }
  return results;
}

function selfTest(){
  const sha='a'.repeat(40),head='b'.repeat(40),merge='c'.repeat(40),target='d'.repeat(40);
  const pin={issue:1719,sc:'SC-02',pr:1720,sha,run:38718918820,attempt:7,
    e2eRun:38388288917,e2eAttempt:4};
  const body='## Historical Acceptance Evidence\nHistorical Acceptance witness: Issue #1719 SC-02; PR #1720 SHA '+sha+
    '; Agent Run 38718918820 attempt 7; E2E Run 38388288917 attempt 4\n\n## Other';
  assert.deepEqual(pinnedCrossIssueAcceptance(body),[pin]);
  assert.throws(()=>pinnedCrossIssueAcceptance(body.replace('\n\n## Other', '\n'+body.split('\n')[1]+'\n\n## Other')),/duplicate/);
  assert.deepEqual(pinnedCrossIssueAcceptance('## Success Criteria\n- [ ] SC-01 none'),[]);
  assert.throws(()=>pinnedCrossIssueAcceptance(body.replace('attempt 7','attempt forged')),/malformed/);
  const run={id:pin.run,run_attempt:7,name:'Agent / SC Acceptance',
    path:'.github/workflows/agent-sc-acceptance.yml',event:'workflow_dispatch',
    head_branch:'main',head_sha:head,status:'completed',conclusion:'success',
    repository:{id:123,full_name:REPO},head_repository:{full_name:REPO}};
  const j=(id,name,step)=>({id,name,run_id:pin.run,run_attempt:7,head_sha:head,
    status:'completed',conclusion:'success',steps:[{name:step,status:'completed',conclusion:'success'}]});
  const exec=j(8,'Execute acceptance','Prepare stage-specific immutable acceptance context');
  exec.steps.push({name:'Run read-only Acceptance Agent',status:'completed',conclusion:'success'});
  exec.steps.push({name:'Upload structured Acceptance Result',status:'completed',conclusion:'success'});
  const updater=j(9,'Deterministic Issue updater','Apply Acceptance Report and checkbox projection');
  const jobs={jobs:[exec,updater]};
  const artifact={id:11968162864,name:'acceptance-result-1719-pre-merge-38718918820-7',
    expired:false,digest:'sha256:'+'e'.repeat(64),size_in_bytes:1026,
    workflow_run:{id:pin.run,head_sha:head,repository_id:123}};
  const result={schema_version:1,issue:1719,stage:'pre-merge',
    run_id:pin.run,target_ref:sha,contract_sha256:'f'.repeat(64),
    source:'agent-cursor',selected_criteria:['SC-01','SC-02'],
    criteria:[{criterion:'SC-02',result:'Pass'}]};
  const pr={number:1720,state:'closed',merged_at:'2026-10-15T08:00:00Z',
    head:{sha,repo:{full_name:REPO}},base:{ref:'main',repo:{full_name:REPO}},
    merge_commit_sha:merge};
  const compare={status:'ahead',merge_base_commit:{sha:merge},behind_by:0};
  const e2e={run_id:pin.e2eRun,run_attempt:4,head_sha:sha,workflow_conclusion:'failure',
    steps:[{name:'Resolve linked Issue E2E obligations',conclusion:'success'},
      {name:'Run E2E tests',conclusion:'success'},
      {name:'Normalize selected per-file results even on failure',conclusion:'failure'}]};
  const options={repo:REPO,targetSha:target,subjectIssue:1822};
  const invoke=(r=run,jb=jobs,a=artifact,re=result,p=pr,c=compare,e=e2e,o=options)=>
    attestCrossIssueAcceptance(pin,r,jb,a,re,p,c,e,o);
  assert.equal(invoke().source_sc_result,'Pass');
  assert.equal(invoke().source_e2e_workflow_conclusion,'failure');
  for (const [r,jb,a,re,p,c,e,o] of [
    [{...run,run_attempt:6},jobs,artifact,result,pr,compare,e2e,options],
    [run,{jobs:[exec,{...updater,run_attempt:6}]},artifact,result,pr,compare,e2e,options],
    [run,{jobs:[{...exec,steps:exec.steps.filter(s=>s.name!=='Run read-only Acceptance Agent')},updater]},artifact,result,pr,compare,e2e,options],
    [run,jobs,{...artifact,digest:'sha256:broken'},result,pr,compare,e2e,options],
    [run,jobs,artifact,{...result,target_ref:head},pr,compare,e2e,options],
    [run,jobs,artifact,{...result,criteria:[{criterion:'SC-02',result:'Pending'}]},pr,compare,e2e,options],
    [run,jobs,artifact,result,{...pr,merged_at:null},compare,e2e,options],
    [run,jobs,artifact,result,pr,{...compare,merge_base_commit:{sha:head}},e2e,options],
    [run,jobs,artifact,result,pr,compare,{...e2e,workflow_conclusion:'success'},options],
    [run,jobs,artifact,result,pr,compare,{...e2e,steps:e2e.steps.slice(1)},options],
    [run,jobs,artifact,result,pr,compare,e2e,{...options,subjectIssue:1719}],
  ]) assert.throws(()=>invoke(r,jb,a,re,p,c,e,o),/unverified|missing|unsuccessful|lacks/);
  console.log('historical cross-Issue Acceptance proof self-test passed');
}
if(process.argv[1] && path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
  if(process.argv[2]!=='self-test')throw Error('usage: acceptance-cross-issue-receipt.mjs self-test');
  selfTest();
}
