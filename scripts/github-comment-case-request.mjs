#!/usr/bin/env node
// Exact-source, main-owned Issue /case request planning and reauthentication.
// No comment may select an arbitrary ref, workflow, stage, runtime or platform.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { acceptancePlan, planStage } from './acceptance-plan.mjs';
import { isAcceptanceIssue, parsePreMergeIssueNumbers } from './requirement-acceptance.mjs';
import { parseCaseYaml, validateCaseManifest } from '../e2e/acceptance/contract/cases.mjs';

const REPO = 'BestNathan/nession';
const PREFIX = '/repos/' + REPO;
const SHA = /^[0-9a-f]{40}$/;
const MAX_PR_PAGES = 5;

export async function resolveCaseTarget(plan, issue, read) {
  if (plan?.handler !== 'case' || !/^SC-[0-9]{2,}$/.test(plan.criterion ?? '') ||
      issue?.number !== plan.issue_number || issue?.state !== 'open' ||
      issue?.pull_request || !isAcceptanceIssue(issue)) {
    throw Error('Case comment requires an open native Requirement/Bug Issue');
  }
  const entry = acceptancePlan(issue.body)?.get(plan.criterion);
  if (entry?.method !== 'case' || entry.when !== 'merged' ||
      !['staging', 'main'].includes(entry.branch)) {
    throw Error(plan.criterion + ' requires a merged staging/main method: case Acceptance Plan');
  }
  const stage = planStage(entry);
  const branch = entry.branch;
  const tip = await read(PREFIX + '/git/ref/heads/' + branch);
  const tipSha = tip?.object?.sha;
  if (!SHA.test(tipSha ?? '')) throw Error('unable to authenticate ' + branch + ' exact branch head');

  // Only the Issue-linked merge commit itself authorizes projection, never an
  // arbitrary branch tip, a PR HEAD or a comment-supplied SHA.
  for (let page = 1; page <= MAX_PR_PAGES; page += 1) {
    const prs = await read(PREFIX + '/pulls?state=closed&base=' + branch +
      '&sort=updated&direction=desc&per_page=100&page=' + page);
    if (!Array.isArray(prs) || prs.length > 100) throw Error('invalid bounded merged PR inventory');
    const matches = prs.filter(pr => pr?.merged_at && SHA.test(pr.merge_commit_sha ?? '') &&
      pr.base?.ref === branch &&
      parsePreMergeIssueNumbers(pr.body, 'BestNathan', 'nession', pr.title)
        .includes(plan.issue_number)).sort((a,b) =>
          Date.parse(b.merged_at) - Date.parse(a.merged_at));
    for (const pr of matches) {
      const targetSha = pr.merge_commit_sha;
      const ancestry = targetSha === tipSha ? 'exact' :
        await read(PREFIX + '/compare/' + targetSha + '...' + tipSha);
      if (ancestry !== 'exact' && !(ancestry?.status === 'ahead' &&
          ancestry?.base_commit?.sha === targetSha &&
          ancestry?.merge_base_commit?.sha === targetSha &&
          ancestry?.behind_by === 0 && ancestry?.ahead_by >= 1)) continue;
      const manifestPath = 'e2e/acceptance/cases/' + plan.issue_number + '/' +
        plan.criterion + '/case.yaml';
      let file;
      try {
        file = await read(PREFIX + '/contents/' + manifestPath + '?ref=' + targetSha);
      } catch (error) {
        if (/HTTP 404|status: 404/i.test(String(error))) continue;
        throw error;
      }
      if (file?.type !== 'file' || file?.encoding !== 'base64' ||
          typeof file.content !== 'string') throw Error('Case manifest content is not authenticated');
      const raw = Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');
      const manifest = validateCaseManifest(parseCaseYaml(raw, manifestPath));
      if (manifest.issue !== plan.issue_number ||
          manifest.criterion !== plan.criterion || manifest.stage !== stage) {
        throw Error('source Case manifest disagrees with Issue/SC/Acceptance stage');
      }
      // Both-platform Cases need independent native executions; selecting Linux
      // here never claims macOS proof or overrides the native combiner.
      return {
        ...plan, target_sha: targetSha, target_ref: '',
        stage, platform: manifest.platform === 'macos' ? 'macos' : 'linux',
        runtime_profile: manifest.runtime,
      };
    }
    if (prs.length < 100) break;
  }
  throw Error('no associated merged ' + branch + ' SHA with a source-aligned ' +
    plan.criterion + ' Case found in bounded PR history; cannot dispatch');
}

