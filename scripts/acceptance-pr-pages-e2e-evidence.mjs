#!/usr/bin/env node
// Trusted-main bounded PR-stage evidence for the public Pages Protocol Reference.
// This is NOT a generic PR collector or an independent Acceptance verdict.
// The source E2E and its Issue projection were attested by the established
// E2E / Test Ingest writer. Re-authenticate exact GitHub Run+Job+Artifact
// identity and read only the protected orphan Store's committed record.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {verifyReporterEvidence} from './issue-e2e-source-attestation.mjs';
import {verifyArchivedProjectionReceipt,createProjectionReceipt} from './issue-e2e-projection-receipt.mjs';
import {summarize} from '../e2e/runner/selected-report.mjs';
import {parseIssueE2E,parseE2EEvidence} from './issue-e2e-contract.mjs';

const REPO='BestNathan/nession';
const ISSUE=3195, PR=3175;
const SHA=/^[a-f0-9]{40}$/;
const SHA256=/^[a-f0-9]{64}$/;
const API='https://api.github.com/repos/'+REPO;
const MAX_ZIP=8_000_000;
const requiredPages=[
  ['Pages unit, security and static build',
    ['Verify standalone projection and import boundary',
     'Build sanitized Pages without network credentials']],
  ['Pages browser smoke (Chromium only)',
    ['Run standalone Pages browser scenarios (no product runtime)']],
];
const requiredE2e=[
  'Resolve linked Issue E2E obligations',
  'Run E2E tests',
  'Verify canonical browser design gate from the single E2E run',
  'Prove coalesced Browser Design evidence fails closed',
  'Enforce authenticated selected-E2E execution result',
];
const requiredIngest=[
  'Independently validate and project per-ID results',
  'Store immutable results and update Issue reports',
];
const hash=x=>createHash('sha256').update(x).digest('hex');
function sameRun(run,{name,workflow,event,sha}){
  assert.equal(run?.name,name);
  assert.equal(run?.path,workflow);
  assert.equal(run?.event,event);
  assert.equal(run?.status,'completed');
  assert.equal(run?.conclusion,'success');
  assert.equal(run?.head_sha,sha);
  assert.equal(run?.repository?.full_name,REPO);
  assert.equal(run?.head_repository?.full_name,REPO);
  assert.ok(Number.isSafeInteger(run.id)&&run.id>0);
  assert.ok(Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0);
}
function jobPass(payload,name,steps,run){
  const jobs=payload?.jobs;
  assert.ok(Array.isArray(jobs)&&jobs.length<=100,'bounded GitHub jobs required');
  const matches=jobs.filter(j=>j.name===name);
  assert.equal(matches.length,1,'missing/duplicate job '+name);
  const j=matches[0];
  assert.equal(j.run_id,run.id);
  assert.equal(j.run_attempt,run.run_attempt);
  assert.equal(j.head_sha,run.head_sha);
  assert.equal(j.status,'completed');
  assert.equal(j.conclusion,'success');
  for(const required of steps){
    const matches=(j.steps||[]).filter(s=>s.name===required);
    assert.equal(matches.length,1,'missing/duplicate step '+required);
    assert.equal(matches[0].status,'completed');
    assert.equal(matches[0].conclusion,'success');
  }
  return {job_id:j.id,steps:steps.length};
}
function isSelectedId(plan,id){
  return plan.selected?.some(row=>row.id===id&&
    row.owners?.some(owner=>owner.issue===ISSUE));
}
export function verifyProtocolPagesEvidence(data,sha){
  assert.match(sha,SHA);
  assert.equal(data.issue?.number,ISSUE);
  assert.equal(data.issue?.state,'open');
  assert.equal(data.pr?.number,PR);
  assert.equal(data.pr?.state,'open');
  assert.equal(data.pr?.head?.sha,sha);
  assert.equal(data.pr?.head?.repo?.full_name,REPO);
  assert.equal(data.pr?.base?.repo?.full_name,REPO);
  const declaration=parseIssueE2E(data.issue.body,{requireDeclaration:true});
  assert.deepEqual(declaration.errors,[]);
  assert.deepEqual(declaration.newIds,['pages-documents']);
  assert.deepEqual(declaration.regressionIds,['pages-overview']);
  for(const id of declaration.selectedIds){
    const row=declaration.rows.get(id);
    assert.equal(row?.result,'Pass','Issue E2E proof is not Pass');
    const ref=parseE2EEvidence(row,declaration.digest);
    assert.equal(ref.sha,sha);
    assert.equal(ref.run,data.e2eRun.id);
    assert.equal(ref.attempt,data.e2eRun.run_attempt);
  }
  sameRun(data.e2eRun,{name:'E2E / Tests',workflow:'.github/workflows/e2e-tests.yml',
    event:'pull_request',sha});
  assert.ok(data.e2eRun.pull_requests?.some(p=>p.number===PR),
    'E2E source Run is not associated with source PR');
  const e2e=jobPass(data.e2eJobs,'e2e',requiredE2e,data.e2eRun);
  assert.equal(data.artifact?.name,'issue-e2e-verification');
  assert.equal(data.artifact?.expired,false);
  assert.equal(data.artifact?.workflow_run?.id,data.e2eRun.id);
  assert.equal(data.artifact?.workflow_run?.head_sha,sha);
  assert.ok(Number.isSafeInteger(data.artifact.id)&&data.artifact.id>0);
  assert.match(data.artifact.digest||'',/^sha256:[a-f0-9]{64}$/);
  assert.equal(data.artifact.digest,'sha256:'+hash(data.zipBytes),
    'authenticated source artifact ZIP checksum mismatch');
  assert.equal(data.plan?.schema_version,1);
  assert.equal(data.plan?.mode,'selected');
  assert.equal(data.plan?.pr_number,PR);
  assert.equal(data.plan?.target_sha,sha);
  assert.equal(data.plan?.base_sha,data.pr.base.sha,
    'PR base changed since source tests; require fresh E2E');
  assert.equal(data.plan?.issues?.length,1);
  assert.equal(data.plan.issues[0]?.issue,ISSUE);
  assert.equal(data.plan.issues[0]?.declaration_digest,declaration.digest);
  assert.deepEqual(data.plan.selected.map(x=>x.id).sort(),declaration.selectedIds);
  for(const id of declaration.selectedIds)
    assert.ok(isSelectedId(data.plan,id),'source Plan lacks Issue-owned E2E ID');
  assert.equal(data.results?.status,'Pass');
  assert.equal(data.results?.target_sha,sha);
  assert.equal(data.results?.run_id,data.e2eRun.id);
  assert.equal(data.results?.run_attempt,data.e2eRun.run_attempt);
  assert.equal(data.results?.plan_digest,data.plan.plan_digest);
  // Reproduce the original Playwright/independent assertion-reporter
  // verdict, not just the summary in a mutable Issue or PR body.
  verifyReporterEvidence(data.plan,data.results,data.playwright,data.assertions);
  assert.equal(data.record?.run_id,data.e2eRun.id);
  assert.equal(data.record?.run_attempt,data.e2eRun.run_attempt);
  assert.equal(data.record?.target_sha,sha);
  assert.equal(data.record?.artifact_digest,data.artifact.digest);
  assert.deepEqual(data.record?.results,data.results.results);
  const receipt=verifyArchivedProjectionReceipt(
    data.receipt,data.record,data.plan,ISSUE);
  assert.equal(receipt.outcome,'applied','must have a real trusted Issue PATCH');
  assert.equal(receipt.target_sha,sha);
  assert.deepEqual(receipt.rows.map(row=>row.id).sort(),declaration.selectedIds);
  assert.ok(receipt.rows.every(row=>row.result==='Pass'));
  sameRun(data.ingestRun,{name:'E2E / Test Ingest',
    workflow:'.github/workflows/e2e-test-ingest.yml',
    event:'workflow_run',sha:data.ingestRun.head_sha});
  assert.equal(data.ingestRun.id,receipt.ingest_run_id);
  assert.equal(data.ingestRun.run_attempt,receipt.ingest_attempt);
  const ingest=jobPass(data.ingestJobs,'ingest-pr',requiredIngest,data.ingestRun);
  sameRun(data.pagesRun,{name:'CI / Pages',workflow:'.github/workflows/ci-pages.yml',
    event:'pull_request',sha});
  assert.ok(data.pagesRun.pull_requests?.some(p=>p.number===PR));
  const pages=requiredPages.map(([name,steps])=>
    ({name,...jobPass(data.pagesJobs,name,steps,data.pagesRun)}));
  const selected=data.results.results.map(row=>{
    assert.ok(isSelectedId(data.plan,row.id));
    assert.equal(row.result,'Pass');
    assert.ok(row.discovered>0&&row.passed===row.discovered&&row.assertions>0);
    return {id:row.id,result:'Pass',passed:row.passed,
      discovered:row.discovered,assertions:row.assertions};
  });
  assert.equal(selected.length,declaration.selectedIds.length);
  return {
    schema_version:1,kind:'acceptance_ci_evidence',target_sha:sha,
    verified_pr_pages_protocol_reference:{
      verdict:'Verified',issue:ISSUE,pr:PR,target_sha:sha,
      e2e:{run_id:data.e2eRun.id,attempt:data.e2eRun.run_attempt,
        job_id:e2e.job_id,source_sha:sha,selected,
        artifact_id:data.artifact.id,artifact_digest:data.artifact.digest},
      ingest:{run_id:data.ingestRun.id,attempt:data.ingestRun.run_attempt,
        job_id:ingest.job_id,issue_projection:'applied',
        declaration_digest:declaration.digest,plan_digest:data.plan.plan_digest,
        immutable_record:'runs/'+data.day+'/'+data.e2eRun.id+'-'+data.e2eRun.run_attempt+
          '/test/issue-e2e.json'},
      pages:{run_id:data.pagesRun.id,attempt:data.pagesRun.run_attempt,
        source_sha:sha,jobs:pages}
    }
  };
}

