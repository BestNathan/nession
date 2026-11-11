#!/usr/bin/env node
// Reconstruct the *original* trusted GitHub Issue comment for domain work.
// workflow_dispatch's bot actor is never treated as the author of /audit or /accept.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseCommand } from './github-comment-command.mjs';
import { resolveAcceptComment } from './issue-lifecycle-reconcile.mjs';

const REPO = 'BestNathan/nession';
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export function verifiedSource(kind, repository, issueNumber, commentId, issue, comment) {
  const expected = kind === 'audit' ? 'audit' : kind === 'accept' ? 'accept' : null;
  if (!expected) throw Error('unknown trusted command kind');
  if (repository !== REPO || !Number.isSafeInteger(issueNumber) || issueNumber < 1 ||
      !Number.isSafeInteger(commentId) || commentId < 1) throw Error('invalid source identity');
  if (issue?.number !== issueNumber || issue.state !== 'open' || issue.pull_request ||
      issue.repository_url !== 'https://api.github.com/repos/' + REPO) throw Error('source is not an open native Issue');
  const command = parseCommand(comment?.body);
  if (command?.handler !== expected ||
      comment.id !== commentId ||
      comment.issue_url !== issue.repository_url + '/issues/' + issueNumber ||
      comment.user?.type !== 'User' || typeof comment.user?.login !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(comment.user.login) ||
      !TRUSTED.has(comment.author_association)) throw Error('unauthorized source comment');
  return {
    action: 'created',
    repository: { full_name: REPO },
    issue: { number: issueNumber, state: 'open' },
    sender: { login: comment.user.login },
    comment: {
      id: commentId, body: comment.body,
      author_association: comment.author_association,
      user: { type: 'User', login: comment.user.login },
    },
  };
}
async function api(path) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw Error('missing read-only Github token');
  const response = await fetch('https://api.github.com' + path, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw Error('GitHub source lookup failed: ' + path + ' [' + response.status + ']');
  return response.json();
}
async function materialize() {
  const [kind, issueValue, commentValue, output] = process.argv.slice(3);
  const issueNumber = Number(issueValue), commentId = Number(commentValue);
  if (!Number.isSafeInteger(issueNumber) || !Number.isSafeInteger(commentId) || !output ||
      process.env.GITHUB_REPOSITORY !== REPO ||
      process.env.GITHUB_ACTOR !== 'github-actions[bot]' ||
      process.env.GITHUB_REF !== 'refs/heads/main') throw Error('untrusted command dispatcher');
  const [issue, comment] = await Promise.all([
    api('/repos/' + REPO + '/issues/' + issueNumber),
    api('/repos/' + REPO + '/issues/comments/' + commentId),
  ]);
  const event = verifiedSource(kind, REPO, issueNumber, commentId, issue, comment);
  writeFileSync(output, JSON.stringify(event), { mode: 0o600 });
  console.log('Reconstructed authorized ' + kind + ' request for Issue #' + issueNumber + ', comment ' + commentId);
}
function selfTest() {
  const issue = { number: 9, state: 'open', repository_url: 'https://api.github.com/repos/' + REPO };
  const comment = { id: 99, issue_url: issue.repository_url + '/issues/9',
    body: '/audit tree', user: { type: 'User', login: 'maintainer' }, author_association: 'COLLABORATOR' };
  assert.equal(verifiedSource('audit', REPO, 9, 99, issue, comment).comment.body, '/audit tree');
  assert.equal(verifiedSource('accept', REPO, 9, 99, issue, { ...comment, body: '/accept' }).sender.login, 'maintainer');
  const authorizedAccept = verifiedSource('accept', REPO, 9, 99, issue, { ...comment, body: '/accept' });
  assert.equal(resolveAcceptComment(authorizedAccept, REPO, authorizedAccept.sender.login).commentId, 99);
  assert.equal(resolveAcceptComment(authorizedAccept, REPO, 'github-actions[bot]'), null,
    'a bot-dispatched request cannot substitute its bot actor for the verified human');
  for (const change of [
    { comment: { ...comment, body: '/audit\nextra' } },
    { comment: { ...comment, body: '/accept' } },
    { comment: { ...comment, author_association: 'CONTRIBUTOR' } },
    { comment: { ...comment, user: { login: 'github-actions[bot]', type: 'Bot' } } },
    { comment: { ...comment, issue_url: issue.repository_url + '/issues/8' } },
    { issue: { ...issue, pull_request: { url: 'pr' } } },
    { issue: { ...issue, state: 'closed' } },
  ]) assert.throws(() => verifiedSource('audit', REPO, 9, 99,
    change.issue || issue, change.comment || comment), /unauthorized|not an open/);
  console.log('github-comment-source: source-bound Audit/Acceptance positive and hostile fixtures passed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === 'self-test') selfTest();
  else if (mode === 'materialize') await materialize();
  else throw Error('Usage: github-comment-source.mjs <self-test|materialize kind issue_number comment_id output>');
}
