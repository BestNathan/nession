#!/usr/bin/env node
// #4146: read-only PR Quality completion -> existing SC evaluator.
// The source Run notification is a hint; trusted main re-reads GitHub.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parsePreMergeIssueNumbers,extractSection,parseSuccessCriteria,
  parseAcceptanceReport,isAcceptanceIssue} from './requirement-acceptance.mjs';
import {planStage,validateAcceptancePlan} from './acceptance-plan.mjs';
import {collectPrRequiredQualityAsync,validPrRequiredQualityReceipt}
  from './acceptance-pr-web-quality-receipt.mjs';

const REPO='BestNathan/nession',WORKFLOW='.github/workflows/ci-quality.yml';
const SHA=/^[a-f0-9]{40}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;

export function eligibleSource(event,run) {
  const hint=event?.workflow_run;
  return Boolean(event?.action==='completed'&&event?.repository?.full_name===REPO&&
    positive(hint?.id)&&positive(hint?.run_attempt)&&SHA.test(hint?.head_sha??'')&&
    run?.id===hint.id&&run?.run_attempt===hint.run_attempt&&
    run?.head_sha===hint.head_sha&&run?.name==='CI / Quality Gate'&&
    run?.path===WORKFLOW&&run?.event==='pull_request'&&
    run?.status==='completed'&&run?.conclusion==='success'&&
    run?.repository?.full_name===REPO&&run?.head_repository?.full_name===REPO);
}

export function needsQualityReevaluation(issue,head,oldStatuses={}) {
  if(!isAcceptanceIssue(issue)||issue?.state!=='open'||issue.pull_request)return false;
  const sc=parseSuccessCriteria(extractSection(issue.body,'Success Criteria'));
  const report=parseAcceptanceReport(extractSection(issue.body,'Acceptance Report'));
  const plan=validateAcceptancePlan(issue.body,sc.criteria.keys(),report.rows);
  if(sc.errors.length||report.errors.length||plan.errors.length)return false;
  for(const [id,criterion] of sc.criteria){
    const entry=plan.plan?.get(id),row=report.rows.get(id);
    if(!entry||planStage(entry)!=='pr'||entry.method!=='agent')continue;
    if(!criterion.checked||['Pending','Fail'].includes(row?.result))return true;
    if(row?.result!=='Pass')continue;
    const old=/^run [1-9]\d*; ref ([a-f0-9]{40}); source agent(?:-[a-z0-9-]+)?;/i
      .exec(String(row.evidence??''))?.[1]?.toLowerCase();
    if(old&&old!==head&&oldStatuses[old]==='fail')return true;
  }
  return false;
}

export async function selectPrQualityWake(event,{request,readQuality}) {
  if(!positive(event?.workflow_run?.id)||event.action!=='completed')
    return {head_sha:null,issues:[]};
  const source=await request('/repos/'+REPO+'/actions/runs/'+event.workflow_run.id);
  if(!eligibleSource(event,source))return {head_sha:null,issues:[]};
  const qualified=await readQuality(source.head_sha);
  if(qualified?.status!=='pass'||
      !validPrRequiredQualityReceipt(qualified.receipt,source.head_sha)||
      qualified.receipt.run_id!==source.id||
      qualified.receipt.run_attempt!==source.run_attempt)
    return {head_sha:null,issues:[]};
  const related=await request('/repos/'+REPO+'/commits/'+source.head_sha+
    '/pulls?per_page=100');
  if(!Array.isArray(related)||related.length>=100)
    throw Error('incomplete PR association at exact Quality source');
  const prs=related.filter(pr=>pr?.state==='open'&&pr?.draft===false&&
    pr.head?.sha===source.head_sha&&pr.head?.repo?.full_name===REPO&&
    pr.base?.repo?.full_name===REPO&&['main','staging'].includes(pr.base?.ref));
  const ids=[...new Set(prs.flatMap(pr=>parsePreMergeIssueNumbers(
    pr.body??'','BestNathan','nession',pr.title??'')))];
  if(ids.length>30)throw Error('unbounded PR linked Issue discovery');
  const issues=[],oldStatuses={};
  for(const id of ids) {
    const issue=await request('/repos/'+REPO+'/issues/'+id);
    if(issue?.number!==id||issue?.state!=='open'||!isAcceptanceIssue(issue))continue;
    const report=parseAcceptanceReport(extractSection(issue.body,'Acceptance Report'));
    const refs=[...new Set([...report.rows.values()].flatMap(row=>{
      const m=/^run [1-9]\d*; ref ([a-f0-9]{40}); source agent(?:-[a-z0-9-]+)?;/i
        .exec(String(row.evidence??''));
      return row.result==='Pass'&&m&&m[1]!==source.head_sha?[m[1]]:[];
    }))];
    if(refs.length>16)continue;
    for(const ref of refs)if(!Object.hasOwn(oldStatuses,ref))
      oldStatuses[ref]=(await readQuality(ref))?.status??'pending';
    if(needsQualityReevaluation(issue,source.head_sha,oldStatuses))issues.push(id);
  }
  return {head_sha:source.head_sha,issues:issues.sort((a,b)=>a-b),
    source_run_id:source.id,source_attempt:source.run_attempt};
}

