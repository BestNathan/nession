#!/usr/bin/env node
// Main-owned comment router. All domain evidence and mutations remain in their existing owners.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { commandPlan, parseCommand, workflowTitle, dispatchInputs } from './github-comment-command.mjs';
import { resolveCaseTarget } from './github-comment-case-request.mjs';
import { verifyLiveBugDevelopSource } from './lib/agent/orchestration/bug-develop-comment.mjs';

const REPO = 'BestNathan/nession';
const API = 'https://api.github.com';
async function api(path, { method = 'GET', body } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw Error('GitHub token missing');
  const response = await fetch(API + path, {
    method, headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw Error('GitHub ' + method + ' ' + path + ': HTTP ' + response.status);
  return response.status === 204 ? null : response.json();
}
function validEvent(event) {
  return event?.action === 'created' && event?.repository?.full_name === REPO &&
    process.env.GITHUB_REPOSITORY === REPO &&
    process.env.GITHUB_EVENT_NAME === 'issue_comment' &&
    process.env.GITHUB_ACTOR === event?.comment?.user?.login &&
    event?.sender?.login === process.env.GITHUB_ACTOR &&
    event?.comment?.user?.type === 'User' &&
    Number.isSafeInteger(event?.comment?.id) && event.comment.id > 0 &&
    Number.isSafeInteger(event?.issue?.number) && event.issue.number > 0;
}
export async function resolve(event, read = api) {
  if (!validEvent(event) || !parseCommand(event.comment.body)) return null;
  const id = event.comment.id, number = event.issue.number;
  const [comment, issue] = await Promise.all([
    read('/repos/' + REPO + '/issues/comments/' + id),
    read('/repos/' + REPO + '/issues/' + number),
  ]);
  if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment?.author_association)) return null;
  const isPr = Boolean(issue?.pull_request);
  let pr = null, permission = null;
  if (isPr) {
    pr = await read('/repos/' + REPO + '/pulls/' + number);
    permission = event.comment.user.login === 'BestNathan' &&
      comment.author_association === 'OWNER' ? 'admin' :
      (await read('/repos/' + REPO + '/collaborators/' +
        encodeURIComponent(event.comment.user.login) + '/permission')).permission;
  }
  const plan = commandPlan(event, comment, issue, pr, permission);
  if (plan?.handler === 'develop') {
    // The same source verifier runs again inside Store Ingest. This is a
    // read-only, early rejection; it grants no Developer/Store authority.
    await verifyLiveBugDevelopSource(number, id, read);
  }
  return plan?.handler === 'case' ? resolveCaseTarget(plan, issue, read) : plan;
}
function outputs(plan) {
  if (!process.env.GITHUB_OUTPUT) throw Error('GITHUB_OUTPUT missing');
  if (!plan) return;
  for (const [key, value] of Object.entries({
    handler: plan.handler, issue_number: plan.issue_number, comment_id: plan.comment_id,
    target_sha: plan.target_sha ?? '', target_ref: plan.target_ref ?? '',
    criterion: plan.criterion ?? '', stage: plan.stage ?? '',
    platform: plan.platform ?? '', runtime_profile: plan.runtime_profile ?? '',
  })) {
    if (!/^[a-z_]+$/.test(key) || /[\r\n]/.test(String(value))) throw Error('invalid output');
    appendFileSync(process.env.GITHUB_OUTPUT, key + '=' + value + '\n');
  }
}
function matchesPlan(plan) {
  return plan && plan.handler === process.env.EXPECTED_HANDLER &&
    String(plan.issue_number) === process.env.EXPECTED_ISSUE &&
    String(plan.comment_id) === process.env.EXPECTED_COMMENT &&
    (plan.target_sha ?? '') === (process.env.EXPECTED_SHA ?? '') &&
    (plan.target_ref ?? '') === (process.env.EXPECTED_REF ?? '') &&
    (plan.criterion ?? '') === (process.env.EXPECTED_CRITERION ?? '') &&
    (plan.stage ?? '') === (process.env.EXPECTED_STAGE ?? '') &&
    (plan.platform ?? '') === (process.env.EXPECTED_PLATFORM ?? '') &&
    (plan.runtime_profile ?? '') === (process.env.EXPECTED_RUNTIME_PROFILE ?? '');
}
function findRun(runs, plan) {
  return runs.find(r => r.display_title === workflowTitle(plan) &&
    r.event === 'workflow_dispatch' && r.head_branch === 'main' &&
    r.repository?.full_name === REPO && r.head_repository?.full_name === REPO);
}
async function inventory(read, plan) {
  const data = await read('/repos/' + REPO + '/actions/workflows/' +
    plan.workflow + '/runs?event=workflow_dispatch&per_page=100');
  if (!Array.isArray(data?.workflow_runs)) throw Error('bad run inventory');
  return data.workflow_runs;
}
function marker(plan) { return '<!-- nession-command-comment:' + plan.comment_id + ' -->'; }
async function acknowledge(read, plan, link) {
  const target = plan.kind === 'pull_request'
    ? 'PR #' + plan.issue_number + ' at ' + plan.target_sha
    : 'Issue #' + plan.issue_number +
      (plan.handler === 'case' ? ' / ' + plan.criterion + ' at ' + plan.target_sha : '');
  const body = 'Comment command ' + String.fromCharCode(96) + plan.command +
    String.fromCharCode(96) + ' accepted for ' + target +
    '. [Actions run](' + link + '). This request is not an Acceptance Pass or proof that a Developer has started.\n\n' + marker(plan);
  await read('/repos/' + REPO + '/issues/' + plan.issue_number + '/comments',
    { method: 'POST', body: { body } });
}
async function dispatch(plan, read = api) {
  const comments = await read('/repos/' + REPO + '/issues/' +
    plan.issue_number + '/comments?per_page=100&sort=created&direction=desc');
  if (!Array.isArray(comments)) throw Error('bad comment inventory');
  if (comments.some(c => c?.body?.includes(marker(plan)) &&
      c?.user?.type === 'Bot' && c?.user?.login === 'github-actions[bot]'))
    return { state: 'already-acknowledged' };
  const runs = await inventory(read, plan);
  const previous = findRun(runs, plan);
  if (previous) {
    // Recovery after dispatch succeeded but the acknowledgment POST failed:
    // repair the receipt without spending model/Full quota a second time.
    await acknowledge(read, plan, previous.html_url);
    return { state: 'already-dispatched', url: previous.html_url };
  }
  // A full page is safe for a freshly created command only when its oldest
  // item precedes the source comment. Otherwise history may hide a replay.
  const since = Date.parse(plan.created_at);
  if ((runs.length === 100 && !(Date.parse(runs.at(-1)?.created_at) < since)) ||
      (comments.length === 100 && !(Date.parse(comments.at(-1)?.created_at) < since)))
    throw Error('bounded run/comment inventory exhausted; reconcile manually');
  await read('/repos/' + REPO + '/actions/workflows/' + plan.workflow + '/dispatches', {
    method: 'POST', body: { ref: 'main', inputs: dispatchInputs(plan) },
  });
  let run = null;
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 1500));
    run = findRun(await inventory(read, plan), plan);
    if (run) break;
  }
  const link = run?.html_url ||
    'https://github.com/' + REPO + '/actions/workflows/' + plan.workflow;
  await acknowledge(read, plan, link);
  return { state: 'dispatched', url: link };
}
async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const plan = await resolve(event);
  if (process.argv[2] === 'resolve') {
    outputs(plan);
    console.log(plan ? 'authorized command ' + plan.handler + ' #' + plan.issue_number :
      'ignored unsupported/unauthorized/stale comment');
    return;
  }
  if (process.argv[2] !== 'dispatch') throw Error('unknown command');
  if (!matchesPlan(plan)) throw Error('command changed since initial plan; refusing stale request');
  const outcome = await dispatch(plan);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '## Comment command\n- Request: ' + plan.request_id +
      '\n- Target: ' + (plan.target_sha ?? 'Issue #' + plan.issue_number) +
      '\n- Result: ' + outcome.state + '\n- Link: ' + (outcome.url || 'already acknowledged') + '\n');
  console.log(JSON.stringify(outcome));
}
async function selfTest() {
  const repo = { full_name: REPO }, user = { login: 'BestNathan', type: 'User' };
  const issue = { number: 17, state: 'open', repository_url: API + '/repos/' + REPO };
  const comment = { id: 88, body: '/audit', issue_url: issue.repository_url + '/issues/17',
    author_association: 'OWNER', user };
  const event = { action: 'created', repository: repo, sender: user,
    issue: { number: 17 }, comment: { id: 88, body: '/audit', user } };
  const env = { GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: 'issue_comment',
    GITHUB_ACTOR: user.login };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const fake = async path => {
      if (path.endsWith('/issues/comments/88')) return comment;
      if (path.endsWith('/issues/17')) return issue;
      throw Error('unexpected lookup ' + path);
    };
    const plan = await resolve(event, fake);
    assert.equal(plan.handler, 'audit');
    assert.equal(await resolve({ ...event, sender: { login: 'attacker' } }, fake), null);
    assert.equal(await resolve({ ...event,
      comment: { ...event.comment, body: '/audit tree' } }, fake), null);
    const pr = { number: 17, state: 'open',
      head: { sha: 'a'.repeat(40), ref: 'feat/example', repo },
      base: { sha: 'b'.repeat(40), ref: 'staging' } };
    const prEvent = { ...event, issue: { ...event.issue, pull_request: {} },
      comment: { ...event.comment, body: '/e2e full' } };
    const read = async path => {
      if (path.endsWith('/issues/comments/88')) return { ...comment, body: '/e2e full' };
      if (path.endsWith('/issues/17')) return { ...issue, pull_request: {} };
      if (path.endsWith('/pulls/17')) return pr;
      throw Error('unexpected lookup ' + path);
    };
    assert.equal((await resolve(prEvent, read)).target_sha, pr.head.sha);
    const run = { display_title: workflowTitle(plan), event: 'workflow_dispatch',
      head_branch: 'main', repository: repo, head_repository: repo,
      html_url: 'https://github.com/BestNathan/nession/actions/runs/22' };
    let receiptsWritten = 0, redundantDispatches = 0;
    const recovered = await dispatch(plan, async (path, options = {}) => {
      if (options.method === 'POST') {
        if (path.endsWith('/dispatches')) redundantDispatches += 1;
        else if (path.endsWith('/comments')) receiptsWritten += 1;
        return {};
      }
      return path.endsWith('/comments?per_page=100&sort=created&direction=desc')
        ? [] : { workflow_runs: [run] };
    });
    assert.equal(recovered.state, 'already-dispatched');
    assert.equal(receiptsWritten, 1, 'missing receipt must be recovered');
    assert.equal(redundantDispatches, 0, 'replay cannot schedule another Full run');
    assert.equal((await dispatch(plan, async path => path.endsWith('/comments?per_page=100&sort=created&direction=desc')
      ? [{ body: marker(plan), user: { login: 'github-actions[bot]', type: 'Bot' } }]
      : { workflow_runs: [] })).state, 'already-acknowledged');
    console.log('github-comment-router: source checks, context, replay guards passed');
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'self-test') await selfTest(); else await main();
}
