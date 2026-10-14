#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { collectHistoricalE2EForPull, collectLinkedIssueE2EEvidence } from './acceptance-e2e-lineage.mjs';
import { parseIssueE2E } from './issue-e2e-contract.mjs';

const MAX_RUNS_PER_SHA = 20;
const MAX_ASSOCIATED_PULLS = 5;
const MAX_IMPLEMENTATION_PULLS = 2;
const MAX_CROSS_REFERENCED_PULLS = 40;
const IMPLEMENTATION_OWNER_PATHS = Object.freeze([
  '.github/workflows/e2e-test-ingest.yml',
  'scripts/issue-e2e-projection-receipt.mjs',
]);
const REQUIRED_PR_CHECKS = Object.freeze([
  'CI / Quality Gate', 'E2E / Tests', 'Acceptance / Case Smoke',
  'Acceptance / Orchestrator',
]);


// An Issue may describe itself as a child of a behavior verified on another
// Issue. This mutable relationship is ONLY a bounded discovery hint, never
// evidence that this Issue owned the source Plan or was itself patched.
export function parentEvidenceDiscovery(issue) {
  const title=String(issue?.title??'');
  const body=String(issue?.body??'');
  const a=title.match(/\(#([1-9]\d*)\)\s*$/);
  const b=body.match(/\bchild\s+of\s+#([1-9]\d*)\b/i);
  if(!a||!b||a[1]!==b[1])return null;
  const parent=Number(a[1]);
  if(!Number.isSafeInteger(parent)||parent<=0||parent===Number(issue?.number))
    return null;
  return parent;
}

function requireText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(label + ' is required');
  return text;
}

function compactRun(run) {
  return {
    id: Number(run.id),
    name: String(run.name ?? ''),
    path: String(run.path ?? ''),
    event: String(run.event ?? ''),
    status: String(run.status ?? ''),
    conclusion: run.conclusion == null ? null : String(run.conclusion),
    head_branch: run.head_branch == null ? null : String(run.head_branch),
    head_sha: String(run.head_sha ?? ''),
    html_url: String(run.html_url ?? ''),
    created_at: run.created_at == null ? null : String(run.created_at),
    updated_at: run.updated_at == null ? null : String(run.updated_at),
  };
}

function compactRuns(runs, expectedSha) {
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => String(run?.head_sha ?? '') === expectedSha)
    .map(compactRun)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .slice(0, MAX_RUNS_PER_SHA);
}

export function normalizeCiEvidence({ targetSha, directRuns = [], pulls = [], pullRunsBySha = new Map(), sourceAncestry = [], historicalE2EByPr = new Map(), linkedIssueE2E = [], implementationPulls = [], targetMergeProof = null }) {
  const sha = requireText(targetSha, 'targetSha');
  const associated = (Array.isArray(pulls) ? pulls : [])
    .filter((pull) => pull?.head?.sha)
    .slice(0, MAX_ASSOCIATED_PULLS)
    .map((pull) => {
      const headSha = String(pull.head.sha);
      return {
        number: Number(pull.number),
        state: String(pull.state ?? ''),
        merged_at: pull.merged_at == null ? null : String(pull.merged_at),
        base_ref: pull.base?.ref == null ? null : String(pull.base.ref),
        head_ref: pull.head?.ref == null ? null : String(pull.head.ref),
        head_sha: headSha,
        html_url: String(pull.html_url ?? ''),
        runs: compactRuns(pullRunsBySha.get(headSha) ?? [], headSha),
        historical_e2e_runs: historicalE2EByPr.get(Number(pull.number)) ?? [],
      };
    });

  return {
    schema_version: 1,
    kind: 'acceptance_ci_evidence',
    target_sha: sha,
    direct_runs: compactRuns(directRuns, sha),
    pull_requests: associated,
    source_ancestry: sourceAncestry,
    target_merge_commit: targetMergeProof,
    linked_issue_e2e_evidence: linkedIssueE2E,
    implementation_pull_requests: implementationPulls,
  };
}

async function githubGet(path) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN/GH_TOKEN is required');
  const response = await fetch('https://api.github.com' + path, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nession-acceptance-ci-evidence',
    },
  });
  if (!response.ok) {
    throw new Error('GitHub API ' + response.status + ' for ' + path + ': ' + await response.text());
  }
  return response.json();
}

