#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { collectHistoricalE2EForPull, collectLinkedIssueE2EEvidence } from './acceptance-e2e-lineage.mjs';
import { parseIssueE2E } from './issue-e2e-contract.mjs';

const MAX_RUNS_PER_SHA = 20;
const MAX_ASSOCIATED_PULLS = 5;


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


const SHA40=/^[0-9a-f]{40}$/;
const MAX_HISTORY_PRS=12;
export function selectMergedIssueHistory(repo,issue,events,pulls){
  if(!Number.isSafeInteger(issue)||issue<1||!Array.isArray(events)||!Array.isArray(pulls))
    throw Error('invalid Issue history discovery input');
  const linked=new Set(events.filter(e=>e?.event==='cross-referenced'&&
    e.source?.issue?.pull_request?.url==='https://api.github.com/repos/'+repo+
      '/pulls/'+e.source.issue.number).map(e=>e.source.issue.number));
  return pulls.filter(p=>linked.has(p?.number)&&p.state==='closed'&&p.merged_at&&
    p.base?.ref==='main'&&p.base?.repo?.full_name===repo&&
    p.head?.repo?.full_name===repo&&SHA40.test(String(p.head?.sha??''))&&
    SHA40.test(String(p.merge_commit_sha??''))&&
    String(p.body??'').split(/\r?\n/).some(line=>
      /^\s*Refs?\s*:?\s*/i.test(line)&&
      new RegExp('(?:^|\\s)#'+issue+'(?!\\d)').test(line)))
    .sort((a,b)=>a.number-b.number).slice(-MAX_HISTORY_PRS);
}
function completedExactGateRuns(repo,sha,items){
  return (Array.isArray(items)?items:[]).filter(r=>r?.head_sha===sha&&
    r.repository?.full_name===repo&&r.status==='completed'&&
    r.conclusion==='success'&&Number.isSafeInteger(r.id)&&r.id>0&&
    ['CI / Quality Gate','E2E / Tests','Acceptance / Case Smoke',
      'Acceptance / Orchestrator'].includes(r.name))
    .map(compactRun).sort((a,b)=>b.id-a.id).slice(0,16);
}
export async function collectMergedIssueGateHistory(repo,issue,workspace,target,
  get=githubGet,ancestry=checkGitAncestor){
  if(!Number.isSafeInteger(issue)||issue<1||!SHA40.test(target))
    throw Error('invalid merged gate history target');
  const events=[];
  for(let page=1;page<=3;page++){
    const block=await get('/repos/'+repo+'/issues/'+issue+
      '/timeline?per_page=100&page='+page);
    if(!Array.isArray(block))throw Error('untrusted Issue timeline');
    events.push(...block);
    if(block.length<100)break;
  }
  const ids=[...new Set(events.filter(e=>e.event==='cross-referenced'&&
    Number.isSafeInteger(e.source?.issue?.number)&&
    e.source.issue.pull_request?.url==='https://api.github.com/repos/'+repo+
      '/pulls/'+e.source.issue.number).map(e=>e.source.issue.number))];
  if(ids.length>40)throw Error('excessive Issue historical PR references');
  const pulls=await Promise.all(ids.map(n=>get('/repos/'+repo+'/pulls/'+n)));
  const out=[];
  for(const p of selectMergedIssueHistory(repo,issue,events,pulls)){
    const proof=ancestry(workspace,target,p.merge_commit_sha);
    if(proof?.target_sha!==target||proof?.ancestor_sha!==p.merge_commit_sha||
      proof?.status!=='verified'||proof?.is_ancestor!==true)continue;
    const [head,merged]=await Promise.all([
      get('/repos/'+repo+'/actions/runs?head_sha='+p.head.sha+'&per_page=100'),
      get('/repos/'+repo+'/actions/runs?head_sha='+p.merge_commit_sha+'&per_page=100'),
    ]);
    out.push({pr_number:p.number,pr_head_sha:p.head.sha,
      merge_sha:p.merge_commit_sha,merged_at:p.merged_at,merge_ancestry:proof,
      source_gate_runs:completedExactGateRuns(repo,p.head.sha,head?.workflow_runs),
      merge_push_runs:completedExactGateRuns(repo,p.merge_commit_sha,
        merged?.workflow_runs).filter(r=>r.event==='push'&&r.head_branch==='main'),
      provenance:'GitHub cross-reference + merged same-repo main PR + Git ancestry + exact-SHA completed Actions'});
  }
  return out;
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

export function normalizeCiEvidence({ targetSha, directRuns = [], pulls = [], pullRunsBySha = new Map(), sourceAncestry = [], historicalE2EByPr = new Map(), linkedIssueE2E = [], mergedGateHistory = [] }) {
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
    linked_issue_e2e_evidence: linkedIssueE2E,
    merged_issue_pr_gate_evidence: mergedGateHistory,
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
async function collectSourceAncestry(repo, workspace, targetSha) {
  const issueNumber = String(process.env.ISSUE_NUMBER || '').trim();
  if (!/^\d+$/.test(issueNumber)) return [];
  const issue = await githubGet('/repos/' + repo + '/issues/' + issueNumber);
  const wanted = requestedAncestorsFromIssue(issue.body);
  return wanted.map((sha) => checkGitAncestor(workspace, targetSha, sha));
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
  // Acceptance for E2E-specific Issues must also observe previous PR commits:
  // the current target SHA by itself cannot prove a fail-then-pass scenario.
  // Read the trusted orphan Run Record, joined to GitHub completed workflow
  // run ID, exact SHA, PR identity and attempt. These are bounded reads only.
  const historicalE2EByPr = new Map();
  const linkedIssueE2E = [];
  const issueNumber = String(process.env.ISSUE_NUMBER || '').trim();
  if (/^[1-9][0-9]*$/.test(issueNumber) && selectedPulls.length) {
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
  }
  const mergedGateHistory = process.env.ACCEPTANCE_STAGE === 'post-merge' &&
    /^[1-9][0-9]*$/.test(issueNumber)
    ? await collectMergedIssueGateHistory(repo,Number(issueNumber),workspace,sha) : [];
  const evidence = normalizeCiEvidence({ targetSha: sha, directRuns, pulls: selectedPulls,
    pullRunsBySha, sourceAncestry, historicalE2EByPr, linkedIssueE2E, mergedGateHistory });
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log(
    'collected acceptance CI evidence for ' + sha +
    ': ' + evidence.direct_runs.length + ' direct run(s), ' +
    evidence.pull_requests.length + ' associated PR(s)'
  );
}


async function historySelfTest(){
  const repo='BestNathan/nession',issue=1759,head='a'.repeat(40),
    merge='b'.repeat(40),target='c'.repeat(40);
  const pr={number:1760,state:'closed',merged_at:'2026-10-14T09:00:00Z',
    base:{ref:'main',repo:{full_name:repo}},
    head:{sha:head,repo:{full_name:repo}},merge_commit_sha:merge,
    body:'Refs #1759'};
  const ev=[{event:'cross-referenced',source:{issue:{number:1760,
    pull_request:{url:'https://api.github.com/repos/'+repo+'/pulls/1760'}}}}];
  assert.deepEqual(selectMergedIssueHistory(repo,issue,ev,[pr]).map(p=>p.number),[1760]);
  assert.deepEqual(selectMergedIssueHistory(repo,issue,ev,[{...pr,body:'Refs #17590'}]),[]);
  assert.deepEqual(selectMergedIssueHistory(repo,issue,ev,[{...pr,merged_at:null}]),[]);
  assert.deepEqual(selectMergedIssueHistory(repo,issue,ev,[{...pr,
    head:{sha:head,repo:{full_name:'foreign/repo'}}}]),[]);
  const run={id:41,name:'CI / Quality Gate',event:'pull_request',
    head_sha:head,repository:{full_name:repo},
    status:'completed',conclusion:'success'};
  const post={...run,id:42,name:'Acceptance / Orchestrator',
    event:'push',head_branch:'main',head_sha:merge};
  const get=async path=>{
    if(path.includes('/timeline?'))return ev;
    if(path.endsWith('/pulls/1760'))return pr;
    if(path.includes('head_sha='+head))return {workflow_runs:[
      run,{...run,id:43,head_sha:target}]};
    if(path.includes('head_sha='+merge))return {workflow_runs:[
      post,{...post,id:44,conclusion:'failure'}]};
    throw Error('unexpected history API '+path);
  };
  const ancestor=(_w,t,m)=>({target_sha:t,ancestor_sha:m,
    status:'verified',is_ancestor:true});
  const result=await collectMergedIssueGateHistory(repo,issue,'/tmp/repo',
    target,get,ancestor);
  assert.deepEqual(result.map(x=>x.pr_number),[1760]);
  assert.deepEqual(result[0].source_gate_runs.map(x=>x.id),[41]);
  assert.deepEqual(result[0].merge_push_runs.map(x=>x.id),[42]);
  assert.deepEqual(await collectMergedIssueGateHistory(repo,issue,'/tmp/repo',
    target,get,(_w,t,m)=>({target_sha:t,ancestor_sha:m,
      status:'not-ancestor',is_ancestor:false})),[]);
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

  assert.deepEqual(normalizeCiEvidence({targetSha:'a'.repeat(40),mergedGateHistory:[{pr_number:1760}]}).merged_issue_pr_gate_evidence,[{pr_number:1760}]);
  console.log('acceptance-ci-evidence self-test: collector, bounded criteria and positive/negative Git ancestry passed');
}

async function main() {
  const command = process.argv[2];
  if (command === 'self-test') { selfTest(); return historySelfTest(); }
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
