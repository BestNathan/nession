// GitHub-owned historical E2E evidence for read-only Issue Acceptance.
// Scope: commits that belong to an associated PR; never follow SHAs/URLs
// suggested in mutable PR descriptions, comments or acceptance reports.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const REPO='BestNathan/nession';
const MAX_COMMITS=10;
const MAX_RUNS_PER_COMMIT=2;
const goodInt=n=>Number.isSafeInteger(n)&&n>0;

function recordFromApi(payload) {
  if (typeof payload?.content==='string' && payload.encoding==='base64') {
    if (payload.size>65536 || payload.content.length>100000) throw Error('E2E record exceeds evidence limit');
    return JSON.parse(Buffer.from(payload.content.replace(/\s/g,''),'base64').toString('utf8'));
  }
  // Pure fixture support; live GitHub contents API supplies base64.
  if (payload?.kind==='issue_e2e_run') return payload;
  throw Error('missing or invalid GitHub Run Record envelope');
}

export function verifyHistoricalE2ERun(run,record,prNumber) {
  if (!goodInt(prNumber) || !goodInt(run?.id) || !goodInt(run.run_attempt) ||
      !SHA.test(String(run.head_sha)) || run.path!=='.github/workflows/e2e-tests.yml' ||
      run.event!=='pull_request' || run.status!=='completed' ||
      !['success','failure'].includes(run.conclusion) ||
      run.repository?.full_name!==REPO || run.head_repository?.full_name!==REPO ||
      !run.pull_requests?.some(p=>p.number===prNumber)) throw Error('unrelated or untrusted E2E run');
  if (record?.schema_version!==1 || record.kind!=='issue_e2e_run' ||
      record.run_id!==run.id || record.run_attempt!==run.run_attempt ||
      record.target_sha!==run.head_sha || !DIGEST.test(record.plan_digest) ||
      !/^sha256:[a-f0-9]{64}$/.test(record.artifact_digest) ||
      !Array.isArray(record.results) || !record.results.length) throw Error('E2E Run Record provenance mismatch');
  const seen=new Set();
  const results=record.results.map(row=>{
    if(typeof row.id!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id)||
       seen.has(row.id)||!['Pass','Fail','Pending','Error'].includes(row.result)||
       !Number.isSafeInteger(row.discovered)||row.discovered<0||
       !Number.isSafeInteger(row.assertions)||row.assertions<0) throw Error('invalid or duplicated per-ID result');
    seen.add(row.id);
    if(row.result==='Pass'&&(
      !row.discovered||row.passed!==row.discovered||row.failed!==0||
      row.skipped!==0||row.flaky!==0||row.assertions===0))
      throw Error('unproven Pass in E2E record');
    return {id:row.id,result:row.result,discovered:row.discovered,
      passed:row.passed,failed:row.failed,assertions:row.assertions};
  });
  if (run.conclusion==='success' && results.some(r=>r.result!=='Pass'))
    throw Error('successful workflow has non-Pass selected E2E result');
  if (run.conclusion==='failure' && results.every(r=>r.result==='Pass'))
    throw Error('failed workflow has only Pass E2E results; cannot assign failure cause');
  return {run_id:run.id,run_attempt:run.run_attempt,head_sha:run.head_sha,
    conclusion:run.conclusion,run_url:run.html_url,
    plan_digest:record.plan_digest,artifact_digest:record.artifact_digest,
    provenance:'GitHub workflow_run + acceptance-results Run Record',
    results};
}

export function verifyHistoricalArtifact(run,record,metadata) {
  const matches=(metadata?.artifacts??[]).filter(x=>
    x.name==='issue-e2e-verification' && x.expired===false);
  if(matches.length!==1 || !goodInt(matches[0].id) ||
     matches[0].digest!==record.artifact_digest) {
    throw Error('source artifact digest does not authenticate orphan Run Record');
  }
  return matches[0].id;
}


