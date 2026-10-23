// #2252 follow-up: trusted Publisher publication → Store Reviewer handoff.
// The caller independently verifies the publication (publication-readback.mjs)
// and then applies the deterministic transition; this module never trusts a
// model, an Issue comment or a PR-head checkout for identity.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTROLLED_ORIGINAL_PUBLICATION as P,
  verifyControlledOriginalPublication } from './publication-readback.mjs';
import { CONTROLLED_PUBLISHER_INTENT_PATH } from './store-intent.mjs';
import { readIssueWorkflowState, writeIssueWorkflowState } from '../orchestration/state-store.mjs';
import { acceptPublisherPublication } from '../orchestration/outbox.mjs';
import { githubFetcher } from '../github-read.mjs';
import { auditStagedRunStore } from '../../../run-store-integrity.mjs';
import { publish } from '../../../run-store-cas-push.mjs';

const REPO = 'BestNathan/nession';
const ISSUE = 1997;
const SHA = /^[a-f0-9]{40}$/;
function fail(reason) { throw new Error('Publisher review ingest: ' + reason); }

// Every source is an independent read; the exact pinned Run/PR/comment IDs are
// owned by publication-readback.mjs, not by this caller.
export async function fetchControlledPublication({ fetcher }) {
  if (typeof fetcher !== 'function') fail('trusted fetcher required');
  const read = (endpoint) => fetcher(endpoint);
  const sourceRun = await read('actions/runs/' + P.publisher_run);
  const sourceJobs = await read('actions/runs/' + P.publisher_run + '/jobs?per_page=100');
  const ownerComment = await read('issues/comments/' + P.command_comment_id);
  const pullRequest = await read('pulls/' + P.original_pr);
  const branchRef = await read('git/ref/heads/' + P.branch);
  const pullCommits = await read('pulls/' + P.original_pr + '/commits?per_page=100');
  const originalCommit = await read('commits/' + P.original_pr_sha);
  const currentFiles = await read('pulls/' + P.original_pr + '/files?per_page=100');
  const branchPulls = await read(
    'pulls?head=' + encodeURIComponent(REPO + '/' + P.branch) + '&state=all');
  return verifyControlledOriginalPublication({
    sourceRun, sourceJobs, ownerComment,
    intent: readControlledIntent(await read('contents/' +
      CONTROLLED_PUBLISHER_INTENT_PATH + '?ref=agent-store')),
    pullRequest, branchRef, pullCommits,
    originalCommit: { sha: originalCommit?.sha, parents: originalCommit?.parents },
    originalFiles: originalCommit?.files,
    currentFiles, branchPulls,
  });
}

// The immutable intent is read through the GitHub contents API as base64 so
// the fetcher stays one HTTPS shape; the verifier still enforces its bytes.
function readControlledIntent(contents) {
  if (!contents || contents.encoding !== 'base64' || typeof contents.content !== 'string')
    fail('immutable Publisher intent unavailable');
  try { return JSON.parse(Buffer.from(contents.content, 'base64').toString('utf8')); }
  catch { fail('invalid immutable Publisher intent'); }
}

function verifiedReadback(readback) {
  if (!readback || readback.kind !== 'publisher_original_publication_readback' ||
      readback.status !== 'original_pr_verified_not_reviewed' ||
      readback.issue !== ISSUE || readback.original_pr !== P.original_pr ||
      readback.original_publisher_run_id !== P.publisher_run ||
      !SHA.test(readback.current_pr_sha ?? ''))
    fail('verified publication readback required');
  return readback;
}

// The Store write is the canonical state-store CAS. The Git commit/push stays
// with the main-owned workflow writer, exactly like controller-start.mjs.
export function applyPublisherReviewHandoff({ storeRoot, readback, registry }) {
  const verified = verifiedReadback(readback);
  if (typeof storeRoot !== 'string' || !storeRoot) fail('Store checkout required');
  const current = readIssueWorkflowState(storeRoot, ISSUE);
  if (current.state === null) fail('initialized Issue workflow state required');
  const event = { kind: 'publisher', outcome: 'published', issue: ISSUE,
    run_id: verified.original_publisher_run_id, run_attempt: 1,
    target_sha: verified.current_pr_sha };
  const trusted = { workflow_run_id: event.run_id, attempt: event.run_attempt,
    issue: event.issue, source_sha: event.target_sha, role: 'publisher' };
  const next = acceptPublisherPublication(current.state, current.version, event, trusted, registry);
  if (next === current.state) {
    return { changed: false, version: current.version, state: next,
      target_sha: current.state.target_sha };
  }
  const written = writeIssueWorkflowState(storeRoot, next, current.version);
  const reviewer = next.outbox.find(x =>
    x.status === 'pending' && x.task.type === 'dispatch' && x.task.role === 'reviewer');
  if (!reviewer) fail('Reviewer action missing after publication transition');
  return { changed: written.changed, version: written.version, state: next,
    target_sha: next.target_sha, reviewer_action_id: reviewer.id,
    reviewer_agent_id: reviewer.task.agent_id };
}

