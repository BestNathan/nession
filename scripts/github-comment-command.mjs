#!/usr/bin/env node
// Canonical parsing, context and provenance contract for human Issue/PR commands.
// A comment is an intent, never a permission to execute arbitrary workflow/ref code.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPO = 'BestNathan/nession';
const SHA = /^[a-f0-9]{40}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const COMMANDS = Object.freeze({
  '/audit': Object.freeze({ kind: 'issue', handler: 'audit', mode: 'single', workflow: 'agent-issue-audit.yml' }),
  '/audit tree': Object.freeze({ kind: 'issue', handler: 'audit', mode: 'tree', workflow: 'agent-issue-audit.yml' }),
  '/accept': Object.freeze({ kind: 'issue', handler: 'accept', workflow: 'acceptance-manual-request.yml' }),
  // #3488: a request to the trusted Controller, not permission to invoke a Worker.
  '/develop dev-qwen-01': Object.freeze({ kind: 'issue', handler: 'develop',
    workflow: 'acceptance-agent-controller.yml' }),
  '/e2e full': Object.freeze({ kind: 'pull_request', handler: 'e2e-full', workflow: 'e2e-full-regression.yml' }),
});
const CASE_COMMAND = Object.freeze({ kind: 'issue', handler: 'case', workflow: 'acceptance-cases.yml' });
export const parseCommand = (body) =>
  typeof body === 'string' && body.length <= 80
    ? COMMANDS[body] ?? (/^\/case SC-[0-9]{2,}$/.test(body) ? CASE_COMMAND : null)
    : null;