// Historical Plan is read from the GitHub-uploaded artifact, not Issue prose.
// The main-owned ingest already attested this artifact and pinned its digest
// in the orphan Run Record; revalidate the immutable Plan shape and ownership.
export function verifyHistoricalPlan(run,record,plan,prNumber) {
  if (plan?.schema_version!==1 || plan.kind!=='issue_e2e_selection' ||
      plan.mode!=='selected' || plan.pr_number!==prNumber ||
      plan.target_sha!==run.head_sha || plan.plan_digest!==record.plan_digest ||
      !Array.isArray(plan.issues) || !Array.isArray(plan.selected) ||
      plan.selected.length!==record.results.length)
    throw Error('historical E2E Plan identity is not bound to its Run Record');
  const canonical={schema_version:plan.schema_version,kind:plan.kind,
    base_sha:plan.base_sha,target_sha:plan.target_sha,
    issues:plan.issues,selected:plan.selected,mode:plan.mode};
  const digest=createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  if(digest!==plan.plan_digest)throw Error('historical E2E Plan digest mismatch');
  const declared=new Set(),owners=new Set(plan.issues.map(x=>x.issue));
  if(owners.size!==plan.issues.length || !owners.size ||
     [...owners].some(x=>!goodInt(x)))throw Error('invalid historical Issue contract set');
  const selected=plan.selected.map(s=>{
    if(typeof s.id!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.id)||
       declared.has(s.id)||!Array.isArray(s.owners)||!s.owners.length)
      throw Error('duplicate/invalid E2E Plan ID');
    declared.add(s.id);
    const ownerIds=s.owners.map(o=>o.issue).sort((a,b)=>a-b);
    if(new Set(ownerIds).size!==ownerIds.length ||
       ownerIds.some(id=>!owners.has(id)))throw Error('invalid E2E Plan Issue attribution');
    return {id:s.id,owners:ownerIds};
  });
  if(record.results.some(r=>!declared.has(r.id)) ||
     new Set(record.results.map(r=>r.id)).size!==selected.length)
    throw Error('historical per-ID results differ from executed Selection Plan');
  return {selected,issue_numbers:[...owners].sort((a,b)=>a-b),
    digest:plan.plan_digest,source:'authenticated issue-e2e-verification artifact'};
}

