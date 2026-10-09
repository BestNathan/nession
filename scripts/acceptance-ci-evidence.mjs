#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const MAX_RUNS_PER_SHA = 20;
const MAX_ASSOCIATED_PULLS = 5;

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

export function normalizeCiEvidence({ targetSha, directRuns = [], pulls = [], pullRunsBySha = new Map(), sourceAncestry = [] }) {
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
      };
    });

  return {
    schema_version: 1,
    kind: 'acceptance_ci_evidence',
    target_sha: sha,
    direct_runs: compactRuns(directRuns, sha),
    pull_requests: associated,
    source_ancestry: sourceAncestry,
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
  const evidence = normalizeCiEvidence({ targetSha: sha, directRuns, pulls: selectedPulls, pullRunsBySha, sourceAncestry });
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
  assert.equal(evidence.target_sha, 'merge123');
  assert.deepEqual(evidence.direct_runs.map((run) => run.id), [2]);
  assert.deepEqual(evidence.pull_requests[0].runs.map((run) => run.id), [4]);
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
