#!/usr/bin/env node
// Deterministic Issue→E2E browser-regression plan; the LLM is never the selector.
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIssueE2E, verifyIssueE2EAgainstCatalog } from './issue-e2e-contract.mjs';

const HEX40 = /^[a-f0-9]{40}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const digest = o => createHash('sha256').update(JSON.stringify(o)).digest('hex');
const git = (args, cwd) => execFileSync('git', args, { encoding: 'utf8', cwd }).trim();

export function catalogFromPaths(paths) {
  const found = new Set(), ids = [];
  for (const file of paths) {
    if (!file.startsWith('e2e/tests/') || !file.endsWith('.spec.ts')) continue;
    const id = path.basename(file, '.spec.ts');
    if (!ID.test(id) || found.has(id)) throw new Error('invalid/duplicate ID at source revision: ' + id);
    found.add(id); ids.push(id);
  }
  return ids.sort();
}

export function buildSelectionPlan({ issues, baseIds, headIds, changedIds = [], targetSha, baseSha }) {
  if (!HEX40.test(targetSha) || !HEX40.test(baseSha) || targetSha === baseSha) {
    throw new Error('Issue E2E plan requires distinct exact base/head SHA');
  }
  if (!Array.isArray(issues) || !issues.length) throw new Error('Issue E2E plan requires at least one linked Issue');
  const seen = new Set(), selected = new Map(), summaries = [];
  for (const issue of issues) {
    if (!Number.isSafeInteger(issue.number) || issue.number <= 0 || seen.has(issue.number)) {
      throw new Error('invalid/duplicate linked Issue');
    }
    seen.add(issue.number);
    const declaration = parseIssueE2E(issue.body, { requireDeclaration: true });
    if (declaration.errors.length) throw new Error('Issue #' + issue.number + ' invalid E2E declaration: ' + declaration.errors.join('; '));
    verifyIssueE2EAgainstCatalog(declaration, headIds, baseIds);
    summaries.push({
      issue: issue.number, declaration_digest: declaration.digest,
      new_ids: declaration.newIds, regression_ids: declaration.regressionIds,
      no_e2e: declaration.selectedIds.length === 0,
    });
    for (const id of declaration.selectedIds) {
      const entries = selected.get(id) ?? [];
      entries.push({ issue: issue.number, type: declaration.newIds.includes(id) ? 'New' : 'Regression' });
      selected.set(id, entries);
    }
  }
  const head = new Set(headIds), base = new Set(baseIds);
  for (const id of changedIds) {
    if (!ID.test(id) || !head.has(id)) throw new Error('modified/added test not resolvable at target SHA: ' + id);
    if (!selected.has(id)) {
      throw new Error('changed E2E ID missing from linked Issue New/Regression obligations: ' + id);
    }
    const declaredAsNew = selected.get(id).some(x => x.type === 'New');
    if (!base.has(id) && !declaredAsNew) throw new Error('newly added test must be New in Issue: ' + id);
  }
  const selectedIds = [...selected.keys()].sort();
  const plan = {
    schema_version: 1, kind: 'issue_e2e_selection',
    base_sha: baseSha, target_sha: targetSha,
    issues: summaries.sort((a,b) => a.issue-b.issue),
    selected: selectedIds.map(id => ({ id, owners: selected.get(id).sort((a,b) => a.issue-b.issue) })),
    mode: selectedIds.length ? 'selected' : 'not-required',
  };
  return { ...plan, plan_digest: digest(plan) };
}

export function buildGitPlan(repo, issues, baseSha, targetSha) {
  if (git(['rev-parse', 'HEAD'], repo) !== targetSha) throw new Error('target HEAD/source checkout mismatch');
  const collect = sha => catalogFromPaths(git(['ls-tree', '-r', '--name-only', sha, '--', 'e2e/tests'], repo).split('\n').filter(Boolean));
  const baseIds = collect(baseSha), headIds = collect(targetSha);
  const changed = git(['diff', '--name-status', baseSha, targetSha, '--', 'e2e/tests'], repo).split('\n').filter(Boolean);
  const changedIds = [];
  for (const line of changed) {
    const [status, p, renamed] = line.split('\t');
    const filename = renamed || p;
    if (!/^([AMRTCD])/.test(status)) throw new Error('unrecognized test change status');
    if (status.startsWith('D')) continue;
    changedIds.push(...catalogFromPaths([filename]));
  }
  return buildSelectionPlan({ issues, baseIds, headIds, changedIds, baseSha, targetSha });
}

