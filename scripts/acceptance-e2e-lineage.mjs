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
import { verifyStoredProjectionReceipt } from './issue-e2e-projection-receipt.mjs';

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

// GitHub may erase workflow_run.pull_requests after a PR is merged.
// The immutable commit SHA's GitHub Commit→PR association is the bounded
// fallback. Both the PR head identity and same-repository merge are required;
// the Run Record and Selection Plan are still verified independently.
export function verifiedCommitPullAssociation(pulls,prNumber,expectedHeadSha) {
  return SHA.test(String(expectedHeadSha??'')) && Array.isArray(pulls) &&
    pulls.some(pr=>pr.number===prNumber && pr.state==='closed' &&
      Boolean(pr.merged_at) && pr.head?.sha===expectedHeadSha &&
      pr.head?.repo?.full_name===REPO && pr.base?.repo?.full_name===REPO);
}

export function verifyHistoricalE2ERun(run,record,prNumber,commitPulls=[],prHeadSha=null) {
  if (!goodInt(prNumber) || !goodInt(run?.id) || !goodInt(run.run_attempt) ||
      !SHA.test(String(run.head_sha)) || run.path!=='.github/workflows/e2e-tests.yml' ||
      run.event!=='pull_request' || run.status!=='completed' ||
      !['success','failure'].includes(run.conclusion) ||
      run.repository?.full_name!==REPO || run.head_repository?.full_name!==REPO ||
      !(run.pull_requests?.some(p=>p.number===prNumber) ||
        verifiedCommitPullAssociation(commitPulls,prNumber,prHeadSha)))
    throw Error('unrelated or untrusted E2E run');
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

// Verify actual trusted GitHub Issue mutations, distinct from the prior
// Playwright source Run Record. Absence is not proof of non-projection for
// legacy runs, but cannot be claimed as a positive historical receipt.
export async function collectHistoricalProjectionReceipts(repo,run,record,selection,get){
  if(repo!==REPO||!goodInt(run?.id)||!goodInt(run.run_attempt)||
     !/^\d{4}-\d{2}-\d{2}$/.test(String(run.created_at??'').slice(0,10))||
     !Array.isArray(selection?.issue_numbers)||selection.issue_numbers.length>10)
    throw Error('invalid bounded historical projection discovery');
  const day=String(run.created_at).slice(0,10);
  const results=[];
  for(const number of selection.issue_numbers){
    if(!goodInt(number))throw Error('invalid projection Issue number');
    const root='/repos/'+repo+'/contents/runs/'+day+'/'+run.id+'-'+run.run_attempt+
      '/test/';
    let intent,receipt;
    try{
      intent=recordFromApiKind(await get(root+'projection-intents/'+number+'.json?ref=acceptance-results'),
        'issue_e2e_projection_intent');
      receipt=recordFromApiKind(await get(root+'projection-receipts/'+number+'.json?ref=acceptance-results'),
        'issue_e2e_projection_receipt');
    }catch(error){
      if(/GitHub API 404\b/.test(String(error?.message)))continue;
      throw error;
    }
    results.push(verifyStoredProjectionReceipt(record,intent,receipt,number));
  }
  return results;
}
function recordFromApiKind(payload,kind){
  if(typeof payload?.content==='string'&&payload.encoding==='base64'){
    if(payload.size>65536||payload.content.length>100000)
      throw Error('historical projection exceeds bounded JSON size');
    const item=JSON.parse(Buffer.from(payload.content.replace(/\s/g,''),'base64').toString('utf8'));
    if(item?.kind!==kind)throw Error('wrong historical projection record kind');
    return item;
  }
  if(payload?.kind===kind)return payload; // pure self-test
  throw Error('missing historical projection Run Store envelope');
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
    const candidates=(payload.workflow_runs??[]).filter(r=>
      r.path==='.github/workflows/e2e-tests.yml'&&r.event==='pull_request'&&
      r.status==='completed'&&r.head_sha===sha);
    // The source run's mutable PR association list is not stable after merge.
    // Ask GitHub which PR owns the exact commit, and require a matching merged
    // same-repo PR head before considering runs with an empty association list.
    const needsFallback=candidates.some(r=>
      !r.pull_requests?.some(p=>p.number===pull.number));
    const commitPulls=needsFallback
      ? await get('/repos/'+repo+'/commits/'+sha+'/pulls?per_page=100')
      : [];
    const commitLinked=verifiedCommitPullAssociation(
      commitPulls,pull.number,pull.head.sha);
    const runs=candidates.filter(r=>
      r.pull_requests?.some(p=>p.number===pull.number)||commitLinked)
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
      const projection_receipts=await collectHistoricalProjectionReceipts(
        repo,run,record,selection,get);
      verified.push({...verifyHistoricalE2ERun(run,record,pull.number,commitPulls,pull.head.sha),
        artifact_id:artifactId,created_at:run.created_at,selection,projection_receipts});
    }
  }
  verified.sort((a,b)=>a.run_id-b.run_id||a.run_attempt-b.run_attempt);
  const stale_replays=await findReplay(repo,verified,get,pull.head.sha);
  return verified.map(row=>({...row,stale_replays:
    stale_replays.filter(x=>x.source_run_id===row.run_id)}));
}


