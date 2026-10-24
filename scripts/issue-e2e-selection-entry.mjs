#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
// Deterministic adapter: Issue JSONs are fetched read-only by the workflow.
// This script never edits Issues or invokes an Agent for test selection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildGitPlan } from './issue-e2e-plan.mjs';
import { parsePreMergeIssueNumbers } from './requirement-acceptance.mjs';

const SHA = /^[a-f0-9]{40}$/;

// Only a positively identified metadata-only diff may suppress a legacy
// full E2E plan. Everything else (including an unavailable/unreadable diff,
// unknown file type, or E2E/Case workflow change) remains fail-closed/full.
export function pathsCannotAffectE2E(paths) {
  return Array.isArray(paths) && paths.length > 0 && paths.every(file =>
    typeof file === 'string' && (
      file.endsWith('.md') ||
      (file.startsWith('.github/workflows/') &&
        !/^\.github\/workflows\/(e2e-|acceptance-case-|ci-web-dist-reuse-proof)/.test(file))
    ));
}
function hasVerifiedMetadataOnlyDiff(repoRoot, baseSha, headSha) {
  try {
    const options = { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] };
    // Trusted checkout must be the exact PR head; never use GitHub's synthetic
    // merge ref or infer a "skip" from an unavailable base commit.
    if (execFileSync('git', ['rev-parse','HEAD'], options).trim() !== headSha)
      return false;
    // Disallow rename detection so a runtime->docs rename exposes BOTH paths.
    const names = execFileSync('git',
      ['diff','--no-renames','--name-only','-z',baseSha,headSha], options)
      .split('\0').filter(Boolean);
    return pathsCannotAffectE2E(names);
  } catch {
    return false; // fail closed to the existing full E2E fallback
  }
}
function currentBaseSha(repoRoot, baseRef) {
  if (typeof baseRef !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baseRef) ||
      baseRef.includes('..') || baseRef.includes('@{') || baseRef.endsWith('.lock')) {
    throw new Error('invalid PR base branch ref');
  }
  const remoteRef = 'refs/remotes/origin/' + baseRef;
  let sha;
  try {
    sha = execFileSync('git', ['rev-parse', '--verify', remoteRef + '^{commit}'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error('current PR base ref is unavailable: ' + remoteRef);
  }
  if (!SHA.test(sha)) throw new Error('current PR base ref did not resolve to an exact SHA');
  return sha;
}
export function prepare(event, issues, repoRoot) {
  const pr = event?.pull_request;
  if (event?.repository?.full_name !== 'BestNathan/nession' || !pr ||
      !SHA.test(pr.head?.sha) || !SHA.test(pr.base?.sha) ||
      pr.head?.repo?.full_name !== 'BestNathan/nession')
    throw Error('invalid PR/source identity');
  const refs = parsePreMergeIssueNumbers(pr.body, 'BestNathan', 'nession', pr.title);
  const listed = new Set(refs);
  for (const issue of issues) {
    if (!listed.has(issue.number) ||
        !(event.source_event === 'push' ? ['open','OPEN','closed','CLOSED'].includes(issue.state) : ['open','OPEN'].includes(issue.state)))
      throw Error('unrelated or closed Issue in test plan');
  }
  // pull_request.base.sha is an event snapshot and can lag when the target
  // branch advances. Checkout(fetch-depth: 0) provides the current remote
  // target ref; bind the plan to that immutable SHA rather than the stale
  // webhook base or merge-base.
  const baseSha = currentBaseSha(repoRoot, pr.base.ref);
  if (baseSha === pr.head.sha) throw Error('current PR base and head SHA are identical');
  if (!issues.length || issues.some(i => !i.body?.includes('## E2E Verification'))) {
    const noImpact = hasVerifiedMetadataOnlyDiff(repoRoot, baseSha, pr.head.sha);
    return { schema_version:1, kind:'issue_e2e_selection', pr_number:pr.number,
      target_sha:pr.head.sha, base_sha:baseSha,
      mode:noImpact ? 'not-required' : 'unresolved',
      reason:noImpact ? 'verified-metadata-only-diff' : 'missing-scoped-e2e-obligation-needs-audit',
      selected:[], issues:[] };
  }
  return { ...buildGitPlan(repoRoot,issues,baseSha,pr.head.sha),pr_number:pr.number };
}
function selfTest() {
  const event = { repository:{full_name:'BestNathan/nession'},pull_request:{
    number:17, title:'Refs #1702', body:'Refs #1702',
    head:{sha:'a'.repeat(40),repo:{full_name:'BestNathan/nession'}},
    base:{sha:'b'.repeat(40),ref:'staging'} }};
  assert.equal(pathsCannotAffectE2E(['docs/architecture/notes.md']), true);
  assert.equal(pathsCannotAffectE2E(['.github/workflows/agent-controller-dispatch.yml']), true);
  assert.equal(pathsCannotAffectE2E(['.github/workflows/ci-quality.yml','README.md']), true);
  for (const paths of [
    [], ['crates/nession-server/src/lib.rs'], ['web/src/App.tsx'],
    ['e2e/tests/browser/login.spec.ts'], ['scripts/issue-e2e-plan.mjs'],
    ['.github/workflows/e2e-tests.yml'],
    ['.github/workflows/e2e-test-ingest.yml'],
    ['.github/workflows/acceptance-case-smoke.yml'],
    ['.github/workflows/ci-web-dist-reuse-proof.yml'],
    ['docs/notes.md','crates/nession-agent/src/lib.rs'],
  ]) assert.equal(pathsCannotAffectE2E(paths), false,
    'a runtime or unrecognized input must never suppress full E2E');
  // Real temporary Git history proves the exact-head diff gate (including a
  // renamed runtime file), not just the pure path allowlist.
  const tmp = fs.mkdtempSync(join(tmpdir(), 'nession-issue-e2e-impact-'));
  try {
    const git = (...args) => execFileSync('git', args,
      { cwd:tmp, encoding:'utf8', stdio:['ignore','pipe','ignore'] }).trim();
    git('init','-q');
    git('config','user.name','CI Fixture');
    git('config','user.email','ci@example.invalid');
    fs.writeFileSync(join(tmp,'README.md'), '# Fixture\\n');
    git('add','.');
    git('commit','-qm','baseline');
    const base = git('rev-parse','HEAD');
    git('update-ref','refs/remotes/origin/staging',base);
    fs.mkdirSync(join(tmp,'.github','workflows'), { recursive:true });
    fs.writeFileSync(join(tmp,'.github','workflows','agent-controller-dispatch.yml'),
      'name: metadata-only fixture\\n');
    git('add','.');
    git('commit','-qm','metadata only');
    const metadataHead = git('rev-parse','HEAD');
    const withShas = (headSha, baseSha = base) => ({
      ...event, pull_request:{ ...event.pull_request,
        base:{sha:baseSha}, head:{ ...event.pull_request.head,sha:headSha } },
    });
    assert.equal(prepare(withShas(metadataHead),[],tmp).mode,'not-required');
    assert.equal(prepare(withShas(metadataHead),[],tmp).reason,'verified-metadata-only-diff');
    assert.throws(() => prepare(withShas(base),[],tmp), /current PR base and head SHA are identical/,
      'identical base/head must not mark tests unnecessary');
    fs.mkdirSync(join(tmp,'web','src'),{recursive:true});
    fs.writeFileSync(join(tmp,'web','src','App.tsx'),'export default null;\\n');
    git('add','.');
    git('commit','-qm','runtime changed');
    const runtimeHead = git('rev-parse','HEAD');
    assert.equal(prepare(withShas(runtimeHead),[],tmp).mode,'unresolved');
    fs.mkdirSync(join(tmp,'docs'),{recursive:true});
    git('mv','web/src/App.tsx','docs/App.md');
    git('commit','-qm','runtime file moved into docs');
    const renamedHead = git('rev-parse','HEAD');
    assert.equal(prepare(withShas(renamedHead,runtimeHead),[],tmp).mode,'unresolved',
      'runtime-to-docs rename must not be mistaken for docs-only');
  } finally {
    fs.rmSync(tmp,{recursive:true,force:true});
  }
  assert.throws(()=>prepare({...event,pull_request:{...event.pull_request,head:{sha:'x'}}},[],'.'),/identity/);
  assert.throws(()=>prepare(event,[{number:999,body:'',state:'open'}],'.'),/unrelated/);
  // Reproduce a PR whose webhook base SHA is stale after the target branch
  // added an E2E spec. The PR merged the advancing base into its head; only the
  // head-owned Case files count as PR changes, regardless of merge-parent order.
  const mergeTmp = fs.mkdtempSync(join(tmpdir(), 'nession-issue-e2e-base-merge-'));
  try {
    const git = (...args) => execFileSync('git', args, {
      cwd: mergeTmp, encoding:'utf8', stdio:['ignore','pipe','ignore'],
    }).trim();
    git('init','-q','-b','staging');
    git('config','user.name','CI Fixture');
    git('config','user.email','ci@example.invalid');
    fs.mkdirSync(join(mergeTmp,'e2e','tests','browser'),{recursive:true});
    fs.writeFileSync(join(mergeTmp,'e2e','tests','browser','baseline.spec.ts'),'// base-owned baseline\n');
    git('add','.'); git('commit','-qm','old target base');
    const staleBase = git('rev-parse','HEAD');
    git('checkout','-qb','feature');
    fs.mkdirSync(join(mergeTmp,'e2e','acceptance','cases','42'),{recursive:true});
    fs.writeFileSync(join(mergeTmp,'e2e','acceptance','cases','42','case.yaml'),'schema_version: 1\n');
    git('add','.'); git('commit','-qm','feature adds acceptance case');
    const featureHead = git('rev-parse','HEAD');
    git('checkout','staging');
    fs.writeFileSync(join(mergeTmp,'e2e','tests','browser','terminal-consistency-faults.spec.ts'),'// added on target branch only\n');
    git('add','.'); git('commit','-qm','target branch adds browser spec');
    const currentBase = git('rev-parse','HEAD');
    git('checkout','feature');
    git('merge','--no-ff','staging','-m','merge advancing base into feature');
    const mergeHead = git('rev-parse','HEAD');
    git('update-ref','refs/remotes/origin/staging',currentBase);
    git('checkout','--detach',mergeHead);

    const noE2E = [
      '## E2E Verification','### New','- none: no new browser test',
      '### Regression','- none: no browser behavior affected',
      '## E2E Report','| ID | Type | Result | Evidence |','|---|---|---|---|',
    ].join('\n');
    const fixtureEvent = sha => ({
      repository:{full_name:'BestNathan/nession'},
      pull_request:{
        number:42,title:'Refs #42',body:'Refs #42',
        head:{sha,repo:{full_name:'BestNathan/nession'}},
        base:{sha:staleBase,ref:'staging'},
      },
    });
    const issue = {number:42,body:noE2E,state:'open'};
    const plan = prepare(fixtureEvent(mergeHead),[issue],mergeTmp);
    assert.equal(plan.base_sha,currentBase,'plan must bind current base ref, not stale event SHA');
    assert.equal(plan.target_sha,mergeHead);
    assert.equal(plan.mode,'not-required',
      'the base-only terminal-consistency-faults spec must not be attributed to the Case-only PR');

    fs.writeFileSync(join(mergeTmp,'e2e','tests','browser','head-owned-new.spec.ts'),'// genuinely PR-owned E2E ID\n');
    git('add','.'); git('commit','-qm','feature adds new browser spec');
    const headOwned = git('rev-parse','HEAD');
    assert.throws(() => prepare(fixtureEvent(headOwned),[issue],mergeTmp),
      /changed E2E ID missing from linked Issue New\/Regression obligations: head-owned-new/,
      'a truly head-owned new test must still require an Issue declaration');

    // Also cover the opposite merge-parent order: feature first, advancing base second.
    git('checkout','-B','feature-first-parent',featureHead);
    git('merge','--no-ff','staging','-m','merge advancing base as second parent');
    const oppositeMerge = git('rev-parse','HEAD');
    git('update-ref','refs/remotes/origin/staging',currentBase);
    git('checkout','--detach',oppositeMerge);
    const oppositePlan = prepare(fixtureEvent(oppositeMerge),[issue],mergeTmp);
    assert.equal(oppositePlan.base_sha,currentBase);
    assert.equal(oppositePlan.mode,'not-required',
      'upstream E2E IDs must not be attributed when the base is second parent');
  } finally {
    fs.rmSync(mergeTmp,{recursive:true,force:true});
  }
  console.log('Issue E2E planner adapter: unresolved legacy source does not force full, source identity and unrelated Issue rejected');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const [op,eventFile,issuesFile,sourceRoot,output] = process.argv.slice(2);
if (op === 'self-test') selfTest();
else if (op === 'plan') {
  if (!eventFile || !issuesFile || !sourceRoot || !output) throw Error('plan EVENT ISSUES ROOT OUTPUT');
  const plan = prepare(JSON.parse(fs.readFileSync(eventFile,'utf8')),
    JSON.parse(fs.readFileSync(issuesFile,'utf8')),sourceRoot);
  fs.writeFileSync(output,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
  console.log('E2E selection mode: '+plan.mode+', selected: '+plan.selected.map(x=>x.id).join(','));
} else throw Error('use self-test or plan');
}
