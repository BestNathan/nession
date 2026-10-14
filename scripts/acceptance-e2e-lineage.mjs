// GitHub-owned historical E2E evidence for read-only Issue Acceptance.
// Scope: commits that belong to an associated PR; never follow SHAs/URLs
// suggested in mutable PR descriptions, comments or acceptance reports.
import assert from 'node:assert/strict';
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

export async function collectHistoricalE2EForPull(repo,pull,get) {
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
      verified.push({...verifyHistoricalE2ERun(run,record,pull.number),artifact_id:artifactId});
    }
  }
  return verified.sort((a,b)=>a.run_id-b.run_id||a.run_attempt-b.run_attempt);
}

async function selfTest() {
  const pr={number:1718,head:{sha:'b'.repeat(40)}},a='a'.repeat(40),b='b'.repeat(40);
  const run=(id,sha,conclusion)=>({
    id,run_attempt:1,head_sha:sha,created_at:'2026-10-14T01:00:00Z',
    path:'.github/workflows/e2e-tests.yml',event:'pull_request',status:'completed',
    conclusion,repository:{full_name:REPO},head_repository:{full_name:REPO},
    pull_requests:[{number:1718}],html_url:'https://github.com/BestNathan/nession/actions/runs/'+id,
  });
  const rec=(run,result)=>({schema_version:1,kind:'issue_e2e_run',
    run_id:run.id,run_attempt:1,target_sha:run.head_sha,
    plan_digest:'c'.repeat(64),artifact_digest:'sha256:'+'d'.repeat(64),
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
  const found=await collectHistoricalE2EForPull(REPO,pr,get);
  assert.deepEqual(found.map(r=>[r.run_id,r.results[0].result]),[[10,'Fail'],[20,'Pass']]);
  assert.deepEqual(found.map(x=>x.artifact_id),[101,202]);
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
