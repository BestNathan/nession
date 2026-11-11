#!/usr/bin/env node
// Trusted Issue lifecycle reconciliation; Acceptance evaluation/projection is
// owned by the existing Agent / SC Acceptance and Case Ingest paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  completedIssueAcceptanceDecision,
  extractSection,
  isAcceptanceIssue,
  parseAcceptanceReport,
  parsePreMergeIssueNumbers,
  parseSuccessCriteria,
} from './requirement-acceptance.mjs';
import { planStage, validateAcceptancePlan } from './acceptance-plan.mjs';

const SHA = /^[0-9a-f]{40}$/i;
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function resolveAcceptComment(event, repo, actor) {
  if (event?.action !== 'created' || event.repository?.full_name !== repo ||
      event.issue?.pull_request || event.issue?.state !== 'open' ||
      !Number.isSafeInteger(event.issue?.number) || event.issue.number <= 0 ||
      event.sender?.login !== actor) return null;
  const comment = event.comment;
  if (!comment || comment.body !== '/accept' ||
      comment.user?.type !== 'User' || comment.user.login !== actor ||
      !TRUSTED_ASSOCIATIONS.has(comment.author_association) ||
      !Number.isSafeInteger(comment.id) || comment.id <= 0) return null;
  return { issueNumber: event.issue.number, commentId: comment.id };
}

export function decideIssueClosure(issue, associatedPrs, options = {}) {
  if (!issue || issue.pull_request || issue.state !== 'open' || !isAcceptanceIssue(issue)) {
    return { action: 'skip', reason: 'not an open Bug/Requirement' };
  }
  if (issue.state_reason === 'not_planned') return { action: 'skip', reason: 'not planned' };
  const labels = (issue.labels || []).map(x => typeof x === 'string' ? x : x.name);
  if (labels.includes('status:blocked') || labels.includes('status:on-hold')) {
    return { action: 'pending', reason: 'explicit blocking status' };
  }
  if (options.manualReopened && !options.explicitAccept) {
    return { action: 'pending', reason: 'human-reopened Issue needs explicit /accept' };
  }
  const accepted = completedIssueAcceptanceDecision(issue);
  if (accepted.kind !== 'accepted') {
    return { action: 'pending', reason: 'canonical closure validation: ' +
      (accepted.result?.errors || []).join('; ') };
  }
  if (!Array.isArray(associatedPrs) || associatedPrs.length === 0) {
    return { action: 'pending', reason: 'no verified implementation PR association' };
  }
  if (associatedPrs.some(pr => !pr.merged_at || !['staging', 'main'].includes(pr.base?.ref))) {
    return { action: 'pending', reason: 'associated implementation PR not merged to staging/main' };
  }
  return { action: 'close', reason: 'accepted SCs and merged implementation PRs' };
}

export function selectManualAgentRuns(issue, prs) {
  const success = parseSuccessCriteria(extractSection(issue.body, 'Success Criteria'));
  const report = parseAcceptanceReport(extractSection(issue.body, 'Acceptance Report'));
  const parsed = validateAcceptancePlan(issue.body, success.criteria.keys(), report.rows);
  if (success.errors.length || report.errors.length || parsed.errors.length) {
    return [];
  }
  if (!parsed.plan) return []; // Legacy implicit methods cannot authorize a new Agent.
  const planned = new Map();
  for (const [id, entry] of parsed.plan.entries()) {
    const row = report.rows.get(id);
    if (!row || entry.method !== 'agent') continue;
    if (['pass', 'n/a'].includes(row.result.toLowerCase()) && success.criteria.get(id)?.checked) continue;
    const stage = planStage(entry);
    if (!stage || planned.has(stage)) continue;
    const candidates = prs.filter(pr =>
      stage === 'pre-merge' ||
      (stage === 'staging' && pr.base?.ref === 'staging' && pr.merged_at) ||
      (stage === 'post-merge' && pr.base?.ref === 'main' && pr.merged_at));
    candidates.sort((a, b) => String(b.merged_at || b.updated_at || '').localeCompare(
      String(a.merged_at || a.updated_at || '')));
    const pr = candidates[0];
    const sha = stage === 'pre-merge' ? pr?.head?.sha : pr?.merge_commit_sha;
    if (!SHA.test(String(sha || ''))) continue;
    planned.set(stage, sha);
  }
  return [...planned].map(([stage, sha]) => ({ stage, target_ref: sha }));
}