async function api(url,token,accept='application/vnd.github+json'){
  const response=await fetch(url,{headers:{
    accept,'x-github-api-version':'2022-11-28',
    'user-agent':'nession-trusted-pr-pages-acceptance',
    authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('GitHub public read-only HTTP '+response.status);
  return response;
}
async function json(url,token){
  return (await api(url,token)).json();
}
async function jobsFor(run,token){
  return json(API+'/actions/runs/'+run.id+'/attempts/'+
    run.run_attempt+'/jobs?per_page=100',token);
}
async function orphanJSON(file,token){
  // The orphan branch is an attestation lookup, never executable source.
  const response=await json(API+'/contents/'+file+
    '?ref=acceptance-results',token);
  if(response?.encoding==='base64')return JSON.parse(
    Buffer.from(response.content.replace(/\s/g,''),'base64').toString('utf8'));
  if(response?.kind)return response; // GitHub connector/raw compatible
  throw Error('invalid protected orphan Store JSON');
}
function zipJson(zip,member){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-pr-e2e-'));
  try{
    const file=path.join(root,'artifact.zip');
    fs.writeFileSync(file,zip,{flag:'wx',mode:0o600});
    return JSON.parse(execFileSync('unzip',['-p',file,member],{
      encoding:'utf8',timeout:20000,maxBuffer:1_500_000}));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
// GitHub's artifact API returns a 302 to a short-lived signed HTTPS URL,
// not a ZIP directly. Only the GitHub API request receives GITHUB_TOKEN.
// Never follow that redirect with an Authorization header.
export async function downloadZip(artifact,token,fetcher=fetch){
  assert.ok(Number.isSafeInteger(artifact?.id)&&artifact.id>0);
  if(!token)throw Error('authenticated GitHub artifact metadata required');
  const response=await fetcher(API+'/actions/artifacts/'+artifact.id+'/zip',{
    redirect:'manual',signal:AbortSignal.timeout(20000),
    headers:{
      accept:'application/vnd.github+json',
      'x-github-api-version':'2022-11-28',
      'user-agent':'nession-trusted-pr-pages-acceptance',
      authorization:'Bearer '+token
    }});
  if(response.status!==302)
    throw Error('GitHub artifact API must return signed 302; HTTP '+response.status);
  const location=response.headers.get('location');
  if(!location)throw Error('GitHub artifact redirect is missing Location');
  let signed;
  try{signed=new URL(location);}catch{throw Error('invalid artifact redirect URL');}
  const host=signed.hostname.toLowerCase();
  if(signed.protocol!=='https:'||signed.username||signed.password||
    !host||host==='localhost'||host.endsWith('.localhost')||
    host==='127.0.0.1'||host==='[::1]'||host.endsWith('.internal'))
    throw Error('invalid artifact redirect origin');
  // Signed storage URL is independently fetched, without the GitHub token,
  // with redirects disabled (a second unexpected hop is not authorized).
  const zip=await fetcher(signed.href,{redirect:'error',
    signal:AbortSignal.timeout(20000)});
  if(zip.status!==200)throw Error('signed artifact HTTP '+zip.status);
  const declared=zip.headers.get('content-length');
  if(declared!==null&&(!/^[0-9]+$/.test(declared)||Number(declared)>MAX_ZIP))
    throw Error('oversized/invalid source artifact length');
  if(!zip.body)throw Error('signed artifact has no ZIP body');
  const parts=[];let total=0;
  for await (const part of zip.body){
    const buf=Buffer.from(part);
    total+=buf.length;
    if(total>MAX_ZIP)throw Error('oversized source artifact stream');
    parts.push(buf);
  }
  if(!total)throw Error('empty source artifact ZIP');
  if(declared!==null&&Number(declared)!==total)
    throw Error('source artifact size disagrees with response');
  return Buffer.concat(parts,total);
}
function pick(runs,name,path,sha){
  const selected=runs.filter(r=>r.name===name&&r.path===path&&
    r.event==='pull_request'&&r.head_sha===sha&&
    r.repository?.full_name===REPO&&r.head_repository?.full_name===REPO&&
    r.status==='completed'&&r.conclusion==='success'&&
    r.pull_requests?.some(p=>p.number===PR)).sort((a,b)=>b.id-a.id);
  if(!selected.length)throw Error('missing exact-source '+name+' run');
  return selected[0];
}
export async function collect({root,token,issueNumber,stage}){
  if(Number(issueNumber)!==ISSUE||stage!=='pre-merge')
    throw Error('unapproved PR-stage evidence selector');
  if(!token)throw Error('read-only GitHub token required');
  const sha=execFileSync('git',['-C',root,'rev-parse','HEAD'],{
    encoding:'utf8',timeout:15000}).trim();
  assert.match(sha,SHA);
  const [issue,pr,runList]=await Promise.all([
    json(API+'/issues/'+ISSUE,token),
    json(API+'/pulls/'+PR,token),
    json(API+'/actions/runs?head_sha='+sha+'&per_page=100',token)]);
  assert.equal(pr.head?.sha,sha);
  const rows=parseIssueE2E(issue.body,{requireDeclaration:true});
  assert.deepEqual(rows.errors,[]);
  const source=parseE2EEvidence(rows.rows.get('pages-documents'),rows.digest);
  assert.equal(source.sha,sha);
  const e2eRun=await json(API+'/actions/runs/'+source.run,token);
  const pagesRun=pick(runList.workflow_runs||[],'CI / Pages',
    '.github/workflows/ci-pages.yml',sha);
  const day=e2eRun.created_at?.slice(0,10);
  assert.match(day||'',/^\d{4}-\d{2}-\d{2}$/);
  const base='runs/'+day+'/'+e2eRun.id+'-'+e2eRun.run_attempt+'/test';
  const [e2eJobs,pagesJobs,artifactList,record,receipt]=await Promise.all([
    jobsFor(e2eRun,token),jobsFor(pagesRun,token),
    json(API+'/actions/runs/'+e2eRun.id+'/artifacts?per_page=100',token),
    orphanJSON(base+'/issue-e2e.json',token),
    orphanJSON(base+'/projections/'+ISSUE+'.json',token)
  ]);
  const artifacts=(artifactList.artifacts||[]).filter(a=>
    a.name==='issue-e2e-verification'&&a.expired===false&&
    a.workflow_run?.id===e2eRun.id);
  assert.equal(artifacts.length,1,'ambiguous Issue E2E artifact');
  const artifact=artifacts[0];
  const [ingestRun,zipBytes]=await Promise.all([
    json(API+'/actions/runs/'+receipt.ingest_run_id,token),
    downloadZip(artifact,token)
  ]);
  const ingestJobs=await jobsFor(ingestRun,token);
  const plan=zipJson(zipBytes,'plan.json');
  const results=zipJson(zipBytes,'results.json');
  const playwright=zipJson(zipBytes,'playwright.json');
  const assertions=zipJson(zipBytes,'assertions.json');
  return verifyProtocolPagesEvidence({
    issue,pr,e2eRun,e2eJobs,artifact,zipBytes,plan,results,
    playwright,assertions,record,receipt,ingestRun,ingestJobs,
    pagesRun,pagesJobs,day
  },sha);
}
function selfTestFixture(){
  const sha='a'.repeat(40),main='b'.repeat(40),base='d'.repeat(40);
  const ids=['pages-documents','pages-overview'];
  const initial=['## E2E Verification','### New','- pages-documents',
    '### Regression','- pages-overview','## E2E Report',
    '| ID | Type | Result | Evidence |','|---|---|---|---|',
    '| pages-documents | New | Pending | - |',
    '| pages-overview | Regression | Pending | - |'].join('\n');
  const declaration=parseIssueE2E(initial,{requireDeclaration:true});
  assert.deepEqual(declaration.errors,[]);
  const plan={schema_version:1,kind:'issue_e2e_selection',
    mode:'selected',pr_number:PR,base_sha:base,target_sha:sha,
    plan_digest:'c'.repeat(64),
    issues:[{issue:ISSUE,declaration_digest:declaration.digest,
      new_ids:['pages-documents'],regression_ids:['pages-overview']}],
    selected:ids.map((id,i)=>({id,owners:[{issue:ISSUE,
      type:i===0?'New':'Regression'}]}))};
  const playwright={stats:{},suites:ids.map(id=>({file:id+'.spec.ts',
    specs:[{file:id+'.spec.ts',title:id,line:7,
      tests:[{status:'expected',results:[{retry:0,status:'passed'}]}]}]}))};
  const assertions={schema_version:1,kind:'playwright_assertion_steps',
    tests:ids.map(id=>({id,title:id,line:7,retry:0,status:'passed',
      assertions:5}))};
  const results={...summarize(plan,playwright,assertions),
    run_id:101,run_attempt:1};
  const zipBytes=Buffer.from('fake ZIP bytes; integrity is still checked');
  const artifactDigest='sha256:'+hash(zipBytes);
  const evidence=id=>'run 101/1, SHA '+sha+', contract '+declaration.digest+
    ', plan '+plan.plan_digest+', tests 1/1 (https://github.com/'+REPO+
    '/actions/runs/101)';
  const body=initial.replace('| pages-documents | New | Pending | - |',
      '| pages-documents | New | Pass | '+evidence('pages-documents')+' |')
    .replace('| pages-overview | Regression | Pending | - |',
      '| pages-overview | Regression | Pass | '+evidence('pages-overview')+' |');
  const record={schema_version:1,kind:'issue_e2e_run',run_id:101,
    run_attempt:1,target_sha:sha,plan_digest:plan.plan_digest,
    artifact_digest:artifactDigest,results:results.results};
  const receipt=createProjectionReceipt({
    record,plan,issue:ISSUE,projected:{body},
    before:{number:ISSUE,body:initial},
    patch:{number:ISSUE,body,updated_at:'2026-11-10T13:00:00Z'},
    readback:{number:ISSUE,body,updated_at:'2026-11-10T13:01:00Z'},
    outcome:'applied',ingestRunId:201,ingestAttempt:1});
  const run=(id,name,path,event,head)=>({id,name,path,event,head_sha:head,
    run_attempt:1,status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    pull_requests:id===201?[]:[{number:PR}]});
  const job=(run,name,names)=>({id:run.id*10,run_id:run.id,
    run_attempt:1,head_sha:run.head_sha,name,status:'completed',
    conclusion:'success',steps:names.map(name=>({name,status:'completed',
      conclusion:'success'}))});
  const e2eRun=run(101,'E2E / Tests','.github/workflows/e2e-tests.yml',
    'pull_request',sha);
  const ingestRun=run(201,'E2E / Test Ingest',
    '.github/workflows/e2e-test-ingest.yml','workflow_run',main);
  const pagesRun=run(301,'CI / Pages','.github/workflows/ci-pages.yml',
    'pull_request',sha);
  const data={
    issue:{number:ISSUE,state:'open',body},pr:{number:PR,state:'open',
      head:{sha,repo:{full_name:REPO}},base:{sha:base,repo:{full_name:REPO}}},
    e2eRun,e2eJobs:{jobs:[job(e2eRun,'e2e',requiredE2e)]},
    artifact:{id:777,name:'issue-e2e-verification',expired:false,
      digest:artifactDigest,workflow_run:{id:e2eRun.id,head_sha:sha}},
    zipBytes,plan,results,playwright,assertions,record,receipt,
    ingestRun,ingestJobs:{jobs:[job(ingestRun,'ingest-pr',requiredIngest)]},
    pagesRun,pagesJobs:{jobs:requiredPages.map(([name,steps])=>
      job(pagesRun,name,steps))},day:'2026-11-10'
  };
  return {data,sha};
}
async function test(){
  const bytes=Buffer.from([0x50,0x4b,0x03,0x04,0x61]);
  const headerMap=o=>({get:key=>o[key]??null});
  const goodZip={status:200,headers:headerMap({'content-length':String(bytes.length)}),
    // A Response body stream is single-use: give each negative case a fresh
    // iterator rather than reusing the already consumed success fixture.
    get body(){return (async function*(){yield bytes.slice(0,4);yield bytes.slice(4);})();}};
  const calls=[];
  const signed='https://productionresultssa1.blob.core.windows.net/artifacts/zip?sig=signed';
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    return calls.length===1?{status:302,headers:headerMap({location:signed})}:goodZip;
  };
  assert.deepEqual(await downloadZip({id:777},'test-only-token',fetcher),bytes);
  assert.equal(calls.length,2);
  assert.ok(calls[0].url.endsWith('/actions/artifacts/777/zip'));
  assert.equal(calls[0].options.headers.accept,'application/vnd.github+json');
  assert.equal(calls[0].options.headers.authorization,'Bearer test-only-token');
  assert.equal(calls[0].options.redirect,'manual');
  assert.equal(calls[1].url,signed);
  assert.equal(calls[1].options.headers,undefined,
    'signed storage must never see a GitHub bearer token');
  assert.equal(calls[1].options.redirect,'error');
  const rejects=async(first,second,reason)=>{
    await assert.rejects(()=>downloadZip({id:777},'token',async(url,opts)=>
      opts.redirect==='manual'?first:second),reason);
  };
  await rejects({status:415,headers:headerMap({})},goodZip,/HTTP 415/);
  await rejects({status:302,headers:headerMap({})},goodZip,/missing Location/);
  for(const url of ['http://example.com/data','https://localhost/data',
    'https://127.0.0.1/data','https://user:password@example.com/data',
    'not-a-URL']){
    await rejects({status:302,headers:headerMap({location:url})},goodZip,
      /invalid artifact redirect/);
  }
  const signedRedirect={status:302,headers:headerMap({location:signed})};
  await rejects(signedRedirect,{...goodZip,status:301},/signed artifact HTTP/);
  await rejects(signedRedirect,{...goodZip,body:null},/no ZIP body/);
  await rejects(signedRedirect,{...goodZip,headers:
    headerMap({'content-length':String(MAX_ZIP+1)})},/oversized/);
  await rejects(signedRedirect,{...goodZip,headers:
    headerMap({'content-length':'1'})},/size disagrees/);
  await rejects(signedRedirect,{...goodZip,
    body:(async function*(){yield Buffer.alloc(MAX_ZIP);yield Buffer.of(1);})()},
    /oversized source artifact stream/);
  await rejects(signedRedirect,{...goodZip,
    body:(async function*(){})(),headers:headerMap({})},/empty source artifact/);
  assert.throws(()=>verifyProtocolPagesEvidence({},'invalid'),/regular expression/);
  assert.throws(()=>verifyProtocolPagesEvidence({issue:{number:ISSUE}},'a'.repeat(40)),
    /open/);
  const safe={name:'e2e',run_id:1,run_attempt:1,head_sha:'a'.repeat(40),
    status:'completed',conclusion:'success',steps:requiredE2e.map(name=>({
      name,status:'completed',conclusion:'success'}))};
  const run={id:1,run_attempt:1,head_sha:'a'.repeat(40)};
  assert.equal(jobPass({jobs:[safe]},'e2e',requiredE2e,run).steps,5);
  for(const bad of [
    {...safe,head_sha:'b'.repeat(40)},
    {...safe,conclusion:'skipped'},
    {...safe,steps:safe.steps.slice(1)},
    {...safe,steps:[...safe.steps,safe.steps[0]]},
  ])assert.throws(()=>jobPass({jobs:[bad]},'e2e',requiredE2e,run));
  assert.throws(()=>pick([], 'CI / Pages','.github/workflows/ci-pages.yml',
    'a'.repeat(40)),/missing/);
  const {data,sha}=selfTestFixture();
  const verified=verifyProtocolPagesEvidence(data,sha);
  assert.equal(verified.verified_pr_pages_protocol_reference.verdict,'Verified');
  assert.deepEqual(verified.verified_pr_pages_protocol_reference.e2e.selected
    .map(r=>r.id),['pages-documents','pages-overview']);
  const deny=edit=>assert.throws(()=>verifyProtocolPagesEvidence(edit(data),sha));
  deny(x=>({...x,pr:{...x.pr,head:{...x.pr.head,sha:'f'.repeat(40)}}}));
  deny(x=>({...x,pr:{...x.pr,base:{...x.pr.base,sha:'f'.repeat(40)}}}));
  deny(x=>({...x,zipBytes:Buffer.from('tampered ZIP')}));
  deny(x=>({...x,artifact:{...x.artifact,digest:'sha256:'+'f'.repeat(64)}}));
  deny(x=>({...x,e2eRun:{...x.e2eRun,head_sha:'f'.repeat(40)}}));
  deny(x=>({...x,e2eJobs:{jobs:[{...x.e2eJobs.jobs[0],steps:
    x.e2eJobs.jobs[0].steps.slice(0,-1)}]}}));
  deny(x=>({...x,pagesJobs:{jobs:x.pagesJobs.jobs.slice(0,1)}}));
  deny(x=>({...x,results:{...x.results,results:
    [{...x.results.results[0],assertions:0},x.results.results[1]]}}));
  deny(x=>({...x,receipt:{...x.receipt,outcome:'recovered'}}));
  deny(x=>({...x,record:{...x.record,run_attempt:2}}));
  deny(x=>({...x,ingestRun:{...x.ingestRun,conclusion:'failure'}}));
  deny(x=>({...x,ingestJobs:{jobs:[{...x.ingestJobs.jobs[0],
    steps:x.ingestJobs.jobs[0].steps.slice(0,1)}]}}));
  console.log('PR Pages acceptance: authenticated fixture, ZIP 302 credential isolation and 12+ fail-closed negatives passed');
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
  const [mode,root,out]=process.argv.slice(2);
  if(mode==='self-test')test().catch(e=>{console.error(e);process.exitCode=1;});
  else if(mode==='collect'){
    collect({root,token:process.env.GITHUB_TOKEN||process.env.GH_TOKEN,
      issueNumber:process.env.ISSUE_NUMBER,stage:process.env.ACCEPTANCE_STAGE})
      .then(x=>{fs.writeFileSync(out,JSON.stringify(x,null,2)+'\n',{flag:'wx'});
        console.log('Authenticated exact-head PR Pages E2E/CI proof');})
      .catch(e=>{console.error(e.stack||e);process.exitCode=1;});
  }else throw Error('usage: ... self-test | collect ROOT OUTPUT');
}
