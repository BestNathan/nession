#!/usr/bin/env node
// Lossless per-file outcome extraction from a Playwright JSON report.
// Output contains bounded counters only; raw page content, URL and logs are not ingested.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

function allSpecs(suites, inheritedFile = '', output = []) {
  for (const suite of suites ?? []) {
    const file = suite.file || inheritedFile;
    for (const spec of suite.specs ?? []) output.push({ ...spec, file: spec.file || file });
    allSpecs(suite.suites ?? [], file, output);
  }
  return output;
}
function countAssertionSteps(steps) {
  let count = 0;
  for (const step of steps ?? []) {
    if (step.category === 'expect') count++;
    count += countAssertionSteps(step.steps);
  }
  return count;
}
export function summarize(plan, report) {
  if (plan?.schema_version !== 1 || plan?.kind !== 'issue_e2e_selection' ||
      plan?.mode !== 'selected' || !Array.isArray(plan.selected) || !plan.selected.length ||
      !/^[0-9a-f]{40}$/.test(plan.target_sha) || !/^[a-f0-9]{64}$/.test(plan.plan_digest)) {
    throw new Error('invalid selected E2E plan');
  }
  if (!report || !Array.isArray(report.suites) || !report.stats) throw new Error('missing Playwright JSON report');
  const specs = allSpecs(report.suites);
  const results = [];
  for (const item of plan.selected) {
    const id = item.id;
    if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('invalid selected test ID');
    const matching = specs.filter(spec => String(spec.file).replace(/\\/g, '/').endsWith('/' + id + '.spec.ts') ||
      String(spec.file).replace(/\\/g, '/') === id + '.spec.ts');
    const counters = { discovered: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, assertions: 0 };
    for (const spec of matching) for (const test of spec.tests ?? []) {
      counters.discovered++;
      if (test.status === 'expected' && test.results?.some(r => r.status === 'passed')) counters.passed++;
      else if (test.status === 'skipped') counters.skipped++;
      else if (test.status === 'flaky') counters.flaky++;
      else counters.failed++;
      for (const attempt of test.results ?? []) counters.assertions += countAssertionSteps(attempt.steps);
    }
    const result = counters.discovered === 0 ? 'Error'
      : counters.failed > 0 ? 'Fail'
      : counters.skipped > 0 || counters.flaky > 0 || counters.assertions === 0 ? 'Pending'
      : counters.passed === counters.discovered ? 'Pass' : 'Error';
    results.push({ id, result, ...counters });
  }
  return {
    schema_version: 1, kind: 'issue_e2e_test_results', scope: 'selected',
    target_sha: plan.target_sha, base_sha: plan.base_sha, plan_digest: plan.plan_digest,
    results, status: results.every(item => item.result === 'Pass') ? 'Pass' : 'Unproven',
  };
}
function selfTest() {
  const plan = { schema_version: 1, kind:'issue_e2e_selection', mode:'selected',
    target_sha:'a'.repeat(40),base_sha:'b'.repeat(40),plan_digest:'c'.repeat(64),
    selected:[{id:'terminal-attach'},{id:'terminal-resume'}] };
  const test = (status, steps = [{ category:'expect' }]) =>
    ({ status, results:[{status:status === 'expected' ? 'passed' : 'failed',steps}] });
  const report = { stats:{}, suites:[{file:'tests/browser/terminal-attach.spec.ts',
    specs:[{file:'tests/browser/terminal-attach.spec.ts',tests:[test('expected')]}],
    suites:[]}] };
  let out = summarize(plan,report);
  assert.equal(out.results[0].result,'Pass');
  assert.equal(out.results[1].result,'Error');
  report.suites.push({file:'tests/browser/terminal-resume.spec.ts',
    specs:[{file:'tests/browser/terminal-resume.spec.ts',tests:[test('unexpected')]}]});
  out = summarize(plan,report);
  assert.equal(out.results[1].result,'Fail');
  report.suites[1].specs[0].tests=[test('flaky')];
  assert.equal(summarize(plan,report).results[1].result,'Pending');
  report.suites[1].specs[0].tests=[test('expected',[])];
  assert.equal(summarize(plan,report).results[1].result,'Pending');
  report.suites[1].specs[0].tests=[test('expected')];
  assert.equal(summarize(plan,report).status,'Pass');
  assert.throws(() => summarize({...plan,plan_digest:'no'},report),/invalid/);
  assert.throws(() => summarize(plan,null),/missing/);
  console.log('Selected E2E report: Pass/Fail/Flaky/Empty and missing-report negatives passed');
}
// This module is also imported by scripts/issue-e2e-collect.mjs.
// Importing it must never execute its CLI parser or throw based on the
// *caller's* argv (e.g. "collect", not "summarize").
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
if (process.argv[2] === 'self-test') selfTest();
else if (process.argv[2] === 'summarize') {
  const [planFile, reporterFile, outputFile] = process.argv.slice(3);
  if (!planFile || !reporterFile || !outputFile) throw new Error('usage: summarize PLAN REPORT OUTPUT');
  const result = summarize(JSON.parse(fs.readFileSync(planFile,'utf8')), JSON.parse(fs.readFileSync(reporterFile,'utf8')));
  fs.writeFileSync(outputFile, JSON.stringify(result,null,2)+'\n', {flag:'wx'});
  console.log(result.status);
} else throw new Error('usage: selected-report.mjs self-test | summarize PLAN REPORT OUTPUT');
}