async function githubRequest(path, { token, method = 'GET', body } = {}) {
  if (!token) throw Error('GITHUB_TOKEN/GH_TOKEN is required');
  const response = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nession-issue-lifecycle',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Error('GitHub ' + method + ' ' + path + ': ' + response.status +
    ' ' + (await response.text()).slice(0, 400));
  if (response.status === 204) return null;
  return response.json();
}

function repoParts(repository) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository || '');
  if (!match) throw Error('invalid GITHUB_REPOSITORY');
  return { owner: match[1], name: match[2], prefix: '/repos/' + repository };
}

async function relatedPulls(repository, issueNumber, token, includePr = null, request = githubRequest) {
  const { owner, name, prefix } = repoParts(repository);
  const query = encodeURIComponent('repo:' + repository + ' is:pr ' + issueNumber);
  const found = await request('/search/issues?q=' + query + '&per_page=100', { token });
  if (found.incomplete_results || found.total_count > 100 || !Array.isArray(found.items)) {
    throw Error('incomplete implementation PR discovery; refusing Issue closure');
  }
  const numbers = new Set(found.items.map(pr => pr.number));
  if (includePr) numbers.add(includePr);
  const prs = [];
  for (const number of numbers) {
    if (!Number.isSafeInteger(number) || number <= 0) throw Error('invalid PR discovery result');
    const pr = await request(prefix + '/pulls/' + number, { token });
    if (parsePreMergeIssueNumbers(pr.body, owner, name, pr.title).includes(issueNumber)) {
      prs.push(pr);
    }
  }
  return prs;
}

async function humanReopened(repository, issueNumber, token, request = githubRequest) {
  const { prefix } = repoParts(repository);
  // Fail closed if history exceeds one page: a hidden older human reopen
  // cannot be silently treated as absent.
  const events = await request(prefix + '/issues/' + issueNumber + '/events?per_page=100', { token });
  if (!Array.isArray(events) || events.length === 100) {
    throw Error('Issue event history incomplete; refusing automatic close');
  }
  return events.some(event => event.event === 'reopened' && event.actor?.type === 'User');
}

async function reconcileIssue(repository, number, token, { explicitAccept = false, includePr = null,
  request = githubRequest } = {}) {
  const { prefix } = repoParts(repository);
  const issue = await request(prefix + '/issues/' + number, { token });
  if (!issue || issue.number !== number) throw Error('Issue number mismatch');
  if (issue.state !== 'open' || !isAcceptanceIssue(issue) || issue.pull_request) {
    return { action: 'skip', reason: 'not an open native acceptance Issue' };
  }
  const prs = await relatedPulls(repository, number, token, includePr, request);
  const manualReopened = await humanReopened(repository, number, token, request);
  const decision = decideIssueClosure(issue, prs, { manualReopened, explicitAccept });
  if (decision.action !== 'close') return { ...decision, prs };
  // Re-read before mutation: a later Issue edit or reopen must not be raced by
  // a stale evaluation. GitHub's Issues API has no compare-and-set PATCH.
  const fresh = await request(prefix + '/issues/' + number, { token });
  if (fresh.state !== 'open' || fresh.updated_at !== issue.updated_at) {
    return { action: 'pending', reason: 'Issue changed during reconciliation; retry on fresh evidence' };
  }
  await request(prefix + '/issues/' + number, {
    token, method: 'PATCH', body: { state: 'closed', state_reason: 'completed' },
  });
  return { action: 'closed', reason: decision.reason, prs: prs.map(pr => pr.number) };
}