// Independent executor-side admission: a bot-dispatched workflow does not
// inherit permission from the bot. Re-read the original human comment and
// recompute the immutable target using trusted Main, before target checkout.
export async function verifyCaseComment({ issue_number, criterion, target_sha, stage,
  platform, runtime_profile, source_comment_id }, read) {
  const number = Number(issue_number), commentId = Number(source_comment_id);
  if (!Number.isSafeInteger(number) || number <= 0 ||
      !Number.isSafeInteger(commentId) || commentId <= 0 ||
      !/^SC-[0-9]{2,}$/.test(criterion) || !SHA.test(target_sha)) {
    throw Error('invalid source-bound Case comment identity');
  }
  const [comment, issue] = await Promise.all([
    read(PREFIX + '/issues/comments/' + commentId),
    read(PREFIX + '/issues/' + number),
  ]);
  if (comment?.body !== '/case ' + criterion ||
      comment?.user?.type !== 'User' ||
      !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment?.author_association) ||
      comment?.issue_url !== 'https://api.github.com' + PREFIX + '/issues/' + number ||
      (comment?.created_at && comment?.updated_at &&
        comment.created_at !== comment.updated_at)) {
    throw Error('original human Case comment is missing, edited or unauthorized');
  }
  const plan = await resolveCaseTarget({
    handler: 'case', issue_number: number, criterion, comment_id: commentId,
  }, issue, read);
  if (plan.target_sha !== target_sha || plan.stage !== stage ||
      plan.platform !== platform || plan.runtime_profile !== runtime_profile) {
    throw Error('Case dispatch inputs differ from reauthenticated original Issue/SC/merge SHA');
  }
  return plan;
}

async function api(path) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw Error('Case comment verification needs a GitHub token');
  const response = await fetch('https://api.github.com' + path, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw Error('GitHub GET ' + path + ': HTTP ' + response.status);
  return response.json();
}

