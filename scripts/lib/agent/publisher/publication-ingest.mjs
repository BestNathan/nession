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
import { CONTROLLED_PUBLISHER_INTENT_PATH, validateQwenPublisherIntent,
  qwenPublisherIntentPath } from './store-intent.mjs';
import { readIssueWorkflowState, writeIssueWorkflowState } from '../orchestration/state-store.mjs';
import { acceptPublisherPublication, acceptAttestedQwenPublication,
  acceptAttestedQwenRepairPublication }
  from '../orchestration/outbox.mjs';
import { validateQwenRepairPublisherIntent, qwenRepairPublisherIntentPath }
  from './qwen-repair-intent.mjs';
import { githubFetcher } from '../github-read.mjs';
import { auditStagedRunStore } from '../../../run-store-integrity.mjs';
import {createHash} from 'node:crypto';
import {appendAuthenticatedResult,validateAuthenticatedAgentReceipt}
  from '../orchestration/result-artifact.mjs';
import { publish } from '../../../run-store-cas-push.mjs';

const REPO = 'BestNathan/nession';
const OWNER = REPO.split('/')[0];
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
  // GitHub's head filter is "owner:branch" (not "repository:branch" and not
  // "owner/branch"); a wrong separator or slug silently returns no PRs and
  // the verifier fails closed.
  const branchPulls = await read(
    'pulls?head=' + encodeURIComponent(OWNER + ':' + P.branch) + '&state=all');
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
export function applyPublisherReviewHandoff({ storeRoot, readback, registry, reviewerAgentId = null }) {
  const verified = verifiedReadback(readback);
  if (typeof storeRoot !== 'string' || !storeRoot) fail('Store checkout required');
  const current = readIssueWorkflowState(storeRoot, ISSUE);
  if (current.state === null) fail('initialized Issue workflow state required');
  const event = { kind: 'publisher', outcome: 'published', issue: ISSUE,
    run_id: verified.original_publisher_run_id, run_attempt: 1,
    target_sha: verified.current_pr_sha,
    ...(reviewerAgentId != null ? { reviewer_agent_id: reviewerAgentId } : {}) };
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
export function applyPublicationToRemote({ remote, readback, registry, reviewerAgentId = null,
  publishStore = publish, onCandidate = null }) {
  const { temp, work } = openStoreRemote(remote);
  try {
    const applied = applyPublisherReviewHandoff({ storeRoot: work, readback, registry,
      reviewerAgentId });
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
  // The owner-only Store / Publisher Review Ingest workflow passes --reviewer
  // from its optional owner input; the library validates the identity and
  // records the assignment immutably, while an empty input keeps it unchanged.
  if (command === 'apply-store' &&
      (args.length === 2 || (args.length === 4 && args[2] === '--reviewer'))) {
    assertTrustedMainWorkflow();
    const reviewerAgentId = args.length === 4 ? args[3] : null;
    const readback = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const result = applyPublicationToRemote({
      remote: args[0], readback, registry: loadRegistry(), reviewerAgentId,
    });
    console.log(JSON.stringify({ changed: result.changed, version: result.version,
      target_sha: result.target_sha, reviewer_action_id: result.reviewer_action_id,
      reviewer_agent_id: result.reviewer_agent_id, commit_sha: result.commit_sha,
      replayed: result.replayed }));
    return;
  }
  fail('usage: fetch --out FILE | apply STORE READBACK_JSON | apply-store REMOTE READBACK_JSON [--reviewer ID]');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('::error::' + error.message);
    process.exitCode = 1;
  });
}