function selfTest() {
  const body = (newIds, regressions) => [
    '## E2E Verification', '### New',
    ...(newIds.length ? newIds.map(id => '- ' + id) : ['- none: no new browser test']),
    '### Regression',
    ...(regressions.length ? regressions.map(id => '- ' + id) : ['- none: no browser behavior affected']),
    '## E2E Report', '| ID | Type | Result | Evidence |', '|---|---|---|---|',
    ...newIds.map(id => '| ' + id + ' | New | Pending | - |'),
    ...regressions.map(id => '| ' + id + ' | Regression | Pending | - |'),
  ].join('\n');
  const a='a'.repeat(40), b='b'.repeat(40);
  const opts={baseSha:a,targetSha:b,baseIds:['terminal-attach','login'],headIds:['terminal-attach','login','terminal-resume'],changedIds:['terminal-resume']};
  const plan=buildSelectionPlan({...opts,issues:[{number:3,body:body(['terminal-resume'],['terminal-attach'])},{number:4,body:body([],['terminal-attach'])}]});
  assert.deepEqual(plan.selected.map(x=>x.id), ['terminal-attach','terminal-resume']);
  assert.deepEqual(plan.selected[0].owners, [{issue:3,type:'Regression'},{issue:4,type:'Regression'}]);
  assert.equal(plan.plan_digest, buildSelectionPlan({...opts,issues:[{number:4,body:body([],['terminal-attach'])},{number:3,body:body(['terminal-resume'],['terminal-attach'])}]}).plan_digest);
  assert.equal(buildSelectionPlan({...opts,changedIds:[],issues:[{number:3,body:body([],[])}]}).mode,'not-required');
  const fail = override => assert.throws(() => buildSelectionPlan({...opts,...override}));
  fail({issues:[]}); fail({issues:[{number:3,body:'legacy without E2E'}]});
  fail({issues:[{number:3,body:body([],['terminal-attach'])}]}); // changed ID undeclared
  fail({issues:[{number:3,body:body(['terminal-attach'],[])}]}); // New is already in base
  fail({issues:[{number:3,body:body([],['terminal-resume'])}]}); // Regression missing from base
  fail({targetSha:a});
  assert.deepEqual(catalogFromPaths(['e2e/tests/browser/x.spec.ts','e2e/tests/protocol/y.spec.ts']),['x','y']);
  assert.throws(() => catalogFromPaths(['e2e/tests/browser/x.spec.ts','e2e/tests/protocol/x.spec.ts']),/duplicate/);
  console.log('Issue E2E plan: deterministic dedupe, exact SHA and unlisted changed-test negatives passed');
}

// This module is also imported by the trusted Issue E2E selection adapter.
// Never consume its process.argv or run CLI side effects during an import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'self-test') selfTest();
  else if (process.argv[2] === 'plan') {
    const [repo, issuesFile, base, head, output] = process.argv.slice(3);
    if (!repo || !issuesFile || !base || !head || !output) throw new Error('usage: plan ROOT ISSUES_JSON BASE_SHA HEAD_SHA OUTPUT');
    const issues = JSON.parse(fs.readFileSync(issuesFile, 'utf8'));
    const plan = buildGitPlan(repo, issues, base, head);
    fs.writeFileSync(output, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
    console.log('Selected ' + plan.selected.length + ' E2E test IDs');
  } else throw new Error('usage: issue-e2e-plan.mjs self-test | plan ROOT ISSUES_JSON BASE_SHA HEAD_SHA OUTPUT');
}
