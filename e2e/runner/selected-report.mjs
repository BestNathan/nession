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
// The default Playwright JSON reporter does not serialize TestResult.steps.
// Require an independent execution-time receipt from a trusted custom reporter.
export function summarize(plan, report, receipt) {
  if (plan?.schema_version !== 1 || plan?.kind !== 'issue_e2e_selection' ||
      plan?.mode !== 'selected' || !Array.isArray(plan.selected) || !plan.selected.length ||
      !/^[0-9a-f]{40}$/.test(plan.target_sha) || !/^[a-f0-9]{64}$/.test(plan.plan_digest)) {
    throw new Error('invalid selected E2E plan');
  }
  if (!report || !Array.isArray(report.suites) || !report.stats)
    throw new Error('missing Playwright JSON report');
  if (!receipt || receipt.schema_version !== 1 ||
      receipt.kind !== 'playwright_assertion_steps' || !Array.isArray(receipt.tests))
    throw new Error('missing or invalid Playwright assertion receipt');
  const specs = allSpecs(report.suites), used = new Set(), results = [];
  for (const item of plan.selected) {
    const id = item.id;
    if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
      throw new Error('invalid selected test ID');
    const matching = specs.filter(spec => {
      const file = String(spec.file).replace(/\\/g, '/');
      return file.endsWith('/' + id + '.spec.ts') || file === id + '.spec.ts';
    });
    const counters = {discovered: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, assertions: 0};
    for (const spec of matching) for (const test of spec.tests ?? []) {
      counters.discovered++;
      if (test.status === 'expected' && test.results?.some(r => r.status === 'passed'))
        counters.passed++;
      else if (test.status === 'skipped') counters.skipped++;
      else if (test.status === 'flaky') counters.flaky++;
      else counters.failed++;
      for (const attempt of test.results ?? []) {
        const index = receipt.tests.findIndex((row, index) =>
          !used.has(index) && row.id === id && row.title === spec.title &&
          row.line === spec.line && row.retry === attempt.retry &&
          row.status === attempt.status);
        if (index < 0) throw new Error('missing/mismatched assertion receipt for ' + id);
        const observed = receipt.tests[index].assertions;
        if (!Number.isSafeInteger(observed) || observed < 0)
          throw new Error('invalid executed assertion count for ' + id);
        used.add(index);
        counters.assertions += observed;
      }
    }
    const result = counters.discovered === 0 ? 'Error'
      : counters.failed > 0 ? 'Fail'
      : counters.skipped > 0 || counters.flaky > 0 || counters.assertions === 0 ? 'Pending'
      : counters.passed === counters.discovered ? 'Pass' : 'Error';
    results.push({id, result, ...counters});
  }
  if (used.size !== receipt.tests.length)
    throw new Error('unexpected assertion receipt outside selected E2E tests');
  return {
    schema_version: 1, kind: 'issue_e2e_test_results', scope: 'selected',
    target_sha: plan.target_sha, base_sha: plan.base_sha, plan_digest: plan.plan_digest,
    results, status: results.every(item => item.result === 'Pass') ? 'Pass' : 'Unproven',
  };
}

function selfTest() {
  const plan={schema_version:1,kind:'issue_e2e_selection',mode:'selected',
    target_sha:'a'.repeat(40),base_sha:'b'.repeat(40),plan_digest:'c'.repeat(64),
    selected:[{id:'terminal-attach'},{id:'terminal-resume'}]};
  const one=(id,status,assertions=1) => ({
    spec:{title:id,file:id+'.spec.ts',line:8,tests:[{
      status:status==='passed'?'expected':status==='skipped'?'skipped':status==='flaky'?'flaky':'unexpected',
      results:[{retry:0,status:status==='passed'?'passed':status==='skipped'?'skipped':'failed'}],
    }]},
    proof:{id,title:id,line:8,retry:0,status:status==='passed'?'passed':status==='skipped'?'skipped':'failed',assertions},
  });
  const a=one('terminal-attach','passed'),b=one('terminal-resume','passed');
  const make=(second=b) => ({
    json:{stats:{},suites:[{file:'terminal-attach.spec.ts',specs:[a.spec]},
      {file:'terminal-resume.spec.ts',specs:[second.spec]}]},
    receipt:{schema_version:1,kind:'playwright_assertion_steps',tests:[a.proof,second.proof]},
  });
  let input=make(),out=summarize(plan,input.json,input.receipt);
  assert.equal(out.status,'Pass');
  assert.deepEqual(out.results.map(r=>r.assertions),[1,1]);
  input=make(one('terminal-resume','failed'));
  assert.equal(summarize(plan,input.json,input.receipt).results[1].result,'Fail');
  input=make(one('terminal-resume','flaky'));
  assert.equal(summarize(plan,input.json,input.receipt).results[1].result,'Pending');
  input=make(one('terminal-resume','skipped'));
  assert.equal(summarize(plan,input.json,input.receipt).results[1].result,'Pending');
  input=make(one('terminal-resume','passed',0));
  assert.equal(summarize(plan,input.json,input.receipt).results[1].result,'Pending');
  assert.throws(()=>summarize(plan,input.json,null),/receipt/);
  assert.throws(()=>summarize(plan,input.json,{...input.receipt,tests:[a.proof]}),/missing\/mismatched/);
  assert.throws(()=>summarize(plan,input.json,{...input.receipt,tests:[
    ...input.receipt.tests,{...b.proof,id:'unknown'}]}),/unexpected assertion receipt/);
  assert.throws(()=>summarize(plan,input.json,{...input.receipt,tests:[
    a.proof,{...b.proof,assertions:-1}]}),/invalid executed assertion/);
  assert.throws(()=>summarize({...plan,plan_digest:'bad'},input.json,input.receipt),/invalid selected/);
  console.log('Selected E2E classifier: executed assertions, Fail, zero/missing/forged receipts and plan negatives pass');
}

// This module is also imported by scripts/issue-e2e-collect.mjs.
// Importing it must never execute its CLI parser or throw based on the
// *caller's* argv (e.g. "collect", not "summarize").
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
if (process.argv[2] === 'self-test') selfTest();
else if (process.argv[2] === 'summarize') {
  const [planFile, reporterFile, assertionsFile, outputFile] = process.argv.slice(3);
  if (!planFile || !reporterFile || !assertionsFile || !outputFile)
    throw new Error('usage: summarize PLAN REPORT ASSERTIONS OUTPUT');
  const result = summarize(JSON.parse(fs.readFileSync(planFile,'utf8')),
    JSON.parse(fs.readFileSync(reporterFile,'utf8')),
    JSON.parse(fs.readFileSync(assertionsFile,'utf8')));
  fs.writeFileSync(outputFile, JSON.stringify(result,null,2)+'\n', {flag:'wx'});
  console.log(result.status);
} else throw new Error('usage: selected-report.mjs self-test | summarize PLAN REPORT OUTPUT');
}