// The Qwen publication runs from the same canonical Store/Outbox owners as
// the historical #1997 Publisher, but its source was a DISPATCHED Worker
// (not a fabricated yielded continuation). The main-only caller must fetch
// readback using readBackQwenPublishedPR immediately before this transition.
export function applyQwenPublisherReviewHandoff({
  storeRoot,readback,intent,registry,
}){
  const record=validateQwenPublisherIntent(intent?.record);
  if(!readback||readback.schema_version!==1||
      readback.kind!=='authenticated_qwen_publisher_pr_receipt'||
      readback.status!=='published_verified_by_github'||
      readback.issue!==record.issue||
      readback.action_id!==record.action_id||
      readback.source_run_id!==record.worker_run_id||
      readback.source_run_attempt!==1||
      readback.publisher_run_id!==record.publisher_run_id||
      readback.publication_intent_store_sha!==intent.store_commit_sha||
      readback.checkpoint_commit_sha!==record.checkpoint_commit_sha||
      readback.target_main_sha!==record.target_main_sha||
      readback.patch_sha256!==record.patch_sha256||
      readback.branch!==record.branch||
      !Number.isSafeInteger(readback.pull_request)||
      readback.pull_request<1||!SHA.test(readback.head_sha??'')||
      readback.head_sha===record.source_sha||
      !Array.isArray(readback.files)||
      readback.files.length!==record.file_count)
    fail('Qwen handoff has no independently verified GitHub PR/source');
  const location=qwenPublisherIntentPath(record);
  const full=path.join(storeRoot,location);
  const stat=fs.lstatSync(full,{throwIfNoEntry:false});
  if(!stat?.isFile()||stat.isSymbolicLink()||stat.size>8192)
    fail('unreadable immutable Qwen Publisher Intent');
  let saved;
  try{saved=JSON.parse(fs.readFileSync(full,'utf8'));}
  catch{fail('invalid Qwen Publisher Intent in Store');}
  if(JSON.stringify(saved)!==JSON.stringify(record))
    fail('Publisher Qwen Intent differs from committed Store record');
  const ancestors=git(storeRoot,['merge-base','--is-ancestor',
    intent.store_commit_sha,'HEAD']);
  if(ancestors!==''||!SHA.test(intent.store_commit_sha??''))
    fail('Publisher Qwen Intent was not committed in ancestor Store');
  const current=readIssueWorkflowState(storeRoot,record.issue);
  if(!current.state)fail('Qwen Issue workflow State missing');
  const event={kind:'publisher',issue:record.issue,outcome:'published',
    run_id:record.publisher_run_id,run_attempt:1,
    target_sha:readback.head_sha};
  const trusted={role:'publisher',workflow_run_id:record.publisher_run_id,
    attempt:1,issue:record.issue,source_sha:readback.head_sha,
    developer_action_id:record.action_id,
    developer_run_id:record.worker_run_id,developer_attempt:1,
    developer_source_sha:record.worker_source_sha,
    checkpoint_commit_sha:record.checkpoint_commit_sha,
    pr_number:readback.pull_request};
  const next=acceptAttestedQwenPublication(
    current.state,current.version,event,trusted,registry);
  if(next===current.state){
    return {changed:false,version:current.version,issue:record.issue,
      target_sha:current.state.target_sha};
  }
  const written=writeIssueWorkflowState(storeRoot,next,current.version);
  const reviewer=next.outbox.filter(x=>x.status==='pending'&&
    x.task?.type==='dispatch'&&x.task?.role==='reviewer');
  if(reviewer.length!==1)fail('Qwen Publisher must produce exactly one Reviewer');
  return {changed:written.changed,version:written.version,issue:record.issue,
    target_sha:next.target_sha,reviewer_action_id:reviewer[0].id,
    reviewer_agent_id:reviewer[0].task.agent_id};
}
export function applyQwenPublicationToRemote({remote,readback,intent,registry,
  developerResult=null,publishStore=publish,onCandidate=null}){
  // Only the main-owned authenticated Publisher may compose this receipt;
  // immutable Intent records or model output do not authorize a result.
  if(developerResult!==null){
    validateAuthenticatedAgentReceipt(developerResult);
    const origin=intent?.record;
    if(developerResult.schema_version!==2||
      developerResult.result.kind!=='developer'||
      developerResult.issue!==origin?.issue||
      developerResult.action_id!==origin.action_id||
      developerResult.source.agent_id!=='dev-qwen-01'||
      developerResult.result.run_id!==origin.worker_run_id||
      developerResult.result.run_attempt!==origin.worker_run_attempt||
      developerResult.source.input_sha!==origin.worker_source_sha||
      developerResult.result.target_sha!==readback?.head_sha||
      developerResult.implementing_pr.number!==readback.pull_request||
      origin.publisher_run_id!==readback.publisher_run_id)
      fail('Qwen v2 is not bound to authenticated original Worker and PR');
  }else if(process.env.NODE_ENV!=='test'){
    fail('Qwen Publisher requires authenticated Developer v2 receipt');
  }
  if(typeof remote!=='string'||!remote||
      (process.env.NODE_ENV!=='test'&&
       !remote.startsWith('https://x-access-token:')))
    fail('separately scoped trusted Qwen Store writer required');
  const {temp,work}=openStoreRemote(remote);
  try{
    const applied=applyQwenPublisherReviewHandoff({
      storeRoot:work,readback,intent,registry});
    const written=developerResult===null?null:appendAuthenticatedResult(
      work,developerResult,{namespace:'producer-results-v2'});
    if(!applied.changed){
      if(written?.changed)
        fail('Qwen replay lacks committed Developer proof');
      return {...applied,replayed:true,commit_sha:null,
        producer_result_path:written?.path??null,
        producer_result_sha256:written?
          createHash('sha256').update(fs.readFileSync(path.join(work,written.path)))
            .digest('hex'):null};
    }
    git(work,['add','-A']);
    if(auditStagedRunStore(work,STORE_REF).checked_changes!==(written?.changed?3:2))
      fail('Qwen Publisher must CAS only state, head and versioned Developer v2');
    git(work,['-c','user.name=nession-agent-controller',
      '-c','user.email=nession-agent-controller@users.noreply.github.com',
      'commit','-m','agent-store: Qwen Publisher Review handoff Issue '+
        applied.issue]);
    if(onCandidate!==null){
      if(process.env.NODE_ENV!=='test')fail('test injection outside fixture');
      onCandidate();
    }
    const committed=publishStore(STORE_REF,work,4);
    return {...applied,replayed:committed.replayed,
      commit_sha:committed.commit_sha,
      producer_result_path:written?.path??null,
      producer_result_sha256:written?
        createHash('sha256').update(fs.readFileSync(path.join(work,written.path)))
          .digest('hex'):null};
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}


// A Repair is a verified non-force HEAD update of the ORIGINAL Qwen PR, not
// another PR or a model-selected SHA. Recheck immutable Store Intent before
// projecting the canonical same-Reviewer transition at SHA B.
export function applyQwenRepairPublisherReviewHandoff({
  storeRoot,readback,intent,registry,
}){
  const record=validateQwenRepairPublisherIntent(intent?.record);
  if(readback?.schema_version!==1||
      readback.kind!=='authenticated_qwen_repair_pr_receipt'||
      readback.status!=='same_pr_nonforce_update_readback_verified'||
      readback.issue!==record.issue||
      readback.action_id!==record.action_id||
      readback.worker_run_id!==record.worker_run_id||
      readback.worker_sha!==record.worker_sha||
      readback.publisher_run_id!==record.publisher_run_id||
      readback.intent_store_sha!==intent.store_commit_sha||
      readback.original_publisher_run_id!==record.original_publisher_run_id||
      readback.original_main_sha!==record.original_main_sha||
      readback.previous_sha!==record.source_sha||
      readback.branch!==record.branch||
      readback.patch_sha256!==record.patch_sha256||
      readback.checkpoint_commit_sha!==record.checkpoint_commit_sha||
      !Number.isSafeInteger(readback.pull_request)||
      readback.pull_request<1||!SHA.test(readback.head_sha??'')||
      readback.head_sha===record.source_sha||
      !SHA.test(readback.expected_tree_sha??'')||
      !Array.isArray(readback.files)||
      readback.files.length!==record.file_count)
    fail('Repair Store handoff needs exact independently read PR-B receipt');
  const loc=qwenRepairPublisherIntentPath(record);
  const full=path.join(storeRoot,loc);
  const stat=fs.lstatSync(full,{throwIfNoEntry:false});
  if(!stat?.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>8192)
    fail('Repair Store Intent is not a committed canonical file');
  let saved;
  try{saved=JSON.parse(fs.readFileSync(full,'utf8'));}
  catch{fail('invalid immutable Repair Intent');}
  if(JSON.stringify(saved)!==JSON.stringify(record)||
      !SHA.test(intent.store_commit_sha??''))
    fail('Repair Store Intent changed after original write-ahead');
  git(storeRoot,['merge-base','--is-ancestor',intent.store_commit_sha,'HEAD']);
  if(git(storeRoot,['log','-1','--format=%H','HEAD','--',loc])!==
      intent.store_commit_sha)
    fail('Repair Intent is not the exact committed Store author');
  const current=readIssueWorkflowState(storeRoot,record.issue);
  if(!current.state)fail('Repair source Issue State is absent');
  const event={kind:'publisher',issue:record.issue,outcome:'published',
    run_id:record.publisher_run_id,run_attempt:1,
    target_sha:readback.head_sha};
  const trusted={role:'publisher',workflow_run_id:record.publisher_run_id,
    attempt:1,issue:record.issue,source_sha:readback.head_sha,
    developer_action_id:record.action_id,
    developer_run_id:record.worker_run_id,developer_attempt:1,
    developer_source_sha:record.source_sha,
    checkpoint_commit_sha:record.checkpoint_commit_sha,
    original_publisher_run_id:record.original_publisher_run_id,
    pr_number:readback.pull_request,pr_previous_sha:record.source_sha};
  const next=acceptAttestedQwenRepairPublication(
    current.state,current.version,event,trusted,registry);
  if(next===current.state)return {changed:false,issue:record.issue,
    version:current.version,target_sha:current.state.target_sha};
  const written=writeIssueWorkflowState(storeRoot,next,current.version);
  const reviewer=next.outbox.filter(x=>x.status==='pending'&&
    x.task?.type==='dispatch'&&x.task?.role==='reviewer');
  if(reviewer.length!==1||reviewer[0].task.agent_id!=='review-qwen-01'||
      reviewer[0].task.sha!==readback.head_sha)
    fail('Repair publication did not yield one signed same-Reviewer Action');
  return {changed:written.changed,issue:record.issue,version:written.version,
    target_sha:next.target_sha,reviewer_action_id:reviewer[0].id,
    reviewer_agent_id:reviewer[0].task.agent_id};
}
export function applyQwenRepairPublicationToRemote({
  remote,readback,intent,registry,publishStore=publish,onCandidate=null,
}){
  if(typeof remote!=='string'||!remote||
      (process.env.NODE_ENV!=='test'&&
       !remote.startsWith('https://x-access-token:')))
    fail('Qwen Repair requires separately scoped trusted Store writer');
  const {temp,work}=openStoreRemote(remote);
  try{
    const applied=applyQwenRepairPublisherReviewHandoff({
      storeRoot:work,readback,intent,registry});
    if(!applied.changed)return {...applied,replayed:true,commit_sha:null};
    git(work,['add','-A']);
    if(auditStagedRunStore(work,STORE_REF).checked_changes!==2)
      fail('Repair Publisher may CAS only one Issue state and head');
    git(work,['-c','user.name=nession-agent-controller',
      '-c','user.email=nession-agent-controller@users.noreply.github.com',
      'commit','-m','agent-store: Qwen Repair same PR reviewer Issue '+
        applied.issue]);
    if(onCandidate!==null){
      if(process.env.NODE_ENV!=='test')fail('test injection outside fixture');
      onCandidate();
    }
    const committed=publishStore(STORE_REF,work,4);
    return {...applied,replayed:committed.replayed,
      commit_sha:committed.commit_sha};
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
