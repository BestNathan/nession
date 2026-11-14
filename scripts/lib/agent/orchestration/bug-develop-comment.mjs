#!/usr/bin/env node
// #3488. Authoritative source inspection for the one owner-only Bug developer
// command. The comment is a request, never a trusted model/Store/PR instruction.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const REPO = 'BestNathan/nession';
const ORIGIN = 'https://api.github.com/repos/' + REPO;
export const DEVELOP_COMMAND = '/develop dev-qwen-01';
const positive = x => Number.isSafeInteger(x) && x > 0;

function deny(reason) { throw Error('Bug developer command: ' + reason); }

function linkedOpenPr(issueNumber, pr) {
  if (!pr || pr.state !== 'open' || pr.head?.repo?.full_name !== REPO)
    return false;
  const body = String(pr.body ?? '');
  const mention = new RegExp('(?:fix(?:es)?|clos(?:es)?|resolv(?:es)?|refs?|references)\\s+(?:BestNathan/nession)?#' +
    issueNumber + '(?![0-9])', 'i');
  return mention.test(body) ||
    new RegExp('(?:^|[/_-])' + issueNumber + '(?:[/_-]|$)').test(pr.head?.ref ?? '');
}

export function verifyBugDevelopSource(issue, comment, openPrs = []) {
  const n = issue?.number;
  if (!positive(n) || issue.state !== 'open' || issue.pull_request ||
      issue.repository_url !== ORIGIN ||
      !Array.isArray(issue.labels) ||
      !issue.labels.some(l => l.name === 'bug') ||
      issue.labels.some(l => l.name === 'status:in-progress'))
    deny('requires an open, unclaimed native Bug Issue');
  if (!positive(comment?.id) || comment?.body !== DEVELOP_COMMAND ||
      comment?.issue_url !== ORIGIN + '/issues/' + n ||
      comment?.user?.login !== 'BestNathan' || comment.user.type !== 'User' ||
      comment.author_association !== 'OWNER' ||
      !comment.created_at || comment.updated_at !== comment.created_at)
    deny('requires original unedited Owner comment');
  if (!Array.isArray(openPrs) || openPrs.some(p => linkedOpenPr(n, p)))
    deny('already has an open implementation PR');
  return Object.freeze({ issue: n, source_comment_id: comment.id, developer: 'dev-qwen-01' });
}

async function api(path) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (typeof token !== 'string' || token.length < 8) deny('missing read-only GitHub token');
  const response = await fetch('https://api.github.com' + path, {
    headers: { Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) deny('GitHub authority lookup failed (' + response.status + ')');
  return response.json();
}

export async function verifyLiveBugDevelopSource(issueNumber, commentId, reader = api) {
  if (!positive(issueNumber) || !positive(commentId)) deny('invalid Issue/comment ID');
  const [issue, comment, first] = await Promise.all([
    reader('/repos/' + REPO + '/issues/' + issueNumber),
    reader('/repos/' + REPO + '/issues/comments/' + commentId),
    reader('/repos/' + REPO + '/pulls?state=open&per_page=100&page=1'),
  ]);
  if (!Array.isArray(first) || first.length === 100)
    deny('open-PR inventory is incomplete; manual reconciliation required');
  return verifyBugDevelopSource(issue, comment, first);
}

function selfTest() {
  const issue = {number: 3433, state: 'open', repository_url: ORIGIN,
    labels: [{name: 'bug'}, {name: 'web'}] };
  const comment = {id: 123, body: DEVELOP_COMMAND,
    issue_url: ORIGIN + '/issues/3433', author_association: 'OWNER',
    user: {login: 'BestNathan', type: 'User'},
    created_at: '2026-11-14T01:00:00Z', updated_at: '2026-11-14T01:00:00Z'};
  assert.equal(verifyBugDevelopSource(issue, comment).developer, 'dev-qwen-01');
  for (const [i,c,p] of [
    [{...issue, state: 'closed'}, comment, []],
    [{...issue, pull_request: {url: 'pr'}}, comment, []],
    [{...issue, labels: [{name:'requirement'}]}, comment, []],
    [{...issue, labels: [...issue.labels, {name:'status:in-progress'}]}, comment, []],
    [issue, {...comment, body: DEVELOP_COMMAND + ' '}, []],
    [issue, {...comment, user: {login:'attacker',type:'User'}}, []],
    [issue, {...comment, author_association:'COLLABORATOR'}, []],
    [issue, {...comment, updated_at:'2026-11-14T01:00:01Z'}, []],
    [issue, {...comment, issue_url:ORIGIN+'/issues/2'}, []],
    [issue, comment, [{state:'open',body:'Fixes #3433',head:{repo:{full_name:REPO},ref:'fix/hi'}}]],
    [issue, comment, [{state:'open',body:'',head:{repo:{full_name:REPO},ref:'fix/3433-issue'}}]],
  ]) assert.throws(() => verifyBugDevelopSource(i,c,p), /Bug developer command:/);
  assert.equal(verifyBugDevelopSource(issue,comment,[{state:'closed',
    body:'Fixes #3433',head:{repo:{full_name:REPO}}}]).issue, 3433);
  console.log('bug-develop-comment: Owner-only, Bug-only, exact/unedited, PR-conflict and positive proofs passed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'self-test') selfTest();
  else if (process.argv[2] === 'verify' && process.argv.length === 5) {
    const issue = Number(process.argv[3]), comment = Number(process.argv[4]);
    verifyLiveBugDevelopSource(issue, comment)
      .then(x => console.log(JSON.stringify(x)))
      .catch(e => { console.error('::error::' + e.message); process.exitCode = 1; });
  } else deny('usage: self-test | verify ISSUE COMMENT');
}
