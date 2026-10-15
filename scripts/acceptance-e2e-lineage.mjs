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
import { createProjectionReceipt, verifyArchivedProjectionReceipt } from './issue-e2e-projection-receipt.mjs';
import { parseIssueE2E } from './issue-e2e-contract.mjs';

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
export function verifiedCommitPullAssociation(pulls,prNumber,expectedHeadSha,allowTestOnly=false) {
  return SHA.test(String(expectedHeadSha??'')) && Array.isArray(pulls) &&
    pulls.some(pr=>pr.number===prNumber &&
      (pr.state==='closed'||(allowTestOnly&&pr.state==='open')) &&
      (Boolean(pr.merged_at)||(allowTestOnly&&pr.merged_at==null)) &&
      pr.head?.sha===expectedHeadSha &&
      pr.head?.repo?.full_name===REPO && pr.base?.repo?.full_name===REPO);
}

export function verifyHistoricalE2ERun(run,record,prNumber,commitPulls=[],prHeadSha=null,allowTestOnly=false,verifiedPrCommits=[],verifiedReceipts=[]) {
  // GitHub may clear both associations after a test-only PR closes unmerged.
  // Source membership then requires GitHub's own PR Commit list AND a
  // separately authenticated successful Issue PATCH/read-back receipt.
  const drillLinked=allowTestOnly&&Array.isArray(verifiedPrCommits)&&
    verifiedPrCommits.some(c=>c?.sha===run?.head_sha)&&
    Array.isArray(verifiedReceipts)&&verifiedReceipts.some(r=>
      r.outcome==='applied'&&r.run_id===run.id&&
      r.run_attempt===run.run_attempt&&r.target_sha===run.head_sha);
  if (!goodInt(prNumber) || !goodInt(run?.id) || !goodInt(run.run_attempt) ||
      !SHA.test(String(run.head_sha)) || run.path!=='.github/workflows/e2e-tests.yml' ||
      run.event!=='pull_request' || run.status!=='completed' ||
      !['success','failure'].includes(run.conclusion) ||
      run.repository?.full_name!==REPO || run.head_repository?.full_name!==REPO ||
      !(run.pull_requests?.some(p=>p.number===prNumber) ||
        verifiedCommitPullAssociation(commitPulls,prNumber,prHeadSha,allowTestOnly)||drillLinked))
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
  const noE2E=plan.issues.filter(info=>info.no_e2e===true);
  for(const info of noE2E){
    if((info.new_ids?.length??0)!==0 || (info.regression_ids?.length??0)!==0 ||
       selected.some(row=>row.owners.includes(info.issue)))
      throw Error('nonempty selected ownership under authenticated no_e2e Issue');
  }
  return {selected,issue_numbers:[...owners].sort((a,b)=>a-b),
    no_e2e_issues:noE2E.map(info=>info.issue).sort((a,b)=>a-b),
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

// Evidence of a mutable GitHub Issue PATCH cannot be inferred from an E2E
// result alone. Only receipts written by the trusted main ingest AFTER
// PATCH+independent Issue GET qualify as historically applied.
export async function collectAuthenticatedProjectionReceipts(repo,run,record,plan,get){
  if(repo!==REPO||!goodInt(run?.id)||!goodInt(run.run_attempt)||
     !/^\d{4}-\d{2}-\d{2}$/.test(String(run.created_at??'').slice(0,10)))
    throw Error('invalid historical projection source');
  const day=run.created_at.slice(0,10),proofs=[];
  for(const owner of plan.issues){
    const receiptPath='/repos/'+repo+'/contents/runs/'+day+'/'+run.id+'-'+run.run_attempt+
      '/test/projections/'+owner.issue+'.json?ref=acceptance-results';
    let payload;
    try{payload=await get(receiptPath);}
    catch(e){if(/GitHub API 404\b/.test(String(e?.message)))continue;throw e;}
    if(payload?.encoding!=='base64'||typeof payload.content!=='string'||
       !Number.isSafeInteger(payload.size)||payload.size>131072)
      throw Error('invalid trusted projection receipt envelope');
    const receipt=JSON.parse(Buffer.from(payload.content.replace(/\s/g,''),'base64').toString('utf8'));
    const verified=verifyArchivedProjectionReceipt(receipt,record,plan,owner.issue);
    const ingest=await get('/repos/'+repo+'/actions/runs/'+verified.ingest_run_id);
    if(ingest?.id!==verified.ingest_run_id||
       ingest.run_attempt!==verified.ingest_attempt||
       ingest.repository?.full_name!==repo||
       ingest.path!=='.github/workflows/e2e-test-ingest.yml'||
       ingest.name!=='E2E / Test Ingest'||ingest.event!=='workflow_run'||
       ingest.head_branch!=='main'||ingest.status!=='completed'||
       String(ingest.created_at??'')<String(run.created_at??''))
      throw Error('projection receipt issued by unrelated or untrusted ingest');
    // A protected receipt can be durably pushed even when a later step in the
    // same Ingest job fails (e.g. while reconciling another Issue). Do not
    // re-label this incomplete run as a SUCCESSFUL Issue projection. Preserve
    // its immutable record, but exclude it from positive Acceptance evidence.
    // The receipt itself was verified above, so forged receipts still fail.
    if(ingest.conclusion==='failure')continue;
    if(ingest.conclusion!=='success')
      throw Error('projection receipt has non-final trusted ingest status');
    const jobs=await get('/repos/'+repo+'/actions/runs/'+ingest.id+
      '/attempts/'+ingest.run_attempt+'/jobs?per_page=100');
    if(!(jobs.jobs??[]).some(j=>j.name==='ingest-pr' &&
       j.status==='completed'&&j.conclusion==='success'&&
       j.steps?.some(step=>step.name==='Store immutable results and update Issue reports' &&
         step.conclusion==='success')))
      throw Error('no trusted completed Issue projection step for receipt');
    proofs.push({...verified,source_run_url:run.html_url,
      ingest_url:ingest.html_url,
      provenance:'authenticated main ingest + immutable post-PATCH Issue readback receipt'});
  }
  return proofs;
}

export async function collectHistoricalE2EForPull(repo,pull,get,readPlan=readHistoricalPlanZip,findReplay=findTrustedStaleReplay,loadReceipts=collectAuthenticatedProjectionReceipts) {
  if (repo!==REPO || !goodInt(pull?.number) || !SHA.test(String(pull.head?.sha)))
    throw Error('historical E2E scope requires a trusted associated PR');
  const commits=await get('/repos/'+repo+'/pulls/'+pull.number+'/commits?per_page=100');
  const selected=(Array.isArray(commits)?commits:[]).slice(-MAX_COMMITS);
  if (!selected.some(x=>x.sha===pull.head.sha))
    throw Error('associated PR head is missing from commit history');
  const testDrill=pull.state==='closed'&&!pull.merged_at&&
    pull.head?.repo?.full_name===REPO&&pull.base?.repo?.full_name===REPO&&
    /DO NOT MERGE/i.test(String(pull.title??''))&&
    /DO NOT MERGE/i.test(String(pull.body??''));
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
      commitPulls,pull.number,pull.head.sha,!pull.merged_at);
    const runs=candidates.filter(r=>
      r.pull_requests?.some(p=>p.number===pull.number)||commitLinked||testDrill)
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
      const projections=await loadReceipts(repo,run,record,plan,get);
      // Older test-only drills may have executed before durable Issue PATCH
      // receipts existed. A source Run/Plan alone proves TEST execution, not
      // an Issue mutation. Do not surface it as a historical projection, and
      // do not let it block independently attested later drills.
      //
      // A present but forged/invalid receipt is never ignored: loadReceipts
      // verifies it and fails closed before reaching this branch.
      if(testDrill && !projections.some(p=>p.outcome==='applied'&&
          p.run_id===run.id&&p.run_attempt===run.run_attempt&&
          p.target_sha===run.head_sha))continue;
      verified.push({...verifyHistoricalE2ERun(run,record,pull.number,
        commitPulls,pull.head.sha,testDrill,selected,projections),
        artifact_id:artifactId,created_at:run.created_at,selection,projections});
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
    if(!known.has(pr?.number)||pr?.base?.repo?.full_name!==repo||
       pr?.head?.repo?.full_name!==repo||!SHA.test(pr?.head?.sha??''))
      return false;
    const merged=pr.state==='closed'&&Boolean(pr.merged_at)&&
      ['staging','main'].includes(pr.base.ref)&&SHA.test(pr.merge_commit_sha??'');
    // DO-NOT-MERGE labels are for candidate discovery only, not Pass proof.
    // Require real source Run/Plan/Artifact and trusted post-PATCH receipts.
    const drill=pr.merged_at==null&&['open','closed'].includes(pr.state)&&
      ['main','staging'].includes(pr.base.ref)&&
      /DO NOT MERGE/i.test(String(pr.title??''))&&
      /DO NOT MERGE/i.test(String(pr.body??''));
    if(!merged&&!drill)return false;
    const refs=new Set();
    for(const line of String(pr.body??'').split(/\r?\n/)){
      const match=line.match(/^\s*Refs?\s*:?\s*(.*)$/i);
      if(match)for(const hit of match[1].matchAll(/#([1-9]\d*)\b/g))
        refs.add(Number(hit[1]));
    }
    return refs.has(issueNumber)&&(merged?refs.size>=2:refs.size>=1);
  }).sort((a,b)=>a.number-b.number).slice(-MAX_LINKED_PRS);
}

// This is a historical PR-head selected run, not an invented main-SHA test
// result. The independently verified *ordinary main merge* and ancestry
// bridge are separate from source Run/Plan/Issue-PATCH provenance.
export function verifyMainSelectedMerge(pr,mergeCommit,comparison,runs,jobs){
  const sha=pr?.merge_commit_sha,head=pr?.head?.sha;
  if(pr?.state!=='closed'||!pr.merged_at||pr?.base?.ref!=='main'||
     pr.base.repo?.full_name!==REPO||pr.head.repo?.full_name!==REPO||
     !SHA.test(sha??'')||!SHA.test(head??'')||
     mergeCommit?.sha!==sha||!Array.isArray(mergeCommit.parents)||
     mergeCommit.parents.length!==2||mergeCommit.parents[1]?.sha!==head||
     !SHA.test(mergeCommit.parents[0]?.sha??'')||
     !['ahead','identical'].includes(comparison?.status)||
     comparison?.merge_base_commit?.sha!==sha)
    throw Error('unverified ordinary main merge or current-main ancestry');
  const checks=['CI / Quality Gate','E2E / Tests',
    'Acceptance / Case Smoke','Acceptance / Orchestrator'];
  const selected=checks.map(name=>{
    const matches=(Array.isArray(runs)?runs:[]).filter(run=>
      run.name===name&&run.head_sha===head&&run.status==='completed'&&
      run.conclusion==='success'&&run.repository?.full_name===REPO&&
      run.path===({
        'CI / Quality Gate':'.github/workflows/ci-quality.yml',
        'E2E / Tests':'.github/workflows/e2e-tests.yml',
        'Acceptance / Case Smoke':'.github/workflows/acceptance-case-smoke.yml',
        'Acceptance / Orchestrator':'.github/workflows/acceptance-orchestrator.yml',
      })[name]&&run.event===(name==='Acceptance / Orchestrator'?'pull_request_target':'pull_request')&&
      goodInt(run.id)&&goodInt(run.run_attempt));
    const winner=matches.sort((a,b)=>b.id-a.id)[0];
    if(!winner)throw Error('missing verified exact-head pre-merge gate '+name);
    return {name,run_id:winner.id,run_attempt:winner.run_attempt,
      source_sha:head,conclusion:'success'};
  });
  if(!Array.isArray(jobs))throw Error('missing completed deterministic PR jobs');
  for(const name of ['pre-merge-gate','acceptance-pr-gate']){
    if(!jobs.some(j=>j.name===name&&j.status==='completed'&&j.conclusion==='success'))
      throw Error('missing successful deterministic PR gate '+name);
  }
  return {merge_sha:sha,pr_head_sha:head,first_parent_sha:mergeCommit.parents[0].sha,
    target_ancestor_verified:true,ordinary_two_parent_merge:true,
    head_gates: selected,deterministic_gates:['pre-merge-gate','acceptance-pr-gate'],
    source_boundary:'verified PR-head selected E2E; merge SHA is ancestry only'};
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
    const mergedMain=Boolean(pr.merged_at)&&pr.base.ref==='main';
    const proven=history.filter(row=>{
      if(!row.selection?.issue_numbers?.includes(issueNumber))return false;
      if(mergedMain)return row.selection.issue_numbers.length>=2 &&
        row.selection.no_e2e_issues?.includes(issueNumber) &&
        row.conclusion==='success' && row.results?.length>0 &&
        row.results.every(item=>item.result==='Pass') &&
        !row.projections?.some(p=>p.issue===issueNumber) &&
        row.projections?.some(p=>p.outcome==='applied'&&
          p.rows?.length>0&&row.selection.selected?.some(item=>
            item.owners?.includes(p.issue)&&
            p.rows.some(r=>r.id===item.id&&r.result==='Pass')));
      if(pr.merged_at)return row.selection.issue_numbers.length>=2 &&
        row.selection.selected?.some(item=>item.owners?.includes(issueNumber)&&
          item.owners.length>=2);
      // A test-only none Issue may inspect authenticated sibling receipts
      // but is never treated as an owner of its sibling's test ID.
      return row.projections?.some(p=>p.outcome==='applied'&&
        p.rows?.length>0&&row.selection.selected?.some(item=>
          item.owners?.includes(p.issue)&&
          p.rows.some(r=>r.id===item.id)));
    });
    if(!proven.length)continue;
    let mainMerge=null;
    if(mergedMain){
      const [commit,comparison,source]=await Promise.all([
        get('/repos/'+repo+'/commits/'+pr.merge_commit_sha),
        get('/repos/'+repo+'/compare/'+pr.merge_commit_sha+'...main'),
        get('/repos/'+repo+'/actions/runs?head_sha='+pr.head.sha+'&per_page=100'),
      ]);
      const runs=source.workflow_runs??[];
      const orchestrator=runs.filter(r=>r.name==='Acceptance / Orchestrator'&&
        r.head_sha===pr.head.sha&&r.status==='completed'&&r.conclusion==='success')
        .sort((a,b)=>b.id-a.id)[0];
      if(!orchestrator)throw Error('no completed pre-merge Orchestrator to verify');
      const detail=await get('/repos/'+repo+'/actions/runs/'+orchestrator.id+
        '/attempts/'+orchestrator.run_attempt+'/jobs?per_page=100');
      mainMerge=verifyMainSelectedMerge(pr,commit,comparison,runs,detail.jobs);
    }
    const payload=pr.merged_at&&!mergedMain?await get('/repos/'+repo+'/actions/runs?head_sha='+
      pr.merge_commit_sha+'&per_page=100'):{workflow_runs:[]};
    const completed=(payload?.workflow_runs??[]).filter(run=>
      run.name==='E2E / Tests'&&run.path==='.github/workflows/e2e-tests.yml'&&
      run.event==='push'&&run.head_branch==='staging'&&
      run.head_sha===pr.merge_commit_sha&&run.repository?.full_name===repo&&
      run.status==='completed'&&run.conclusion==='success')
      .sort((a,b)=>b.id-a.id);
    const artifact=completed.length?await get('/repos/'+repo+
      '/actions/runs/'+completed[0].id+'/artifacts?per_page=100'):{artifacts:[]};
    proofs.push({pr_number:pr.number,pr_head_sha:pr.head.sha,
      staging_merge_sha:mergedMain?null:pr.merge_commit_sha,
      main_merge_sha:mergedMain?pr.merge_commit_sha:null,
      source:'GitHub Issue cross-reference + exact PR identity',
      verified_selected_runs:proven,
      scope:mergedMain?'merged-main-no-e2e':pr.merged_at?'merged-staging':'unmerged-test-only',
      verified_main_merge:mainMerge,
      verified_staging_full:pr.merged_at&&!mergedMain?verifyHistoricalStagingFullRun(repo,
        pr.merge_commit_sha,payload?.workflow_runs,artifact):null});
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
  const get=async path=>{if(!map.has(path))throw Error('unexpected request '+path);return map.get(path)};
  const readPlan=async(_repo,artifact)=>fixturePlan(artifact.id===101?old:current);
  const found=await collectHistoricalE2EForPull(REPO,pr,get,readPlan,async()=>[],async()=>[]);
  assert.deepEqual(found.map(r=>[r.run_id,r.results[0].result]),[[10,'Fail'],[20,'Pass']]);
  assert.deepEqual(found.map(x=>x.artifact_id),[101,202]);
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
  const mergedGet=async p=>{if(!mergedMap.has(p))throw Error('unexpected request '+p);
    return mergedMap.get(p)};
  const mergedHistory=await collectHistoricalE2EForPull(REPO,pr,mergedGet,readPlan,async()=>[],async()=>[]);
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
  const forgedGet=async p=>{if(!forgedMap.has(p))throw Error('unexpected request '+p);
    return forgedMap.get(p)};
  assert.deepEqual(await collectHistoricalE2EForPull(REPO,pr,forgedGet,readPlan,async()=>[],async()=>[]),[]);
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
  const drillPr={number:1761,state:'closed',merged_at:null,
    title:'test(e2e): DO NOT MERGE historical Issue receipt proof',
    body:'Refs #1702\nDO NOT MERGE',
    base:{ref:'main',repo:{full_name:REPO}},
    head:{sha:b,repo:{full_name:REPO}}};
  const drillEvent={event:'cross-referenced',source:{issue:{number:1761,
    pull_request:{url:'https://api.github.com/repos/'+REPO+'/pulls/1761'}}}};
  assert.deepEqual(selectCrossReferencedE2EPulls(REPO,1702,[drillEvent],[drillPr])
    .map(p=>p.number),[1761]);
  assert.deepEqual(selectCrossReferencedE2EPulls(REPO,1702,[drillEvent],[{
    ...drillPr,title:'regular feature PR'}]),[]);
  assert.equal(verifiedCommitPullAssociation([drillPr],1761,b,true),true);
  assert.equal(verifiedCommitPullAssociation([drillPr],1761,b,false),false);
  const noAssociations={...current,pull_requests:[]};
  const applied=[{outcome:'applied',run_id:20,run_attempt:1,target_sha:b}];
  assert.equal(verifyHistoricalE2ERun(noAssociations,rec(current,'Pass'),1718,
    [],b,true,[{sha:b}],applied).conclusion,'success');
  assert.throws(()=>verifyHistoricalE2ERun(noAssociations,rec(current,'Pass'),1718,
    [],b,true,[{sha:a}],applied),/unrelated or untrusted/);
  assert.throws(()=>verifyHistoricalE2ERun(noAssociations,rec(current,'Pass'),1718,
    [],b,true,[{sha:b}],[]),/unrelated or untrusted/);
  assert.throws(()=>verifyHistoricalE2ERun(noAssociations,rec(current,'Pass'),1718,
    [],b,false,[{sha:b}],applied),/unrelated or untrusted/);
  const historicalDrill={...drillPr,number:1718,head:{...drillPr.head,sha:b}};
  const drillMap=new Map(mergedMap);
  drillMap.set('/repos/'+REPO+'/commits/'+a+'/pulls?per_page=100',[]);
  drillMap.set('/repos/'+REPO+'/commits/'+b+'/pulls?per_page=100',[]);
  const strictDrillGet=async p=>{
    if(!drillMap.has(p))throw Error('unexpected drill source '+p);
    return drillMap.get(p);
  };
  // Deliberate historical failures run before receipts were introduced:
  // they are excluded, not promoted from a Playwright artifact into a PATCH.
  assert.deepEqual(await collectHistoricalE2EForPull(REPO,historicalDrill,
    strictDrillGet,readPlan,async()=>[],async()=>[]),[]);
  const appliedDrill=await collectHistoricalE2EForPull(REPO,historicalDrill,
    strictDrillGet,readPlan,async()=>[],async(_repo,run)=>[{
      outcome:'applied',run_id:run.id,run_attempt:run.run_attempt,
      target_sha:run.head_sha,issue:1702,rows:[{id:'login'}],
    }]);
  assert.deepEqual(appliedDrill.map(x=>[x.run_id,x.results[0].result]),
    [[10,'Fail'],[20,'Pass']]);
  assert.deepEqual(await collectHistoricalE2EForPull(REPO,historicalDrill,
    strictDrillGet,readPlan,async()=>[],async(_repo,run)=>[{
      outcome:'recovered',run_id:run.id,run_attempt:run.run_attempt,
      target_sha:run.head_sha,
    }]),[]);
  await assert.rejects(()=>collectHistoricalE2EForPull(REPO,historicalDrill,
    strictDrillGet,readPlan,async()=>[],async()=>{throw Error('forged receipt');}),
    /forged receipt/);

  // A non-E2E child Issue can observe authenticated sibling projections
  // within the same never-merged test PR, without being assigned a test ID.
  const childPr={...drillPr,body:'Refs #1702\nRefs #1759\nDO NOT MERGE'};
  const childEvent={event:'cross-referenced',source:{issue:{number:1761,
    pull_request:{url:'https://api.github.com/repos/'+REPO+'/pulls/1761'}}}};
  const childGet=async url=>{
    if(url.includes('/issues/1759/timeline?'))return [childEvent];
    if(url.endsWith('/pulls/1761'))return childPr;
    throw Error('unexpected child test-only API '+url);
  };
  const appliedSibling=[{run_id:10,selection:{issue_numbers:[1702,1759],
    selected:[{id:'login',owners:[1702]}]},
    results:[{id:'login',result:'Fail'}],
    projections:[{issue:1702,outcome:'applied',rows:[{id:'login',result:'Fail'}]}]}];
  const siblingProof=await collectLinkedIssueE2EEvidence(REPO,1759,childGet,
    async()=>appliedSibling);
  assert.deepEqual(siblingProof.map(x=>[x.pr_number,x.scope]),
    [[1761,'unmerged-test-only']]);
  assert.equal(siblingProof[0].verified_staging_full,null);
  assert.deepEqual(await collectLinkedIssueE2EEvidence(REPO,1759,childGet,
    async()=>appliedSibling.map(row=>({...row,
      projections:[{...row.projections[0],outcome:'recovered'}]}))),[]);

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


  // Independently join source evidence, immutable orphan projection receipt,
  // trusted main Ingest workflow and completed privileged Issue PATCH step.
  const issueNum=1702,proofSha='d'.repeat(40),proofPlan='e'.repeat(64);
  const fixtureBody=['## E2E Verification','### New','- none: no new E2E',
    '### Regression','- login','## E2E Report',
    '| ID | Type | Result | Evidence |','|---|---|---|---|',
    '| login | Regression | Fail | run 75/1, SHA '+proofSha+
      ', contract CONTRACT, plan '+proofPlan+
      ', tests 0/1 (https://github.com/BestNathan/nession/actions/runs/75) |',
    '## Acceptance Report','unchanged'].join('\n');
  const claim=parseIssueE2E(fixtureBody);
  const projected={body:fixtureBody.replace('CONTRACT',claim.digest)};
  const inputRecord={schema_version:1,kind:'issue_e2e_run',
    run_id:75,run_attempt:1,target_sha:proofSha,plan_digest:proofPlan,
    artifact_digest:'sha256:'+'a'.repeat(64),
    results:[{id:'login',result:'Fail',discovered:1,passed:0,failed:1,
      skipped:0,flaky:0,assertions:1}]};
  const inputPlan={mode:'selected',pr_number:1718,target_sha:proofSha,
    plan_digest:proofPlan,issues:[{issue:issueNum,
      declaration_digest:claim.digest,new_ids:[],regression_ids:['login']}],
    selected:[{id:'login',owners:[{issue:issueNum}]}]};
  const after={number:issueNum,body:projected.body,updated_at:'2026-10-14T05:09:00Z'};
  const patch={...after,updated_at:'2026-10-14T05:08:59Z'};
  const receipt=createProjectionReceipt({record:inputRecord,plan:inputPlan,
    issue:issueNum,projected,before:{body:'old version'},readback:after,patch,
    outcome:'applied',ingestRunId:800,ingestAttempt:1});
  const fixtureSource={id:75,run_attempt:1,created_at:'2026-10-14T05:00:00Z',
    html_url:'https://github.com/'+REPO+'/actions/runs/75'};
  const envelope={encoding:'base64',size:JSON.stringify(receipt).length,
    content:Buffer.from(JSON.stringify(receipt)).toString('base64')};
  const fixtureIngest={id:800,run_attempt:1,
    path:'.github/workflows/e2e-test-ingest.yml',name:'E2E / Test Ingest',
    event:'workflow_run',head_branch:'main',status:'completed',
    conclusion:'success',created_at:'2026-10-14T05:02:00Z',
    repository:{full_name:REPO},
    html_url:'https://github.com/'+REPO+'/actions/runs/800'};
  const fixtureJobs={jobs:[{name:'ingest-pr',status:'completed',conclusion:'success',
    steps:[{name:'Store immutable results and update Issue reports',conclusion:'success'}]}]};
  const projectionGet=async url=>{
    if(url.includes('/test/projections/1702.json?ref=acceptance-results'))return envelope;
    if(url.endsWith('/actions/runs/800'))return fixtureIngest;
    if(url.endsWith('/actions/runs/800/attempts/1/jobs?per_page=100'))return fixtureJobs;
    throw Error('unexpected projection source '+url);
  };
  const historyReceipts=await collectAuthenticatedProjectionReceipts(REPO,
    fixtureSource,inputRecord,inputPlan,projectionGet);
  assert.equal(historyReceipts[0].outcome,'applied');
  assert.equal(historyReceipts[0].rows[0].result,'Fail');
  assert.deepEqual(await collectAuthenticatedProjectionReceipts(REPO,
    fixtureSource,inputRecord,inputPlan,async url=>url.endsWith('/actions/runs/800')
      ? {...fixtureIngest,conclusion:'failure'}:projectionGet(url)),[]);
  await assert.rejects(()=>collectAuthenticatedProjectionReceipts(REPO,
    fixtureSource,inputRecord,inputPlan,async url=>url.endsWith('/actions/runs/800')
      ? {...fixtureIngest,repository:{full_name:'foreign/repo'}}:projectionGet(url)),
      /unrelated or untrusted ingest/);
  await assert.rejects(()=>collectAuthenticatedProjectionReceipts(REPO,
    fixtureSource,inputRecord,inputPlan,async url=>url.includes('projections/1702.json')
      ? {...envelope,content:Buffer.from(JSON.stringify({...receipt,body_sha256:'0'.repeat(64)})).toString('base64')}
      : projectionGet(url)),/stored historical read-back body hash mismatch/);

  console.log('Acceptance historical Issue E2E evidence: bounded PR commit/run lineage and negative provenance fixtures passed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'self-test') await selfTest();
  else throw Error('usage: acceptance-e2e-lineage.mjs self-test');
}