async function handleManual(event, repository, actor, token, request = githubRequest) {
  const command = resolveAcceptComment(event, repository, actor);
  if (!command) return { action: 'skip', reason: 'untrusted or non-/accept comment' };
  if (process.env.GITHUB_RUN_ATTEMPT && process.env.GITHUB_RUN_ATTEMPT !== '1') {
    return { action: 'skip', reason: 'manual dispatch is first-attempt only' };
  }
  const { prefix } = repoParts(repository);
  const result = await reconcileIssue(repository, command.issueNumber, token,
    { explicitAccept: true, request });
  if (result.action !== 'pending') return result;
  const issue = await request(prefix + '/issues/' + command.issueNumber, { token });
  const labels = (issue.labels || []).map(x => typeof x === 'string' ? x : x.name);
  if (labels.includes('status:blocked') || labels.includes('status:on-hold')) {
    return { action: 'pending', reason: 'explicit blocker prevents manual re-dispatch' };
  }
  const prs = await relatedPulls(repository, command.issueNumber, token, null, request);
  const runs = selectManualAgentRuns(issue, prs);
  for (const run of runs) {
    await request(prefix + '/actions/workflows/agent-sc-acceptance.yml/dispatches', {
      token, method: 'POST',
      body: { ref: 'main', inputs: {
        issue_number: String(command.issueNumber), stage: run.stage,
        target_ref: run.target_ref, provider: '', deployment: '',
      }},
    });
  }
  return { action: runs.length ? 'dispatched' : 'pending', reason: result.reason,
    agent_runs: runs, note: 'Case/deployed proof remains with its existing trusted runner' };
}

async function selfTest() {
  const sha = 'a'.repeat(40);
  const body = '## Success Criteria\n- [x] SC-01 acceptance is proven\n\n## Acceptance Plan\n\n' +
  '\x60\x60\x60yaml\nacceptance:\n  SC-01:\n    when: pr\n    method: agent\n\x60\x60\x60\n\n' +
  '## Acceptance Report\n\n| Criterion | Result | Evidence |\n|---|---|---|\n' +
  '| SC-01 | Pass | run 100; ref ' + sha + '; source agent-qwen; test: exact SHA fixture |\n';
  const issue = { number: 19, state: 'open', labels: [{ name: 'bug' }], body };
  const pr = { number: 21, title: 'fix (#19)', body: 'Fixes #19', head: { sha },
    base: { ref: 'staging' }, merged_at: '2026-11-11T01:00:00Z', merge_commit_sha: sha };
  assert.equal(decideIssueClosure(issue, [pr]).action, 'close');
  assert.equal(decideIssueClosure({ ...issue, labels: [{ name: 'requirement' }] }, [pr]).action, 'close');
  assert.equal(decideIssueClosure(issue, [pr], { manualReopened: true }).action, 'pending');
  assert.equal(decideIssueClosure(issue, [pr], {
    manualReopened: true, explicitAccept: true,
  }).action, 'close');
  assert.equal(decideIssueClosure(issue, []).action, 'pending');
  assert.equal(decideIssueClosure(issue, [{ ...pr, merged_at: null }]).action, 'pending');
  assert.equal(decideIssueClosure({ ...issue, body: body.replace('| Pass |', '| Pending |') },
    [pr]).action, 'pending');
  assert.equal(decideIssueClosure({ ...issue, labels: [{ name: 'bug' }, { name: 'requirement' }] },
    [pr]).action, 'skip');
  assert.equal(decideIssueClosure({ ...issue, labels: [{ name: 'bug' }, { name: 'status:blocked' }] },
    [pr]).action, 'pending');
  assert.deepEqual(selectManualAgentRuns(
    { ...issue, body: body.replace('| Pass |', '| Pending |') }, [pr]),
    [{ stage: 'pre-merge', target_ref: sha }]);
  assert.deepEqual(selectManualAgentRuns(issue, [pr]), []);
  const e = { action: 'created', repository: { full_name: 'X/y' },
    issue: { number: 19, state: 'open' }, sender: { login: 'owner' },
    comment: { body: '/accept', id: 7, user: { login: 'owner', type: 'User' },
      author_association: 'OWNER' } };
  assert.equal(resolveAcceptComment(e, 'X/y', 'owner').issueNumber, 19);
  for (const mutated of [
    { comment: { ...e.comment, body: '/accept now' } },
    { comment: { ...e.comment, author_association: 'CONTRIBUTOR' } },
    { comment: { ...e.comment, user: { ...e.comment.user, type: 'Bot' } } },
    { issue: { ...e.issue, pull_request: {} } },
    { issue: { ...e.issue, state: 'closed' } },
    { sender: { login: 'forged' } },
  ]) assert.equal(resolveAcceptComment({ ...e, ...mutated }, 'X/y', 'owner'), null);
  // Exercise the real mocked REST orchestration, not merely the policy function.
  let live = { ...issue, updated_at: '2026-11-11T01:00:00Z' };
  let writes = 0, dispatches = 0;
  const mock = async (path, options = {}) => {
    if (path.startsWith('/search/issues?')) return { incomplete_results: false, total_count: 1,
      items: [{ number: 21 }] };
    if (path.endsWith('/pulls/21')) return pr;
    if (path.endsWith('/issues/19/events?per_page=100')) return [];
    if (path.endsWith('/actions/workflows/agent-sc-acceptance.yml/dispatches')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.body.inputs.target_ref, sha);
      dispatches += 1; return null;
    }
    if (path.endsWith('/issues/19')) {
      if (options.method === 'PATCH') {
        assert.equal(options.body.state, 'closed');
        writes += 1; live = { ...live, state: 'closed' };
      }
      return live;
    }
    throw Error('unexpected fixture API path ' + path);
  };
  const once = await reconcileIssue('X/y', 19, 'fixture-token', { request: mock });
  assert.equal(once.action, 'closed');
  assert.equal(writes, 1);
  assert.equal((await reconcileIssue('X/y', 19, 'fixture-token',
    { request: mock })).action, 'skip');
  assert.equal(writes, 1, 'repeat delivery must never write another closure');
  live = { ...issue, updated_at: '2026-11-11T01:01:00Z',
    body: body.replace('| Pass |', '| Pending |') };
  const manual = await handleManual(e, 'X/y', 'owner', 'fixture-token', mock);
  assert.equal(manual.action, 'dispatched');
  assert.equal(dispatches, 1);
  assert.equal(writes, 1, 'manual command cannot turn Pending into Pass');
  assert.equal((await handleManual({ ...e, comment: { ...e.comment, body: '/accept all' } },
    'X/y', 'owner', 'fixture-token', mock)).action, 'skip');
  assert.equal(dispatches, 1, 'untrusted comments cannot dispatch');
  live = { ...issue, body, updated_at: '2026-11-11T01:02:00Z' };
  // Distinct timestamps across successive reads force no mutation.
  let reads = 0;
  const race = async (path, options = {}) => {
    if (path.endsWith('/issues/19') && options.method !== 'PATCH') {
      reads += 1; return { ...live, updated_at: '2026-11-11T01:02:0' + reads + 'Z' };
    }
    return mock(path, options);
  };
  assert.equal((await reconcileIssue('X/y', 19, 'fixture-token',
    { request: race })).action, 'pending');
  assert.equal(writes, 1, 'racing edits must not close the Issue');
  await assert.rejects(reconcileIssue('X/y', 19, 'fixture-token', {
    request: async (path, options) => path.endsWith('/events?per_page=100')
      ? Array(100).fill({event:'labeled'}) : mock(path, options),
  }), /event history incomplete/);
  console.log('issue-lifecycle-reconcile: closure and exact /accept negative fixtures passed');
}