async function githubJson(path,token) {
  if(typeof token!=='string'||token.length<8)throw Error('GitHub token missing');
  const r=await fetch('https://api.github.com'+path,{headers:{
    Accept:'application/vnd.github+json',Authorization:'Bearer '+token,
    'X-GitHub-Api-Version':'2022-11-28'}});
  if(!r.ok)throw Error('GitHub Quality wake source '+r.status);
  return r.json();
}

async function selfTest() {
  const head='a'.repeat(40),old='b'.repeat(40);
  const run={id:13,run_attempt:2,name:'CI / Quality Gate',path:WORKFLOW,
    head_sha:head,event:'pull_request',status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO}};
  const event={action:'completed',repository:{full_name:REPO},
    workflow_run:{id:13,run_attempt:2,head_sha:head}};
  const receipt={kind:'pr_required_quality_v1',repository:REPO,workflow:WORKFLOW,
    head_sha:head,result:'success',run_id:13,run_attempt:2,
    scope_job_id:11,web_check_job_id:12,
    scope_step:'Classify the exact PR or main-push change',
    web_check_step:'Enforce applicable Quality results at the stable check name',
    job_outcomes:{'instruction-check':'skipped','workflow-check':'skipped',
      'rust-check':'skipped','tooling-check':'success','web-tests':'skipped'}};
  const ticks=String.fromCharCode(96).repeat(3);
  const body=['## Success Criteria','- [x] SC-01 original approved behavior',
    '## Acceptance Plan',ticks+'yaml','acceptance:','  SC-01:',
    '    when: pr','    method: agent',ticks,
    '## Acceptance Report','| Criterion | Result | Evidence |',
    '|---|---|---|','| SC-01 | Pass | run 100; ref '+old+
      '; source agent-qwen; old proof |'].join('\n');
  const issue={number:4146,state:'open',labels:[{name:'bug'}],body};
  const pr={number:23,state:'open',draft:false,title:'fix (#4146)',
    body:'Refs #4146',head:{sha:head,repo:{full_name:REPO}},
    base:{ref:'main',repo:{full_name:REPO}}};
  const request=async p=>{
    if(p.includes('/actions/runs/'))return run;
    if(p.includes('/commits/'))return [pr];
    if(p.includes('/issues/4146'))return issue;
    throw Error('unrecognized test path '+p);
  };
  const quality=async sha=>sha===head?{status:'pass',receipt}:
    {status:'fail',reason:'old web-check failed'};
  const verify=(e=event,req=request,q=quality)=>
    selectPrQualityWake(e,{request:req,readQuality:q});
  assert.deepEqual((await verify()).issues,[4146]);
  assert.deepEqual((await verify({...event,workflow_run:{
    ...event.workflow_run,head_sha:old}})).issues,[]);
  assert.deepEqual((await verify(event,request,async()=>({status:'pending'}))).issues,[]);
  assert.deepEqual((await verify(event,async p=>p.includes('/actions/runs/')
    ?{...run,run_attempt:1}:request(p))).issues,[]);
  assert.deepEqual((await verify(event,async p=>p.includes('/actions/runs/')
    ?{...run,head_repository:{full_name:'other/repo'}}:request(p))).issues,[]);
  assert.deepEqual((await verify(event,async p=>p.includes('/commits/')
    ?[{...pr,state:'closed'}]:request(p))).issues,[]);
  assert.deepEqual((await verify(event,async p=>p.includes('/commits/')
    ?[{...pr,head:{...pr.head,sha:old}}]:request(p))).issues,[]);
  assert.deepEqual((await verify(event,async p=>p.includes('/issues/')
    ?{...issue,body:body.replaceAll(old,head)}:request(p))).issues,[]);
  assert.deepEqual((await verify(event,request,async sha=>
    ({status:'pass',receipt:{...receipt,head_sha:sha}}))).issues,[]);
  assert.equal(needsQualityReevaluation({...issue,
    body:body.replace('| Pass |','| Pending |')},head),true);
  assert.equal(needsQualityReevaluation({...issue,state:'closed'},head,{[old]:'fail'}),false);
  console.log('PR Quality Waker: exact SHA, run/attempt, stale/fork, pending and source recovery passed');
}

async function main(){
  if(process.argv[2]==='self-test')return selfTest();
  if(process.argv[2]!=='select'||!process.env.GITHUB_EVENT_PATH||
      !process.env.GITHUB_OUTPUT)throw Error('usage: PR Quality Waker select');
  const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
  const request=p=>githubJson(p,token);
  const event=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  const wake=await selectPrQualityWake(event,{request,
    readQuality:sha=>collectPrRequiredQualityAsync(sha,request)});
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    'head_sha='+(wake.head_sha??'')+'\n'+
    'issue_numbers='+JSON.stringify(wake.issues)+'\n'+
    'has_issues='+(wake.issues.length>0?'true':'false')+'\n');
  console.log('Trusted PR Quality source: '+JSON.stringify(wake));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