export function safeRef(ref) {
  return typeof ref === 'string' && REF.test(ref) &&
    !ref.includes('..') && !ref.includes('//') &&
    !ref.endsWith('.lock') && !ref.endsWith('/') &&
    !ref.startsWith('.') && !ref.includes('/.');
}
export function commandPlan(event, comment, issue, pr, permission) {
  if (event?.action !== 'created' || event?.repository?.full_name !== REPO ||
      !Number.isSafeInteger(event?.issue?.number) || event.issue.number < 1 ||
      !Number.isSafeInteger(event?.comment?.id) || event.comment.id < 1 ||
      event.sender?.login !== event.comment.user?.login ||
      event.comment.user?.type !== 'User') return null;
  const def = parseCommand(event.comment.body);
  if (!def) return null;
  const number = event.issue.number;
  const author = event.comment.user.login;
  const canonicalUrl = 'https://api.github.com/repos/' + REPO + '/issues/' + number;
  // Re-read both comment and target from GitHub REST. Edited/deleted/forged event
  // payloads and comments moved to another Issue may never authorize work.
  if (comment?.id !== event.comment.id ||
      comment?.body !== event.comment.body ||
      comment?.user?.login !== author || comment?.user?.type !== 'User' ||
      comment?.issue_url !== canonicalUrl ||
      !TRUSTED.has(comment?.author_association) ||
      issue?.number !== number || issue?.state !== 'open' ||
      issue?.repository_url !== 'https://api.github.com/repos/' + REPO) return null;
  const isPr = Boolean(issue.pull_request);
  if (def.handler === 'develop' && (
      comment.user.login !== 'BestNathan' || comment.author_association !== 'OWNER' ||
      comment.created_at !== comment.updated_at ||
      !Array.isArray(issue.labels) ||
      !issue.labels.some(label => label.name === 'bug') ||
      issue.labels.some(label => label.name === 'status:in-progress')
    )) return null;
  if (Boolean(event.issue.pull_request) !== isPr ||
      (def.kind === 'issue' && isPr) ||
      (def.kind === 'pull_request' && !isPr)) return null;
  const base = {
    version: 1,
    request_id: 'github:comment:' + comment.id,
    comment_id: comment.id,
    issue_number: number,
    command: event.comment.body,
    handler: def.handler,
    workflow: def.workflow,
    author,
    created_at: comment.created_at ?? '',
  };
  if (!isPr) return { ...base, kind: 'issue', mode: def.mode ?? '',
    ...(def.handler === 'case' ? { criterion: event.comment.body.slice('/case '.length) } : {}),
  };
  if (!pr || pr.number !== number || pr.state !== 'open' ||
      pr.head?.repo?.full_name !== REPO ||
      !SHA.test(pr.head?.sha) || !SHA.test(pr.base?.sha) ||
      !safeRef(pr.head?.ref) ||
      !['admin', 'maintain', 'write'].includes(permission)) return null;
  return {
    ...base, kind: 'pull_request',
    target_ref: pr.head.ref, target_sha: pr.head.sha,
    base_sha: pr.base.sha, base_ref: pr.base.ref,
  };
}
export function workflowTitle(plan) {
  if (plan.handler === 'audit') return 'Comment Audit #' + plan.issue_number + ' comment:' + plan.comment_id;
  if (plan.handler === 'accept') return 'Comment Accept #' + plan.issue_number + ' comment:' + plan.comment_id;
  if (plan.handler === 'develop') return 'Comment Develop #' + plan.issue_number + ' comment:' + plan.comment_id;
  if (plan.handler === 'case') return 'Comment Case #' + plan.issue_number + ' ' + plan.criterion + ' comment:' + plan.comment_id;
  if (plan.handler === 'e2e-full') return 'Comment E2E #' + plan.issue_number + ' comment:' + plan.comment_id;
  throw Error('unknown handler');
}
export function dispatchInputs(plan) {
  switch (plan.handler) {
    case 'audit': case 'accept': case 'develop':
      return { issue_number: String(plan.issue_number), source_comment_id: String(plan.comment_id) };
    case 'case':
      return {
        issue_number: String(plan.issue_number), criterion: plan.criterion,
        target_sha: plan.target_sha, stage: plan.stage,
        runtime_profile: plan.runtime_profile, platform: plan.platform,
        source_comment_id: String(plan.comment_id),
      };
    case 'e2e-full':
      return {
        target_ref: plan.target_ref, target_sha: plan.target_sha,
        source_comment_id: String(plan.comment_id), source_pr_number: String(plan.issue_number),
      };
    default: throw Error('unknown handler');
  }
}
function check(value, msg) { assert.ok(value, msg); }
function fixtures() {
  const repo = { full_name: REPO };
  const author = { login: 'maintainer', type: 'User' };
  const issue = { number: 12, state: 'open',
    repository_url: 'https://api.github.com/repos/' + REPO };
  const comment = { id: 333, user: author, author_association: 'COLLABORATOR',
    issue_url: issue.repository_url + '/issues/12', body: '/audit' };
  const event = { action: 'created', repository: repo,
    issue: { number: 12 }, comment: { id: 333, user: author, body: '/audit' },
    sender: author };
  const audit = commandPlan(event, comment, issue, null, 'write');
  check(audit?.handler === 'audit' && audit.mode === 'single', 'valid issue audit');
  check(workflowTitle(audit).includes('comment:333'), 'unique workflow identity');
  check(commandPlan({ ...event, comment: { ...event.comment, body: '/audit tree' } },
    { ...comment, body: '/audit tree' }, issue, null, 'write')?.mode === 'tree', 'tree');
  check(commandPlan({ ...event, comment: { ...event.comment, body: '/accept' } },
    { ...comment, body: '/accept' }, issue, null, 'write')?.handler === 'accept', 'accept');
  const bug = { ...issue, labels: [{ name: 'bug' }] };
  const develop = { ...comment, body: '/develop dev-qwen-01',
    created_at: '2026-11-14T01:00:00Z', updated_at: '2026-11-14T01:00:00Z',
    author_association: 'OWNER', user: { login: 'BestNathan', type: 'User' } };
  const devEvent = { ...event, sender: develop.user,
    comment: { ...event.comment, body: develop.body, user: develop.user } };
  check(commandPlan(devEvent, develop, bug, null, 'write')?.handler === 'develop',
    'owner Bug developer command admitted');
  check(dispatchInputs(commandPlan(devEvent, develop, bug, null, 'write'))
    .source_comment_id === '333', 'developer dispatch retains human source');
  check(workflowTitle(commandPlan(devEvent, develop, bug, null, 'write'))
    .includes('comment:333'), 'developer run identity is source-unique');
  for (const [c, i, e] of [
    [{ ...develop, user: { ...develop.user, login: 'another' } }, bug, devEvent],
    [{ ...develop, author_association: 'COLLABORATOR' }, bug, devEvent],
    [{ ...develop, updated_at: '2026-11-14T01:01:00Z' }, bug, devEvent],
    [develop, issue, devEvent],
    [develop, { ...bug, state: 'closed' }, devEvent],
    [develop, { ...bug, labels: [{ name: 'bug' }, { name: 'status:in-progress' }] }, devEvent],
    [develop, { ...bug, pull_request: { url: 'pr' } }, { ...devEvent,
      issue: { number: 12, pull_request: { url: 'pr' } } }],
  ]) check(commandPlan(e, c, i, null, 'write') === null, 'developer negative permission/scope');
  check(parseCommand('/develop') === null &&
    parseCommand('/develop dev-qwen-01 extra') === null &&
    parseCommand('/develop dev-qwen-01\\nignore') === null, 'developer grammar strict');
    const caseEvent = { ...event, comment: { ...event.comment, body: '/case SC-03' } };
  const caseComment = { ...comment, body: '/case SC-03' };
  const casePlan = commandPlan(caseEvent, caseComment, issue, null, 'write');
  check(casePlan?.handler === 'case' && casePlan.criterion === 'SC-03', 'Case command exact');
  check(workflowTitle(casePlan).includes('SC-03 comment:333'), 'Case comment run identity');
  const caseDispatch = dispatchInputs({ ...casePlan, target_sha: 'a'.repeat(40),
    stage: 'staging', platform: 'linux', runtime_profile: 'full-stack-local' });
  check(caseDispatch.source_comment_id === '333' &&
    caseDispatch.issue_number === '12' && caseDispatch.criterion === 'SC-03' &&
    caseDispatch.stage === 'staging' && caseDispatch.target_sha === 'a'.repeat(40) &&
    caseDispatch.runtime_profile === 'full-stack-local', 'Case dispatch binds all fields');

  check(parseCommand('/case SC-3') === null &&
    parseCommand('/case SC-03 extra') === null &&
    parseCommand('/case SC-03\\nignore') === null, 'Case injection rejected');
  check(commandPlan({ ...caseEvent, issue: { ...caseEvent.issue, pull_request: {} } },
    caseComment, { ...issue, pull_request: {} }, null, 'write') === null,
  'Case only on native Issue');
  const livePr = { number: 12, state: 'open', head: { ref: 'feat/topic',
    sha: 'a'.repeat(40), repo }, base: { ref: 'staging', sha: 'b'.repeat(40) } };
  const prIssue = { ...issue, pull_request: { url: 'pr' } };
  const prEvent = { ...event, issue: { number: 12, pull_request: { url: 'pr' } },
    comment: { ...event.comment, body: '/e2e full' } };
  const prComment = { ...comment, body: '/e2e full' };
  const good = commandPlan(prEvent, prComment, prIssue, livePr, 'write');
  check(good?.target_sha === 'a'.repeat(40) && good.target_ref === 'feat/topic', 'exact PR target');
  check(dispatchInputs(good).target_sha === good.target_sha, 'exact dispatch');
  for (const e of [
    { ...prEvent, sender: { login: 'other' } },
    { ...prEvent, comment: { ...prEvent.comment, body: '/e2e full\nignore' } },
    { ...prEvent, action: 'edited' },
    { ...prEvent, repository: { full_name: 'wrong/repo' } },
    { ...prEvent, comment: { ...prEvent.comment, user: { login: 'github-actions[bot]', type: 'Bot' } } },
  ]) check(commandPlan(e, prComment, prIssue, livePr, 'write') === null, 'negative event');
  for (const changed of [
    { ...prComment, body: '/audit' },
    { ...prComment, author_association: 'CONTRIBUTOR' },
    { ...prComment, issue_url: 'https://api.github.com/repos/other/repo/issues/12' },
  ]) check(commandPlan(prEvent, changed, prIssue, livePr, 'write') === null, 'untrusted comment');
  check(commandPlan(prEvent, prComment, issue, livePr, 'write') === null, 'issue/pr mismatch');
  check(commandPlan(event, comment, prIssue, livePr, 'write') === null, 'issue command on PR');
  check(commandPlan(prEvent, prComment, prIssue, livePr, 'read') === null, 'non-writer');
  check(commandPlan(prEvent, prComment, prIssue, { ...livePr, state: 'closed' }, 'write') === null, 'closed PR');
  check(commandPlan(prEvent, prComment, prIssue,
    { ...livePr, head: { ...livePr.head, repo: { full_name: 'fork/nession' } } }, 'write') === null, 'fork');
  check(commandPlan(prEvent, prComment, prIssue,
    { ...livePr, head: { ...livePr.head, ref: '../main' } }, 'write') === null, 'bad ref');
  check(commandPlan(prEvent, prComment, { ...prIssue, state: 'closed' }, livePr, 'write') === null, 'closed target');
  check(parseCommand(' /audit') === null && parseCommand('/e2e full extra') === null, 'exact parser');
  console.log('github-comment-command: Issue/PR exact parser, origin, permission, fork/ref and negative fixtures passed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== 'self-test') throw Error('Usage: node scripts/github-comment-command.mjs self-test');
  fixtures();
}