async function selfTest() {
  const number = 42, criterion = 'SC-03', sha = 'a'.repeat(40), tipSha = 'b'.repeat(40);
  const issue = {
    number, state: 'open', labels: [{ name: 'requirement' }],
    body: '## Success Criteria\n- [ ] SC-03 Test\n\n## Acceptance Plan\n' +
      '```yaml\nacceptance:\n  SC-03:\n    when: merged\n    branch: staging\n    method: case\n```',
  };
  const manifest = [
    'schema_version: 1','issue: 42','criterion: SC-03','stage: staging',
    'runtime: full-stack-local','verifiers:','  - type: runtime',
    '    entry: verify.js','result_policy: all-pass','',
  ].join('\n');
  const pr = { merged_at: '2026-11-01T00:00:00Z', merge_commit_sha: sha,
    base: { ref: 'staging' }, title: 'fix: Refs #42', body: 'Refs #42' };
  const comment = { body: '/case SC-03', user: { type: 'User' },
    author_association: 'OWNER', created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    issue_url: 'https://api.github.com' + PREFIX + '/issues/42' };
  const reader = async path => {
    if (path.endsWith('/git/ref/heads/staging')) return { object: { sha: tipSha } };
    if (path.includes('/pulls?')) return [pr];
    if (path.includes('/compare/' + sha + '...' + tipSha)) return {
      status: 'ahead', base_commit: { sha }, merge_base_commit: { sha },
      ahead_by: 1, behind_by: 0,
    };
    if (path.includes('/contents/')) return {
      type: 'file', encoding: 'base64', content: Buffer.from(manifest).toString('base64'),
    };
    if (path.endsWith('/issues/comments/99')) return comment;
    if (path.endsWith('/issues/42')) return issue;
    throw Error('unexpected API request: ' + path);
  };
  const base = { handler: 'case', issue_number: number, criterion, comment_id: 99 };
  const good = await resolveCaseTarget(base, issue, reader);
  assert.deepEqual({ sha: good.target_sha, stage: good.stage,
    platform: good.platform, profile: good.runtime_profile },
  { sha, stage: 'staging', platform: 'linux', profile: 'full-stack-local' });
  const inputs = { issue_number: '42', criterion, target_sha: sha, stage: 'staging',
    platform: 'linux', runtime_profile: 'full-stack-local', source_comment_id: '99' };
  assert.equal((await verifyCaseComment(inputs, reader)).target_sha, sha);
  async function denied(fn, pattern) { await assert.rejects(fn, pattern); }
  await denied(() => verifyCaseComment({ ...inputs, target_sha: tipSha }, reader), /differ/);
  await denied(() => verifyCaseComment({ ...inputs, stage: 'post-merge' }, reader), /differ/);
  await denied(() => verifyCaseComment({ ...inputs, platform: 'macos' }, reader), /differ/);
  await denied(() => verifyCaseComment({ ...inputs, source_comment_id: 'bad' }, reader), /identity/);
  await denied(() => verifyCaseComment(inputs, async p =>
    p.endsWith('/issues/comments/99') ? { ...comment, body: '/accept' } : reader(p)), /missing, edited/);
  await denied(() => verifyCaseComment(inputs, async p =>
    p.endsWith('/issues/comments/99') ? { ...comment, updated_at: '2026-11-02T00:00:00Z' } :
      reader(p)), /missing, edited/);
  await denied(() => verifyCaseComment(inputs, async p =>
    p.endsWith('/issues/comments/99') ? { ...comment, user: { type: 'Bot' } } : reader(p)),
  /missing, edited/);
  await denied(() => verifyCaseComment(inputs, async p =>
    p.endsWith('/issues/comments/99') ? { ...comment, author_association: 'CONTRIBUTOR' } :
      reader(p)), /missing, edited/);
  await denied(() => resolveCaseTarget(base, { ...issue, state: 'closed' }, reader), /open native/);
  await denied(() => resolveCaseTarget(base, { ...issue, body: issue.body.replace('method: case', 'method: agent') }, reader),
    /requires a merged/);
  await denied(() => resolveCaseTarget(base, issue, async p => p.includes('/compare/')
    ? { status: 'diverged' } : reader(p)), /no associated merged/);
  await denied(() => resolveCaseTarget(base, issue, async p => p.includes('/pulls?')
    ? [{ ...pr, body: 'Refs #13', title: 'unrelated' }] : reader(p)), /no associated merged/);
  await denied(() => resolveCaseTarget(base, issue, async p => p.includes('/contents/')
    ? { type: 'file', encoding: 'base64',
      content: Buffer.from(manifest.replace('stage: staging','stage: pre-merge')).toString('base64') }
    : reader(p)), /manifest disagrees/);
  await denied(() => resolveCaseTarget(base, issue, async p => p.includes('/contents/')
    ? Promise.reject(Error('GitHub GET missing: HTTP 404')) : reader(p)), /no associated merged/);
  console.log('github-comment-case-request: exact merged-source selection, reauth and negatives passed');
}

const command = process.argv[2];
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (command === 'self-test') await selfTest();
  else if (command === 'verify') {
    if (process.argv.length !== 10) throw Error('usage: verify ISSUE CRITERION SHA STAGE RUNTIME PLATFORM COMMENT_ID');
    const [issue_number, criterion, target_sha, stage, runtime_profile, platform,
      source_comment_id] = process.argv.slice(3);
    await verifyCaseComment({ issue_number, criterion, target_sha, stage,
      runtime_profile, platform, source_comment_id }, api);
    console.log('authenticated original Case comment and exact merged source: verified');
  } else throw Error('usage: github-comment-case-request.mjs <self-test|verify ...>');
}