async function readHistoricalPlanZip(repo,artifact) {
  if(repo!==REPO||!goodInt(artifact?.id)||
     !goodInt(artifact.size_in_bytes) || artifact.size_in_bytes>2*1024*1024)
    throw Error('untrusted/oversized historical assertion artifact');
  const token=process.env.GITHUB_TOKEN??process.env.GH_TOKEN;
  if(!token)throw Error('trusted GitHub token required to read artifact');
  const response=await fetch('https://api.github.com/repos/'+repo+
    '/actions/artifacts/'+artifact.id+'/zip',{
      headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'},
    });
  if(!response.ok)throw Error('historical E2E artifact download failed');
  const zipBytes=Buffer.from(await response.arrayBuffer());
  if(zipBytes.length>2*1024*1024)throw Error('historical E2E artifact exceeds size budget');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-issue-e2e-'));
  try {
    const zip=path.join(dir,'source.zip');
    fs.writeFileSync(zip,zipBytes,{flag:'wx'});
    const result=spawnSync('unzip',['-p',zip,'plan.json'],{
      encoding:'utf8',timeout:10000,maxBuffer:128*1024});
    if(result.error || result.status!==0 || !result.stdout)
      throw Error('historical E2E artifact has no bounded plan.json');
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

// The stale replay proof is the *failure of a privileged ingest attempt*,
// not a standalone assertion by an Agent or an Issue comment. Expose only the
// whitelisted assertion and two SHAs, never raw logs or PR-head content.
export function verifyStaleReplayLog(log,oldRun,newHead) {
  if(!goodInt(oldRun?.run_id)||!SHA.test(oldRun.head_sha)||
     !SHA.test(newHead)||oldRun.head_sha===newHead||
     typeof log!=='string'||log.length>2*1024*1024||
     !log.includes('run_id="'+oldRun.run_id+'"'))
    throw Error('stale replay has no authenticated source run binding');
  const assertion=log.match(/AssertionError \[ERR_ASSERTION\]: stale PR head[\s\S]{0,400}\+\s*'([a-f0-9]{40})'[\s\S]{0,300}-\s*'([a-f0-9]{40})'/);
  if(!assertion||assertion[1]!==newHead||assertion[2]!==oldRun.head_sha||
     !log.includes('at verifySource ('))
    throw Error('missing exact SHA stale replay rejection in trusted ingest logs');
  return {source_run_id:oldRun.run_id,stale_sha:oldRun.head_sha,
    current_sha:newHead,error:'stale PR head',verified_by:'trusted ingest-pr job log'};
}

async function readTrustedJobLog(repo,jobId) {
  const token=process.env.GITHUB_TOKEN??process.env.GH_TOKEN;
  const response=await fetch('https://api.github.com/repos/'+repo+
    '/actions/jobs/'+jobId+'/logs',{
      headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'},
    });
  if(!response.ok)throw Error('trusted ingest job log unavailable');
  const text=await response.text();
  if(text.length>2*1024*1024)throw Error('trusted ingest log size exceeded');
  return text;
}

async function findTrustedStaleReplay(repo,history,get,currentHead,readLog=readTrustedJobLog) {
  const corrected=history.filter(r=>r.head_sha===currentHead &&
    r.conclusion==='success' && r.results.length &&
    r.results.every(t=>t.result==='Pass')).at(-1);
  const former=history.filter(r=>r.conclusion==='failure' &&
    r.head_sha!==corrected?.head_sha);
  if(!corrected||!former.length)return [];
  const date=String(corrected.created_at??'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return [];
  const found=[];
  // Bounded query: three GitHub-owned pages on the correction date, never
  // search arbitrary Run IDs or links suggested by Issue/PR prose.
  for(let page=1;page<=3 && !found.length;page++){
    const payload=await get('/repos/'+repo+'/actions/runs?event=workflow_run&created='+
      date+'&per_page=100&page='+page);
    const candidates=(payload.workflow_runs??[]).filter(r=>
      r.name==='E2E / Test Ingest' &&
      r.path==='.github/workflows/e2e-test-ingest.yml' &&
      r.repository?.full_name===REPO && r.head_branch==='main' &&
      r.event==='workflow_run' &&
      r.conclusion==='failure' && r.status==='completed' &&
      goodInt(r.id) && goodInt(r.run_attempt) && r.run_attempt>1 &&
      String(r.updated_at??'')>=String(corrected.created_at??''));
    for(const ingest of candidates.slice(0,8)){
      const jobs=await get('/repos/'+repo+'/actions/runs/'+ingest.id+
        '/attempts/'+ingest.run_attempt+'/jobs?per_page=100');
      for(const job of (jobs.jobs??[]).filter(j=>
        j.name==='ingest-pr'&&j.conclusion==='failure'&&goodInt(j.id) &&
        j.steps?.some(s=>s.name==='Independently validate and project per-ID results' &&
          s.conclusion==='failure'))){
        let log;
        try { log=await readLog(repo,job.id); }
        catch { continue; } // Missing log is not positive stale-replay proof.
        for(const old of former) {
          try {
            const proof=verifyStaleReplayLog(log,old,corrected.head_sha);
            found.push({...proof,ingest_run_id:ingest.id,
              ingest_attempt:ingest.run_attempt,
              ingest_url:'https://github.com/'+repo+'/actions/runs/'+ingest.id});
            break;
          }catch {/* unrelated job is not trusted proof */}
        }
      }
      if(found.length)break;
    }
  }
  return found;
}

export async function collectHistoricalE2EForPull(repo,pull,get,readPlan=readHistoricalPlanZip,findReplay=findTrustedStaleReplay) {
  if (repo!==REPO || !goodInt(pull?.number) || !SHA.test(String(pull.head?.sha)))
    throw Error('historical E2E scope requires a trusted associated PR');
  const commits=await get('/repos/'+repo+'/pulls/'+pull.number+'/commits?per_page=100');
  const selected=(Array.isArray(commits)?commits:[]).slice(-MAX_COMMITS);
  if (!selected.some(x=>x.sha===pull.head.sha))
    throw Error('associated PR head is missing from commit history');
  const verified=[];
  for (const commit of selected) {
    const sha=commit.sha;
    if (!SHA.test(String(sha))) throw Error('untrusted commit SHA from GitHub API');
    const payload=await get('/repos/'+repo+'/actions/runs?head_sha='+sha+'&per_page=100');
    const runs=(payload.workflow_runs??[]).filter(r=>
      r.path==='.github/workflows/e2e-tests.yml'&&r.event==='pull_request'&&
      r.status==='completed'&&r.pull_requests?.some(p=>p.number===pull.number))
      .sort((a,b)=>Number(b.id)-Number(a.id))
      .slice(0,MAX_RUNS_PER_COMMIT);
    for (const run of runs) {
      const day=String(run.created_at||'').slice(0,10);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(day) || !goodInt(run.run_attempt))continue;
      const path='/repos/'+repo+'/contents/runs/'+day+'/'+run.id+'-'+run.run_attempt+
        '/test/issue-e2e.json?ref=acceptance-results';
      let payload;
      try {payload=await get(path);} catch(e) {
        if(/GitHub API 404\b/.test(String(e?.message)))continue;
        throw e;
      }
      // A record on the orphan store alone is not a proof: bind it to a
      // completed GitHub run, its PR association, exact SHA and attempt.
      const record=recordFromApi(payload);
      const artifactMetadata=await get('/repos/'+repo+'/actions/runs/'+run.id+'/artifacts?per_page=100');
      const artifactId=verifyHistoricalArtifact(run,record,artifactMetadata);
      const artifact=artifactMetadata.artifacts.find(a=>a.id===artifactId);
      const plan=await readPlan(repo,artifact);
      const selection=verifyHistoricalPlan(run,record,plan,pull.number);
      verified.push({...verifyHistoricalE2ERun(run,record,pull.number),
        artifact_id:artifactId,created_at:run.created_at,selection});
    }
  }
  verified.sort((a,b)=>a.run_id-b.run_id||a.run_attempt-b.run_attempt);
  const stale_replays=await findReplay(repo,verified,get,pull.head.sha);
  return verified.map(row=>({...row,stale_replays:
    stale_replays.filter(x=>x.source_run_id===row.run_id)}));
}

async function selfTest() {
  const pr={number:1718,head:{sha:'b'.repeat(40)}},a='a'.repeat(40),b='b'.repeat(40);
  const run=(id,sha,conclusion)=>({
    id,run_attempt:1,head_sha:sha,created_at:'2026-10-14T01:00:00Z',
    path:'.github/workflows/e2e-tests.yml',event:'pull_request',status:'completed',
    conclusion,repository:{full_name:REPO},head_repository:{full_name:REPO},
    pull_requests:[{number:1718}],html_url:'https://github.com/BestNathan/nession/actions/runs/'+id,
  });
  const fixturePlan=(run)=>{
    const canonical={schema_version:1,kind:'issue_e2e_selection',
      base_sha:'0'.repeat(40),target_sha:run.head_sha,
      issues:[{issue:1702}],selected:[{id:'login',owners:[{issue:1702}]}],
      mode:'selected'};
    return {...canonical,plan_digest:createHash('sha256')
      .update(JSON.stringify(canonical)).digest('hex')};
  };
  const rec=(run,result)=>({schema_version:1,kind:'issue_e2e_run',
    run_id:run.id,run_attempt:1,target_sha:run.head_sha,
    plan_digest:fixturePlan(run).plan_digest,artifact_digest:'sha256:'+'d'.repeat(64),
    results:[{id:'login',result,discovered:1,
      passed:result==='Pass'?1:0,failed:result==='Fail'?1:0,skipped:0,flaky:0,assertions:2}]});
  const old=run(10,a,'failure'),current=run(20,b,'success');
  const map=new Map([
    ['/repos/'+REPO+'/pulls/1718/commits?per_page=100',[{sha:a},{sha:b}]],
    ['/repos/'+REPO+'/actions/runs?head_sha='+a+'&per_page=100',{workflow_runs:[old]}],
    ['/repos/'+REPO+'/actions/runs?head_sha='+b+'&per_page=100',{workflow_runs:[current]}],
    ['/repos/'+REPO+'/contents/runs/2026-10-14/10-1/test/issue-e2e.json?ref=acceptance-results',
      {encoding:'base64',content:Buffer.from(JSON.stringify(rec(old,'Fail'))).toString('base64')}],
    ['/repos/'+REPO+'/contents/runs/2026-10-14/20-1/test/issue-e2e.json?ref=acceptance-results',
      {encoding:'base64',content:Buffer.from(JSON.stringify(rec(current,'Pass'))).toString('base64')}],
    ['/repos/'+REPO+'/actions/runs/10/artifacts?per_page=100',{artifacts:[{
      name:'issue-e2e-verification',expired:false,id:101,
      digest:rec(old,'Fail').artifact_digest}]}],
    ['/repos/'+REPO+'/actions/runs/20/artifacts?per_page=100',{artifacts:[{
      name:'issue-e2e-verification',expired:false,id:202,
      digest:rec(current,'Pass').artifact_digest}]}],
  ]);
  const get=async path=>{if(!map.has(path))throw Error('unexpected request '+path);return map.get(path)};
  const readPlan=async(_repo,artifact)=>fixturePlan(artifact.id===101?old:current);
  const found=await collectHistoricalE2EForPull(REPO,pr,get,readPlan,async()=>[]);
  assert.deepEqual(found.map(r=>[r.run_id,r.results[0].result]),[[10,'Fail'],[20,'Pass']]);
  assert.deepEqual(found.map(x=>x.artifact_id),[101,202]);
  assert.deepEqual(found.map(x=>x.selection.selected),
    [[{id:'login',owners:[1702]}],[{id:'login',owners:[1702]}]]);
  assert.throws(()=>verifyHistoricalPlan(old,rec(old,'Fail'),{
    ...fixturePlan(old),target_sha:current.head_sha},1718),/identity/);
  assert.throws(()=>verifyHistoricalPlan(old,rec(old,'Fail'),{
    ...fixturePlan(old),selected:[{id:'login',owners:[{issue:9999}]}]},1718),/digest/);
  const log='run_id="10"\nAssertionError [ERR_ASSERTION]: stale PR head\n'+
    "+ 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'\n"+
    "- 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\n"+
    'at verifySource (verified source)';
  assert.equal(verifyStaleReplayLog(log,{
    run_id:10,head_sha:a},b).error,'stale PR head');
  assert.throws(()=>verifyStaleReplayLog(log,{run_id:11,head_sha:a},b),/binding/);
  assert.throws(()=>verifyStaleReplayLog(log,{run_id:10,head_sha:b},a),/rejection/);

  const replayGet=async request=>{
    if(request.includes('/attempts/2/jobs?per_page=100'))return {jobs:[{
      id:777,name:'ingest-pr',conclusion:'failure',
      steps:[{name:'Independently validate and project per-ID results',conclusion:'failure'}],
    }]};
    return {workflow_runs:request.endsWith('&page=1')?[{
      id:90,name:'E2E / Test Ingest',path:'.github/workflows/e2e-test-ingest.yml',
      repository:{full_name:REPO},head_branch:'main',event:'workflow_run',
      status:'completed',conclusion:'failure',run_attempt:2,
      updated_at:'2026-10-14T02:00:00Z',
    }]:[]};
  };
  const replay=await findTrustedStaleReplay(REPO,[
    {...verifyHistoricalE2ERun(old,rec(old,'Fail'),1718),created_at:old.created_at},
    {...verifyHistoricalE2ERun(current,rec(current,'Pass'),1718),created_at:current.created_at},
  ],replayGet,b,async()=>log);
  assert.equal(replay[0].source_run_id,10);
  assert.equal(replay[0].ingest_run_id,90);
  assert.deepEqual(await findTrustedStaleReplay(REPO,[
    {...verifyHistoricalE2ERun(old,rec(old,'Fail'),1718),created_at:old.created_at},
    {...verifyHistoricalE2ERun(current,rec(current,'Pass'),1718),created_at:current.created_at},
  ],replayGet,'e'.repeat(40),async()=>log),[]);

  assert.throws(()=>verifyHistoricalArtifact(current,rec(current,'Pass'),{
    artifacts:[{name:'issue-e2e-verification',expired:false,id:202,digest:'sha256:'+'0'.repeat(64)}],
  }),/source artifact digest/);
  assert.throws(()=>verifyHistoricalE2ERun({...old,head_sha:b},rec(old,'Fail'),1718),/provenance/);
  assert.throws(()=>verifyHistoricalE2ERun({...old,pull_requests:[{number:1719}]},rec(old,'Fail'),1718),/untrusted/);
  assert.throws(()=>verifyHistoricalE2ERun(current,rec(current,'Fail'),1718),/non-Pass/);
  assert.throws(()=>verifyHistoricalE2ERun(old,rec(old,'Pass'),1718),/only Pass/);
  assert.throws(()=>verifyHistoricalE2ERun(old,{...rec(old,'Fail'),run_id:99},1718),/provenance/);
  assert.throws(()=>verifyHistoricalE2ERun(current,{...rec(current,'Pass'),results:[{
    ...rec(current,'Pass').results[0],assertions:0}]},1718),/unproven Pass/);
  console.log('Acceptance historical Issue E2E evidence: bounded PR commit/run lineage and negative provenance fixtures passed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'self-test') await selfTest();
  else throw Error('usage: acceptance-e2e-lineage.mjs self-test');
}