// For a post-merge requirement, its live E2E experiment may have been on an
// earlier staging PR. Find candidates from *GitHub's Issue cross-reference
// timeline*, never from editable evidence comments or arbitrary SHA/URL text.
// The PR's own explicit multi-Issue Refs are only a discovery constraint:
// each returned verdict is independently re-attested from the orphan Run
// Record, GitHub source run, and immutable Selection Plan artifact.
const MAX_TIMELINE_PAGES = 3;
const MAX_LINKED_PRS = 4;
export function selectCrossReferencedE2EPulls(repo, issueNumber, events, pulls) {
  if (repo!==REPO || !goodInt(issueNumber) || !Array.isArray(events) ||
      !Array.isArray(pulls))throw Error('untrusted Issue/PR discovery input');
  const known=new Set();
  for(const event of events){
    const source=event?.source?.issue;
    const n=source?.number;
    if(event?.event==='cross-referenced' && goodInt(n) &&
       source?.pull_request?.url===
         'https://api.github.com/repos/'+repo+'/pulls/'+n)known.add(n);
  }
  return pulls.filter(pr=>{
    if(!known.has(pr?.number)||pr?.state!=='closed'||!pr.merged_at||
       pr?.base?.ref!=='staging'||pr?.base?.repo?.full_name!==repo||
       pr?.head?.repo?.full_name!==repo||!SHA.test(pr?.head?.sha??'')||
       !SHA.test(pr?.merge_commit_sha??''))return false;
    const refs=new Set();
    for(const line of String(pr.body??'').split(/\r?\n/)){
      const match=line.match(/^\s*Refs?\s*:?\s*(.*)$/i);
      if(match)for(const hit of match[1].matchAll(/#([1-9]\d*)\b/g))
        refs.add(Number(hit[1]));
    }
    return refs.has(issueNumber)&&refs.size>=2;
  }).sort((a,b)=>a.number-b.number).slice(-MAX_LINKED_PRS);
}

export function verifyHistoricalStagingFullRun(repo,mergeSha,runs,artifacts) {
  if(repo!==REPO||!SHA.test(mergeSha))throw Error('invalid staging source SHA');
  const full=(Array.isArray(runs)?runs:[]).filter(run=>
    run.path==='.github/workflows/e2e-tests.yml'&&
    run.name==='E2E / Tests'&&run.event==='push'&&
    run.head_branch==='staging'&&run.head_sha===mergeSha&&
    run.repository?.full_name===repo&&
    run.status==='completed'&&run.conclusion==='success'&&
    goodInt(run.id)&&goodInt(run.run_attempt));
  if(!full.length)return null;
  const run=full.sort((a,b)=>b.id-a.id)[0];
  const matches=(artifacts?.artifacts??[]).filter(a=>
    a.name==='playwright-report' && a.expired===false &&
    goodInt(a.id)&&/^sha256:[a-f0-9]{64}$/.test(a.digest));
  if(matches.length!==1)return null;
  return {scope:'full',branch:'staging',target_sha:mergeSha,
    run_id:run.id,run_attempt:run.run_attempt,
    conclusion:'success',url:run.html_url,
    artifact_id:matches[0].id,artifact_digest:matches[0].digest,
    provenance:'GitHub push workflow + Playwright full-suite artifact'};
}

export async function collectLinkedIssueE2EEvidence(repo,issueNumber,get,
  collectPr=collectHistoricalE2EForPull) {
  if(repo!==REPO||!goodInt(issueNumber))return [];
  const events=[];
  for(let page=1;page<=MAX_TIMELINE_PAGES;page++){
    const items=await get('/repos/'+repo+'/issues/'+issueNumber+
      '/timeline?per_page=100&page='+page);
    if(!Array.isArray(items))throw Error('GitHub timeline is not an array');
    events.push(...items);
    if(items.length<100)break;
  }
  const numbers=[...new Set(events.filter(x=>
    x.event==='cross-referenced'&&goodInt(x.source?.issue?.number)&&
    x.source.issue.pull_request?.url===
      'https://api.github.com/repos/'+repo+'/pulls/'+x.source.issue.number)
    .map(x=>x.source.issue.number))];
  if(numbers.length>40)throw Error('excessive linked PR discovery scope');
  const pulls=await Promise.all(numbers.map(number=>
    get('/repos/'+repo+'/pulls/'+number)));
  const selected=selectCrossReferencedE2EPulls(repo,issueNumber,events,pulls);
  const proofs=[];
  for(const pr of selected){
    const history=await collectPr(repo,pr,get);
    // PR prose is never authoritative. Require the authenticated Plan's
    // own Issue contracts and per-ID owners to include this requirement
    // alongside a second Issue, and every surfaced source run to match.
    const proven=history.filter(row=>
      row.selection?.issue_numbers?.includes(issueNumber) &&
      row.selection.issue_numbers.length>=2 &&
      row.selection.selected?.some(item=>
        item.owners?.includes(issueNumber)&&item.owners.length>=2));
    if(!proven.length)continue;
    const payload=await get('/repos/'+repo+'/actions/runs?head_sha='+
      pr.merge_commit_sha+'&per_page=100');
    const completed=(payload?.workflow_runs??[]).filter(run=>
      run.name==='E2E / Tests'&&run.path==='.github/workflows/e2e-tests.yml'&&
      run.event==='push'&&run.head_branch==='staging'&&
      run.head_sha===pr.merge_commit_sha&&run.repository?.full_name===repo&&
      run.status==='completed'&&run.conclusion==='success')
      .sort((a,b)=>b.id-a.id);
    const artifact=completed.length?await get('/repos/'+repo+
      '/actions/runs/'+completed[0].id+'/artifacts?per_page=100'):{artifacts:[]};
    proofs.push({pr_number:pr.number,pr_head_sha:pr.head.sha,
      staging_merge_sha:pr.merge_commit_sha,
      source:'GitHub Issue cross-reference + exact PR identity',
      verified_selected_runs:proven,
      verified_staging_full:verifyHistoricalStagingFullRun(repo,
        pr.merge_commit_sha,payload?.workflow_runs,artifact)});
  }
  return proofs;
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
  const get=async path=>{
    if(/\/projection-(?:intents|receipts)\//.test(path))
      throw Error('GitHub API 404 missing historical projection');
    if(!map.has(path))throw Error('unexpected request '+path);
    return map.get(path);
  };
  const readPlan=async(_repo,artifact)=>fixturePlan(artifact.id===101?old:current);
  const found=await collectHistoricalE2EForPull(REPO,pr,get,readPlan,async()=>[]);
  assert.deepEqual(found.map(r=>[r.run_id,r.results[0].result]),[[10,'Fail'],[20,'Pass']]);
  assert.deepEqual(found.map(x=>x.artifact_id),[101,202]);
  assert.deepEqual(found.map(x=>x.projection_receipts),[[],[]]);
  assert.throws(()=>verifyStoredProjectionReceipt(rec(old,'Fail'),{kind:'forged'},{
    kind:'issue_e2e_projection_receipt'},1702),/historical projection intent/);
  assert.deepEqual(found.map(x=>x.selection.selected),
    [[{id:'login',owners:[1702]}],[{id:'login',owners:[1702]}]]);
  // GitHub can return pull_requests:[] for runs after their PR was merged.
  // Verify membership from its commit-to-PR endpoint, never from PR prose.
  const mergedPr={number:1718,state:'closed',merged_at:'2026-10-14T05:09:42Z',
    head:{sha:b,repo:{full_name:REPO}},base:{repo:{full_name:REPO}}};
  const mergedOld={...old,pull_requests:[]},mergedCurrent={...current,pull_requests:[]};
  const mergedMap=new Map(map);
  mergedMap.set('/repos/'+REPO+'/actions/runs?head_sha='+a+'&per_page=100',
    {workflow_runs:[mergedOld]});
  mergedMap.set('/repos/'+REPO+'/actions/runs?head_sha='+b+'&per_page=100',
    {workflow_runs:[mergedCurrent]});
  mergedMap.set('/repos/'+REPO+'/commits/'+a+'/pulls?per_page=100',[mergedPr]);
  mergedMap.set('/repos/'+REPO+'/commits/'+b+'/pulls?per_page=100',[mergedPr]);
  const mergedGet=async p=>{
    if(/\/projection-(?:intents|receipts)\//.test(p))
      throw Error('GitHub API 404 missing historical projection');
    if(!mergedMap.has(p))throw Error('unexpected request '+p);
    return mergedMap.get(p)};
  const mergedHistory=await collectHistoricalE2EForPull(REPO,pr,mergedGet,readPlan,async()=>[]);
  assert.deepEqual(mergedHistory.map(row=>[row.run_id,row.results[0].result]),
    [[10,'Fail'],[20,'Pass']]);
  assert.throws(()=>verifyHistoricalE2ERun(mergedOld,rec(old,'Fail'),1718,[],b),
    /unrelated or untrusted/);
  assert.deepEqual(verifyHistoricalE2ERun(mergedOld,rec(old,'Fail'),1718,
    [mergedPr],b).results.map(row=>row.result),['Fail']);
  assert.equal(verifiedCommitPullAssociation([{...mergedPr,number:1719}],1718,b),false);
  assert.equal(verifiedCommitPullAssociation([{...mergedPr,merged_at:null}],1718,b),false);
  assert.equal(verifiedCommitPullAssociation([{...mergedPr,head:{sha:a,repo:{full_name:REPO}}}],1718,b),false);
  assert.equal(verifiedCommitPullAssociation([{...mergedPr,base:{repo:{full_name:'foreign/repo'}}}],1718,b),false);
  assert.equal(verifiedCommitPullAssociation([{...mergedPr,head:{sha:b,repo:{full_name:'foreign/repo'}}}],1718,b),false);
  const forgedMap=new Map(mergedMap);
  forgedMap.set('/repos/'+REPO+'/commits/'+a+'/pulls?per_page=100',
    [{...mergedPr,number:1719}]);
  forgedMap.set('/repos/'+REPO+'/commits/'+b+'/pulls?per_page=100',
    [{...mergedPr,number:1719}]);
  const forgedGet=async p=>{
    if(/\/projection-(?:intents|receipts)\//.test(p))
      throw Error('GitHub API 404 missing historical projection');
    if(!forgedMap.has(p))throw Error('unexpected request '+p);
    return forgedMap.get(p)};
  assert.deepEqual(await collectHistoricalE2EForPull(REPO,pr,forgedGet,readPlan,async()=>[]),[]);
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

  const mergeSha='c'.repeat(40);
  const sourceUrl='https://api.github.com/repos/'+REPO+'/pulls/1718';
  const timeline=[{event:'cross-referenced',source:{issue:{number:1718,
    pull_request:{url:sourceUrl}}}}];
  const linked={number:1718,state:'closed',merged_at:'2026-10-14T05:00:00Z',
    base:{ref:'staging',repo:{full_name:REPO}},
    head:{sha:b,repo:{full_name:REPO}},merge_commit_sha:mergeSha,
    body:'Refs #1702\nRefs #1717'};
  assert.deepEqual(selectCrossReferencedE2EPulls(REPO,1702,timeline,[linked])
    .map(pr=>pr.number),[1718]);
  assert.deepEqual(selectCrossReferencedE2EPulls(REPO,1702,timeline,[{
    ...linked,body:'Refs #1702'}]),[]);
  assert.deepEqual(selectCrossReferencedE2EPulls(REPO,1702,[{
    event:'cross-referenced',source:{issue:{number:1718,
      pull_request:{url:'https://api.github.com/repos/other/repo/pulls/1718'}}}
  }],[linked]),[]);
  assert.deepEqual(selectCrossReferencedE2EPulls(REPO,1702,timeline,[{
    ...linked,head:{sha:b,repo:{full_name:'foreign/repo'}}}]),[]);
  const full={id:991,run_attempt:1,name:'E2E / Tests',
    path:'.github/workflows/e2e-tests.yml',event:'push',head_branch:'staging',
    head_sha:mergeSha,repository:{full_name:REPO},status:'completed',
    conclusion:'success',html_url:'https://github.com/'+REPO+'/actions/runs/991'};
  const fullArtifacts={artifacts:[{id:123,name:'playwright-report',
    expired:false,digest:'sha256:'+'e'.repeat(64)}]};
  assert.equal(verifyHistoricalStagingFullRun(REPO,mergeSha,[full],fullArtifacts).scope,'full');
  assert.equal(verifyHistoricalStagingFullRun(REPO,mergeSha,[{
    ...full,head_sha:a}],fullArtifacts),null);
  assert.equal(verifyHistoricalStagingFullRun(REPO,mergeSha,[full],{artifacts:[{
    ...fullArtifacts.artifacts[0],digest:'invalid'}]}),null);
  const linkedGet=async url=>{
    if(url.includes('/issues/1702/timeline?'))return timeline;
    if(url.endsWith('/pulls/1718'))return linked;
    if(url.includes('/actions/runs?head_sha='+mergeSha))return {workflow_runs:[full]};
    if(url.endsWith('/actions/runs/991/artifacts?per_page=100'))return fullArtifacts;
    throw Error('unexpected cross-Issue discovery API '+url);
  };
  const linkedProof=await collectLinkedIssueE2EEvidence(REPO,1702,
    linkedGet,async()=>[{run_id:10,selection:{
      issue_numbers:[1702,1717],selected:[{
        id:'login',owners:[1702,1717]}]},
      results:[{id:'login',result:'Fail'}]}]);
  assert.deepEqual(linkedProof.map(x=>x.pr_number),[1718]);
  assert.equal(linkedProof[0].verified_staging_full.run_id,991);
  assert.deepEqual(await collectLinkedIssueE2EEvidence(REPO,1702,
    linkedGet,async()=>[{run_id:10,selection:{
      issue_numbers:[999,1717],selected:[{id:'login',owners:[999,1717]}]},
      results:[{id:'login',result:'Pass'}]}]),[]);
  assert.deepEqual(await collectLinkedIssueE2EEvidence(REPO,1702,async url=>{
    if(url.includes('/timeline?'))return [];
    throw Error('should not fetch unlinked Pull Request');
  }),[]);

  console.log('Acceptance historical Issue E2E evidence: bounded PR commit/run lineage and negative provenance fixtures passed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'self-test') await selfTest();
  else throw Error('usage: acceptance-e2e-lineage.mjs self-test');
}