function loadRegistry() {
  return JSON.parse(fs.readFileSync('automation/agents/registry.json', 'utf8'));
}

const STORE_REF = 'agent-store';
function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 45000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    }).trim();
  } catch {
    // Never surface stderr: an authenticated origin URL may contain a token.
    fail('Git ' + args[0] + ' failed');
  }
}
function openStoreRemote(remote) {
  if (typeof remote !== 'string' || !remote || remote.length > 2000 || /\s/.test(remote))
    fail('invalid trusted Store remote');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-store-write-'));
  const work = path.join(temp, 'store');
  try {
    execFileSync('git', ['clone', '--no-tags', '--single-branch', '--branch', STORE_REF,
      '--', remote, work], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 45000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    });
    if (git(work, ['symbolic-ref', '--short', 'HEAD']) !== STORE_REF)
      fail('not an agent-store checkout');
    return { temp, work };
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    if (String(error.message).startsWith('Publisher review ingest:')) throw error;
    fail('authenticated agent-store remote unavailable');
  }
}

// Composes the existing owners: the state-store CAS writes the version, the
// run-store audit proves exactly one state + head change, and the canonical
// CAS push publishes without force or rewriting history. The workflow supplies
// the authenticated remote; this function never logs it.
export function applyPublicationToRemote({ remote, readback, registry,
  publishStore = publish, onCandidate = null }) {
  const { temp, work } = openStoreRemote(remote);
  try {
    const applied = applyPublisherReviewHandoff({ storeRoot: work, readback, registry });
    if (!applied.changed) return { ...applied, commit_sha: null, replayed: true };
    git(work, ['add', '-A']);
    const audit = auditStagedRunStore(work, STORE_REF);
    if (audit.checked_changes !== 2)
      fail('publisher handoff expected one immutable state and one head pointer');
    git(work, ['-c', 'user.name=nession-agent-controller',
      '-c', 'user.email=nession-agent-controller@users.noreply.github.com',
      'commit', '-m', 'agent-store: record Publisher review handoff for Issue ' + ISSUE]);
    if (onCandidate !== null) {
      if (process.env.NODE_ENV !== 'test') fail('candidate injection prohibited outside tests');
      onCandidate();
    }
    const published = publishStore(STORE_REF, work, 4);
    return { ...applied, commit_sha: published.commit_sha, replayed: published.replayed };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// The automatic wake is a completed Publisher workflow_run. The controlled
// publication predates this workflow, so a one-shot owner wake uses
// workflow_dispatch; both are main-only, and the workflow job's actor guard is
// the authority check. This function rejects every other event/ref/workflow.
export function assertTrustedMainWorkflow(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' ||
      env.GITHUB_REPOSITORY !== REPO ||
      env.GITHUB_REF !== 'refs/heads/main' ||
      !['workflow_run', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
      env.GITHUB_WORKFLOW !== 'Store / Publisher Review Ingest')
    fail('trusted main-only Store Ingest required');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'fetch' && args.length === 2 && args[0] === '--out') {
    const readback = await fetchControlledPublication({
      fetcher: githubFetcher(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
    });
    fs.writeFileSync(args[1], JSON.stringify(readback, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
    console.log('Publisher publication verified at ' + readback.current_pr_sha);
    return;
  }
  if (command === 'apply' && args.length === 2) {
    assertTrustedMainWorkflow();
    const readback = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const result = applyPublisherReviewHandoff({
      storeRoot: args[0], readback, registry: loadRegistry(),
    });
    console.log(JSON.stringify({ changed: result.changed, version: result.version,
      target_sha: result.target_sha, reviewer_action_id: result.reviewer_action_id,
      reviewer_agent_id: result.reviewer_agent_id }));
    return;
  }
  if (command === 'apply-store' && args.length === 2) {
    assertTrustedMainWorkflow();
    const readback = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const result = applyPublicationToRemote({
      remote: args[0], readback, registry: loadRegistry(),
    });
    console.log(JSON.stringify({ changed: result.changed, version: result.version,
      target_sha: result.target_sha, reviewer_action_id: result.reviewer_action_id,
      reviewer_agent_id: result.reviewer_agent_id, commit_sha: result.commit_sha,
      replayed: result.replayed }));
    return;
  }
  fail('usage: fetch --out FILE | apply STORE READBACK_JSON | apply-store REMOTE READBACK_JSON');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('::error::' + error.message);
    process.exitCode = 1;
  });
}