async function main() {
  const [command, value] = process.argv.slice(2);
  if (command === 'self-test') { await selfTest(); return; }
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  let result;
  if (command === 'issue') {
    if (!/^[1-9][0-9]*$/.test(value || '')) throw Error('positive Issue number required');
    result = await reconcileIssue(repository, Number(value), token);
  } else if (command === 'pr') {
    if (!/^[1-9][0-9]*$/.test(value || '')) throw Error('positive PR number required');
    const { owner, name, prefix } = repoParts(repository);
    const pr = await githubRequest(prefix + '/pulls/' + value, { token });
    if (!pr.merged_at || !['staging', 'main'].includes(pr.base?.ref)) {
      result = { action: 'skip', reason: 'PR not merged to staging/main' };
    } else {
      const numbers = parsePreMergeIssueNumbers(pr.body, owner, name, pr.title);
      result = [];
      for (const number of numbers) {
        result.push({ issue: number, ...await reconcileIssue(repository, number, token,
          { includePr: pr.number }) });
      }
    }
  } else if (command === 'manual') {
    const event = JSON.parse(fs.readFileSync(value, 'utf8'));
    result = await handleManual(event, repository, process.env.GITHUB_ACTOR, token);
  } else {
    throw Error('usage: issue-lifecycle-reconcile.mjs <self-test|issue N|pr N|manual EVENT_JSON>');
  }
  console.log(JSON.stringify(result));
}
if (import.meta.url === 'file://' + process.argv[1]) {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