async function workflowRunsForSha(repo, sha) {
  const query = new URLSearchParams({ head_sha: sha, per_page: '100' });
  const payload = await githubGet('/repos/' + repo + '/actions/runs?' + query.toString());
  return payload.workflow_runs ?? [];
}

// Exact ancestor SHAs may be declared only in the Issue Success Criteria.
// Never scan mutable report text, chat comments or PR descriptions for proof targets.
export function requestedAncestorsFromIssue(body) {
  const section = String(body || '').match(/###? Success Criteria\s*\n([\s\S]*?)(?=\n## Acceptance Report|$)/)?.[1] || '';
  const hashes = [];
  for (const line of section.split('\n')) {
    if (!/^- \[[ x]\] SC-\d+\b/i.test(line) || !/\bancestors?\b/i.test(line)) continue;
    for (const match of line.matchAll(/\b[0-9a-f]{40}\b/g)) hashes.push(match[0]);
  }
  const unique = [...new Set(hashes)];
  if (unique.length > 8) throw new Error('excessive ancestor proof targets in Issue criteria');
  return unique;
}

// Read-only, fail-closed Git object proof. A detached checkout is valid;
// only the actual merge-base exit status and exact input SHA establish ancestry.
export function checkGitAncestor(workspace, targetSha, requiredSha, runner = spawnSync) {
  if (!/^[0-9a-f]{40}$/.test(targetSha) || !/^[0-9a-f]{40}$/.test(requiredSha))
    throw new Error('ancestry proof requires exact 40-character SHAs');
  const result = runner('git', ['-C', workspace, 'merge-base', '--is-ancestor', requiredSha, targetSha], {
    encoding: 'utf8',
  });
  return {
    target_sha: targetSha, ancestor_sha: requiredSha, verified_by: 'git merge-base --is-ancestor',
    is_ancestor: !result.error && result.status === 0,
    status: result.error ? 'error' : result.status === 0 ? 'verified' :
      result.status === 1 ? 'not-ancestor' : 'unknown-object-or-error',
  };
}
// Independently attest ordinary Git merge identity from the fetched trusted
// checkout. GitHub PR metadata and success labels alone do not prove parents.
// Input SHAs from Issue criteria are discovery constraints, never proof.
export function checkGitMergeCommit(workspace,targetSha,expectedHeads=[],runner=spawnSync) {
  if(!/^[a-f0-9]{40}$/.test(targetSha) ||
     !Array.isArray(expectedHeads) || expectedHeads.length>8 ||
     !expectedHeads.every(x=>/^[a-f0-9]{40}$/.test(x)))
    throw new Error('merge parent proof requires exact 40-character SHAs');
  const command=['-C',workspace,'rev-list','--parents','-n','1',targetSha];
  const result=runner('git',command,{encoding:'utf8'});
  const parts=typeof result.stdout==='string'?
    result.stdout.trim().split(/\s+/):[];
  const valid=!result.error && result.status===0 &&
    parts[0]===targetSha && parts.length>=2 &&
    parts.every(x=>/^[a-f0-9]{40}$/.test(x));
  const parents=valid?parts.slice(1):[];
  const isOrdinaryMerge=valid && parents.length===2;
  return {target_sha:targetSha,verified_by:'git rev-list --parents -n 1',
    status:valid?'verified':'unknown-object-or-error',
    parents,is_ordinary_merge:isOrdinaryMerge,
    second_parent_sha:isOrdinaryMerge?parents[1]:null,
    second_parent_matches_declared_source:isOrdinaryMerge&&
      expectedHeads.includes(parents[1])};
}

async function collectSourceAncestry(repo, workspace, targetSha) {
  const issueNumber = String(process.env.ISSUE_NUMBER || '').trim();
  if (!/^\d+$/.test(issueNumber)) return [];
  const issue = await githubGet('/repos/' + repo + '/issues/' + issueNumber);
  const wanted = requestedAncestorsFromIssue(issue.body);
  return wanted.map((sha) => checkGitAncestor(workspace, targetSha, sha));
}

// Optional bounded discovery of *historical implementation* PR gates for
// a requirement that explicitly asks for them in its Success Criteria.
// Mutable Issue/PR prose only enables discovery. GitHub cross-reference,
// merged same-repo PR, exact paths, ancestry and source SHA independently
// establish whether the check bundle is relevant.
export function issueRequestsImplementationGates(issue) {
  const b=String(issue?.body??'');
  const success=b.match(/###? Success Criteria\s*\n([\s\S]*?)(?=\n## Acceptance Plan|\n## Acceptance Report|$)/)?.[1]??'';
  return /## E2E Verification\s*$/m.test(b) &&
    success.split('\n').some(line=>/^- \[[x ]\] SC-\d+\b/i.test(line) &&
      /\bimplementation PR\b/i.test(line));
}
export function selectCrossReferencedImplementationPulls(issueNumber,events) {
  if(!Number.isSafeInteger(issueNumber)||issueNumber<=0||!Array.isArray(events))
    throw Error('invalid implementation discovery input');
  const repo='BestNathan/nession',found=new Set();
  for(const event of events){
    const source=event?.source?.issue;
    const n=source?.number;
    if(event?.event==='cross-referenced'&&Number.isSafeInteger(n)&&n>0&&
       source?.pull_request?.url==='https://api.github.com/repos/'+repo+'/pulls/'+n)
      found.add(n);
  }
  if(found.size>MAX_CROSS_REFERENCED_PULLS)
    throw Error('excessive implementation PR discovery scope');
  return [...found].sort((a,b)=>a-b);
}
export function eligibleImplementationPull(pull,files,issueNumber) {
  const repo='BestNathan/nession';
  if(!Number.isSafeInteger(issueNumber)||issueNumber<=0||
     pull?.state!=='closed'||!pull.merged_at||
     pull?.base?.ref!=='main'||pull.base.repo?.full_name!==repo||
     pull?.head?.repo?.full_name!==repo||
     !/^[a-f0-9]{40}$/.test(pull?.head?.sha??'')||
     !/^[a-f0-9]{40}$/.test(pull?.merge_commit_sha??'')||
     !Array.isArray(files)||files.length>100)return false;
  const refs=new Set();
  for(const line of String(pull.body??'').split(/\r?\n/)){
    const match=line.match(/^\s*Refs?\s*:?\s*(.*)$/i);
    if(match)for(const m of match[1].matchAll(/#([1-9]\d*)\b/g))
      refs.add(Number(m[1]));
  }
  const paths=new Set(files.map(f=>f?.filename));
  return refs.has(issueNumber) &&
    IMPLEMENTATION_OWNER_PATHS.every(p=>paths.has(p));
}
export function exactImplementationGateBundle(runs,headSha,jobResults=[]) {
  if(!/^[a-f0-9]{40}$/.test(headSha)||!Array.isArray(runs))
    throw Error('invalid implementation source head SHA');
  const checks=REQUIRED_PR_CHECKS.map(name=>{
    const matching=runs.filter(r=>r.name===name&&
      r.head_sha===headSha&&
      r.event===(name==='Acceptance / Orchestrator'?'pull_request_target':'pull_request')&&
      r.status==='completed')
      .sort((a,b)=>b.id-a.id);
    const run=matching[0];
    return {name,run_id:run?.id??null,run_attempt:run?.run_attempt??null,
      conclusion:run?.conclusion??'missing',head_sha:headSha,
      url:run?.html_url??null};
  });
  const accepted=checks.find(x=>x.name==='Acceptance / Orchestrator');
  const gateNames=['pre-merge-gate','acceptance-pr-gate'];
  const deterministic=gateNames.map(name=>({
    name,conclusion:jobResults.find(j=>j.name===name)?.conclusion??'missing',
  }));
  const allPassed=checks.every(x=>x.conclusion==='success')&&
    deterministic.every(x=>x.conclusion==='success')&&
    accepted.run_id!=null;
  return {checks,deterministic,all_passed:allPassed};
}
async function collectImplementationGateEvidence(repo,issueNumber,currentIssue,targetSha) {
  if(repo!=='BestNathan/nession'||!issueRequestsImplementationGates(currentIssue))
    return [];
  const events=[];
  for(let page=1;page<=3;page++){
    const pageEvents=await githubGet('/repos/'+repo+'/issues/'+issueNumber+
      '/timeline?per_page=100&page='+page);
    if(!Array.isArray(pageEvents))throw Error('untrusted implementation timeline');
    events.push(...pageEvents);
    if(pageEvents.length<100)break;
  }
  const numbers=selectCrossReferencedImplementationPulls(issueNumber,events);
  const out=[];
  for(const number of numbers){
    if(out.length>=MAX_IMPLEMENTATION_PULLS)break;
    const pr=await githubGet('/repos/'+repo+'/pulls/'+number);
    if(pr?.state!=='closed'||!pr.merged_at||pr.base?.ref!=='main'||
       pr.base.repo?.full_name!==repo||pr.head?.repo?.full_name!==repo)
      continue;
    const files=await githubGet('/repos/'+repo+'/pulls/'+number+'/files?per_page=100');
    if(!eligibleImplementationPull(pr,files,issueNumber))continue;
    // GitHub's compare endpoint independently proves that the merged PR's
    // exact merge commit is an ancestor of the current Acceptance target.
    const comparison=await githubGet('/repos/'+repo+'/compare/'+
      pr.merge_commit_sha+'...'+targetSha);
    if(!['ahead','identical'].includes(comparison?.status)||
       comparison?.merge_base_commit?.sha!==pr.merge_commit_sha)
      continue;
    const runs=await workflowRunsForSha(repo,pr.head.sha);
    const acceptance=runs.filter(x=>x.name==='Acceptance / Orchestrator'&&
      x.head_sha===pr.head.sha&&x.conclusion==='success'&&x.status==='completed')
      .sort((a,b)=>b.id-a.id)[0];
    let jobs=[];
    if(acceptance) {
      const body=await githubGet('/repos/'+repo+'/actions/runs/'+acceptance.id+
        '/attempts/'+acceptance.run_attempt+'/jobs?per_page=100');
      jobs=body.jobs??[];
    }
    const proof=exactImplementationGateBundle(runs,pr.head.sha,jobs);
    out.push({pr_number:number,pr_head_sha:pr.head.sha,
      merge_sha:pr.merge_commit_sha,merged_at:pr.merged_at,
      source:'GitHub Issue cross-reference + main merged PR owned files + exact merge ancestry',
      owner_files:IMPLEMENTATION_OWNER_PATHS,
      ...proof});
  }
  return out;
}

async function collectCommand(workspace, outFile) {
  const repo = requireText(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const sha = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const directRuns = await workflowRunsForSha(repo, sha);
  const pulls = await githubGet('/repos/' + repo + '/commits/' + encodeURIComponent(sha) + '/pulls?per_page=10');
  const selectedPulls = (Array.isArray(pulls) ? pulls : []).filter((pull) => pull?.head?.sha).slice(0, MAX_ASSOCIATED_PULLS);
  const pullRunsBySha = new Map();
  for (const pull of selectedPulls) {
    const headSha = String(pull.head.sha);
    if (!pullRunsBySha.has(headSha)) {
      pullRunsBySha.set(headSha, await workflowRunsForSha(repo, headSha));
    }
  }
  const sourceAncestry = await collectSourceAncestry(repo, workspace, sha);
  const targetMergeProof = sourceAncestry.length && process.env.ACCEPTANCE_STAGE === 'post-merge'
    ? checkGitMergeCommit(workspace, sha, sourceAncestry.map(x=>x.ancestor_sha))
    : null;
  // Acceptance for E2E-specific Issues must also observe previous PR commits:
  // the current target SHA by itself cannot prove a fail-then-pass scenario.
  // Read the trusted orphan Run Record, joined to GitHub completed workflow
  // run ID, exact SHA, PR identity and attempt. These are bounded reads only.
  const historicalE2EByPr = new Map();
  const linkedIssueE2E = [];
  let implementationPulls = [];
  const issueNumber = String(process.env.ISSUE_NUMBER || '').trim();
  if (/^[1-9][0-9]*$/.test(issueNumber)) {
    const currentIssue = await githubGet('/repos/' + repo + '/issues/' + issueNumber);
    const section = String(currentIssue.body ?? '').match(/^## E2E Verification\s*$/m);
    if (section) {
      for (const pull of selectedPulls) {
        historicalE2EByPr.set(Number(pull.number),
          await collectHistoricalE2EForPull(repo, pull, githubGet));
      }
      // Merged main verification may need an earlier, separately merged
      // two-Issue staging PR. Discover that provenance only via GitHub's
      // authenticated Issue→PR timeline and independently revalidate the
      // immutable E2E Run Store and selection artifact before showing it.
      if (process.env.ACCEPTANCE_STAGE === 'post-merge') {
        linkedIssueE2E.push(...await collectLinkedIssueE2EEvidence(repo,
          Number(issueNumber),githubGet));
        // The child Issue's own "none" E2E declaration does not make it an
        // owner of its parent's historical browser scenario. Include the
        // independently authenticated parent source runs *as related
        // behavior evidence only*, after validating the same-repo parent
        // Issue contract. The Agent must not mislabel them as child-owned.
        const parentNumber=parentEvidenceDiscovery(currentIssue);
        if(parentNumber!==null){
          const parent=await githubGet('/repos/'+repo+'/issues/'+parentNumber);
          if(parent?.number!==parentNumber||parent?.pull_request)
            throw Error('invalid related Issue provenance target');
          const contract=parseIssueE2E(parent.body,{requireDeclaration:true});
          if(contract?.errors?.length||!contract?.selectedIds?.length)
            throw Error('parent Issue lacks authenticated E2E obligations');
          const proof=await collectLinkedIssueE2EEvidence(repo,parentNumber,githubGet);
          linkedIssueE2E.push(...proof.map(item=>({
            ...item,behavior_owner_issue:parentNumber,
            related_child_issue:Number(issueNumber),
            relationship_provenance:'candidate parent only; source Plan and protected receipts remain authoritative',
          })));
        }
      }
    }
    if(process.env.ACCEPTANCE_STAGE==='post-merge')
      implementationPulls=await collectImplementationGateEvidence(
        repo,Number(issueNumber),currentIssue,sha);
  }
  const evidence = normalizeCiEvidence({ targetSha: sha, directRuns, pulls: selectedPulls,
    pullRunsBySha, sourceAncestry, historicalE2EByPr, linkedIssueE2E, implementationPulls, targetMergeProof });
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log(
    'collected acceptance CI evidence for ' + sha +
    ': ' + evidence.direct_runs.length + ' direct run(s), ' +
    evidence.pull_requests.length + ' associated PR(s)'
  );
}

function selfTest() {
  const evidence = normalizeCiEvidence({
    targetSha: 'merge123',
    directRuns: [
      { id: 2, name: 'E2E Tests', head_sha: 'merge123', status: 'completed', conclusion: 'success', created_at: '2026-10-07T02:00:00Z' },
      { id: 1, name: 'stale', head_sha: 'other', status: 'completed', conclusion: 'success', created_at: '2026-10-07T03:00:00Z' },
    ],
    pulls: [{
      number: 1459,
      state: 'closed',
      merged_at: '2026-10-07T01:00:00Z',
      html_url: 'https://github.com/BestNathan/nession/pull/1459',
      base: { ref: 'staging' },
      head: { ref: 'fix/capability', sha: 'feature456' },
    }],
    pullRunsBySha: new Map([['feature456', [
      { id: 4, name: 'Quality Gate', head_sha: 'feature456', status: 'completed', conclusion: 'success', created_at: '2026-10-07T01:30:00Z' },
      { id: 3, name: 'wrong head', head_sha: 'wrong', status: 'completed', conclusion: 'success', created_at: '2026-10-07T01:40:00Z' },
    ]]]),
  });

  assert.equal(evidence.kind, 'acceptance_ci_evidence');
  const implIssue={number:1759,body:'## Success Criteria\n- [ ] SC-05 Implementation PR Quality, E2E, Case and Acceptance gates pass.\n## E2E Verification\n### New\n- none'};
  assert.equal(issueRequestsImplementationGates(implIssue),true);
  assert.equal(issueRequestsImplementationGates({...implIssue,body:implIssue.body.replace('Implementation PR','test-only PR')}),false);
  const repo='BestNathan/nession',sourceUrl='https://api.github.com/repos/'+repo+'/pulls/1760';
  const timeline=[{event:'cross-referenced',source:{issue:{number:1760,
    pull_request:{url:sourceUrl}}}}];
  assert.deepEqual(selectCrossReferencedImplementationPulls(1759,timeline),[1760]);
  assert.deepEqual(selectCrossReferencedImplementationPulls(1759,[{
    ...timeline[0],source:{issue:{number:1760,pull_request:{url:'https://api.github.com/repos/foreign/repo/pulls/1760'}}}
  }]),[]);
  const merged={number:1760,state:'closed',merged_at:'2026-10-14T09:00:00Z',
    head:{sha:'a'.repeat(40),repo:{full_name:repo}},base:{ref:'main',repo:{full_name:repo}},
    merge_commit_sha:'b'.repeat(40),body:'Refs #1759'};
  const paths=IMPLEMENTATION_OWNER_PATHS.map(filename=>({filename}));
  assert.equal(eligibleImplementationPull(merged,paths,1759),true);
  assert.equal(eligibleImplementationPull({...merged,base:{ref:'staging',repo:{full_name:repo}}},paths,1759),false);
  assert.equal(eligibleImplementationPull({...merged,body:'Refs #9999'},paths,1759),false);
  assert.equal(eligibleImplementationPull({...merged,head:{...merged.head,repo:{full_name:'foreign/repo'}}},paths,1759),false);
  assert.equal(eligibleImplementationPull(merged,paths.slice(0,1),1759),false);
  const goodRuns=REQUIRED_PR_CHECKS.map((name,i)=>({
    name,id:i+101,run_attempt:1,head_sha:'a'.repeat(40),
    status:'completed',conclusion:'success',
    event:name==='Acceptance / Orchestrator'?'pull_request_target':'pull_request',
    html_url:'https://github.com/BestNathan/nession/actions/runs/'+(101+i),
  }));
  const gateJobs=['pre-merge-gate','acceptance-pr-gate'].map(name=>({name,conclusion:'success'}));
  assert.equal(exactImplementationGateBundle(goodRuns,'a'.repeat(40),gateJobs).all_passed,true);
  assert.equal(exactImplementationGateBundle(goodRuns.map(x=>
    x.name==='Acceptance / Orchestrator'?{...x,event:'pull_request'}:x),
    'a'.repeat(40),gateJobs).all_passed,false);
  assert.equal(exactImplementationGateBundle(goodRuns.map(x=>x.name==='E2E / Tests'?{...x,conclusion:'failure'}:x),
    'a'.repeat(40),gateJobs).all_passed,false);
  assert.equal(exactImplementationGateBundle(goodRuns,'a'.repeat(40),
    [{name:'pre-merge-gate',conclusion:'success'}]).all_passed,false);
  assert.equal(exactImplementationGateBundle(goodRuns.map(x=>({...x,head_sha:'c'.repeat(40)})),
    'a'.repeat(40),gateJobs).all_passed,false);

  assert.equal(evidence.target_sha, 'merge123');
  assert.deepEqual(evidence.direct_runs.map((run) => run.id), [2]);
  assert.deepEqual(evidence.pull_requests[0].runs.map((run) => run.id), [4]);
  const lineage = normalizeCiEvidence({
    targetSha: 'c'.repeat(40),
    pulls: [{number: 5, head: {sha: 'c'.repeat(40)}}],
    historicalE2EByPr: new Map([[5,[{run_id:2,results:[{id:'login',result:'Fail'}]}]]]),
  });
  assert.equal(lineage.pull_requests[0].historical_e2e_runs[0].run_id, 2);
  assert.deepEqual(normalizeCiEvidence({targetSha:'c'.repeat(40),linkedIssueE2E:[{
    pr_number:1718,verified_selected_runs:[{run_id:10}],verified_staging_full:null,
  }]}).linked_issue_e2e_evidence.map(x=>x.pr_number),[1718]);
  assert.equal(parentEvidenceDiscovery({number:1759,
    title:'Requirement: projection receipts (#1702)',
    body:'Child of #1702; verified on parent Issue.'}),1702);
  assert.equal(parentEvidenceDiscovery({number:1759,
    title:'Issue (#1703)',body:'Child of #1702'}),null);
  assert.equal(parentEvidenceDiscovery({number:1759,
    title:'Issue (#1759)',body:'Child of #1759'}),null);
  assert.equal(parentEvidenceDiscovery({number:1759,
    title:'Issue (#1702)',body:'Not a child'}),null);
  assert.equal(parentEvidenceDiscovery({number:1759,
    title:'Issue (#xyz)',body:'Child of #1702'}),null);
  assert.throws(() => normalizeCiEvidence({ targetSha: '' }), /targetSha is required/);
  // Real criteria select only pinned source SHA ancestors; unrelated report
  // logs cannot inject extra proof targets.
  const left = 'a'.repeat(40), right = 'b'.repeat(40), head = 'c'.repeat(40);
  assert.deepEqual(requestedAncestorsFromIssue(
    '### Success Criteria\n- [ ] SC-01 Exact ' + left + ' and ' + right +
    ' are ancestors of the merge commit.\n## Acceptance Report\n' +
    '- [ ] SC-99 fake ' + head + ' ancestors'), [left, right]);
  assert.deepEqual(requestedAncestorsFromIssue('### Success Criteria\n- [ ] SC-02 No Git ancestry claim.'), []);
  assert.equal(checkGitAncestor('/tmp', head, left,
    () => ({status: 0})).is_ancestor, true);
  assert.equal(checkGitAncestor('/tmp', head, left,
    () => ({status: 1})).is_ancestor, false);
  assert.equal(checkGitAncestor('/tmp', head, left,
    () => ({status: 128})).status, 'unknown-object-or-error');
  assert.equal(checkGitAncestor('/tmp', head, left,
    () => ({error: new Error('git unavailable'), status: null})).is_ancestor, false);
  assert.throws(() => checkGitAncestor('/tmp', 'not-a-sha', left), /40-character SHAs/);
  assert.throws(() => requestedAncestorsFromIssue('### Success Criteria\n- [ ] SC-01 ' +
    Array.from({length: 9}, (_, i) => String(i).repeat(40)).join(' ') +
    ' are ancestors'), /excessive/);
  assert.deepEqual(normalizeCiEvidence({targetSha:head, sourceAncestry:[
    checkGitAncestor('/tmp', head, left, () => ({status:0})),
  ]}).source_ancestry.map(x => x.is_ancestor), [true]);

  const parentA='d'.repeat(40),parentB='e'.repeat(40);
  const mergeGit=()=>({status:0,stdout:head+' '+parentA+' '+parentB+'\n'});
  const mergeProof=checkGitMergeCommit('/tmp',head,[parentB],mergeGit);
  assert.deepEqual(mergeProof.parents,[parentA,parentB]);
  assert.equal(mergeProof.status,'verified');
  assert.equal(mergeProof.is_ordinary_merge,true);
  assert.equal(mergeProof.second_parent_matches_declared_source,true);
  assert.equal(normalizeCiEvidence({targetSha:head,
    targetMergeProof:mergeProof}).target_merge_commit.second_parent_sha,parentB);
  assert.equal(checkGitMergeCommit('/tmp',head,[left],mergeGit)
    .second_parent_matches_declared_source,false);
  assert.equal(checkGitMergeCommit('/tmp',head,[parentB],
    ()=>({status:0,stdout:head+' '+parentA+'\n'})).is_ordinary_merge,false);
  assert.equal(checkGitMergeCommit('/tmp',head,[parentB],
    ()=>({status:0,stdout:head+' '+parentA+' '+parentB+' '+left+'\n'}))
    .is_ordinary_merge,false);
  assert.equal(checkGitMergeCommit('/tmp',head,[parentB],
    ()=>({status:0,stdout:'wrong-object '+parentA+' '+parentB+'\n'}))
    .status,'unknown-object-or-error');
  assert.equal(checkGitMergeCommit('/tmp',head,[parentB],
    ()=>({status:128,stdout:''})).is_ordinary_merge,false);
  assert.throws(()=>checkGitMergeCommit('/tmp','bad',[parentB]),/40-character/);

  console.log('acceptance-ci-evidence self-test: collector, bounded criteria and positive/negative Git ancestry passed');
}

async function main() {
  const command = process.argv[2];
  if (command === 'self-test') return selfTest();
  if (command === 'collect') {
    const workspace = process.argv[3];
    const outFile = process.argv[4];
    if (!workspace || !outFile) throw new Error('usage: acceptance-ci-evidence.mjs collect WORKSPACE OUT');
    return collectCommand(workspace, outFile);
  }
  throw new Error('usage: acceptance-ci-evidence.mjs <self-test|collect WORKSPACE OUT>');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
}
