// Interpret machine-readable Playwright results. Process exit 0 is not evidence.
import assert from 'node:assert/strict';

function allTests(suites) {
  const result = [];
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) result.push(...(spec.tests ?? []));
    result.push(...allTests(suite.suites));
  }
  return result;
}

function countAssertions(steps) {
  let count = 0;
  for (const step of steps ?? []) {
    if (step.category === 'expect') count += 1;
    count += countAssertions(step.steps);
  }
  return count;
}

export function classifyBrowserReport(report, exitCode) {
  if (!report || typeof report !== 'object' || !report.stats) {
    return { result: 'Error', summary: 'Playwright JSON reporter output missing or invalid', evidence: [] };
  }
  const stats = report.stats;
  const expected = Number(stats.expected);
  const unexpected = Number(stats.unexpected);
  const skipped = Number(stats.skipped);
  const flaky = Number(stats.flaky ?? 0);
  const tests = allTests(report.suites);
  const assertions = tests.reduce((total, test) =>
    total + (test.results ?? []).reduce((n, run) => n + countAssertions(run.steps), 0), 0);
  if (![expected, unexpected, skipped, flaky].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    return { result: 'Error', summary: 'invalid Playwright execution counters', evidence: [] };
  }
  if (tests.length === 0 || expected + unexpected + skipped + flaky !== tests.length) {
    return { result: 'Error', summary: 'Playwright test discovery/count mismatch', evidence: [] };
  }
  const facts = { discovered: tests.length, passed: expected, failed: unexpected, skipped, flaky, assertions };
  if (unexpected > 0 || (exitCode !== 0 && expected > 0)) {
    return { result: 'Fail', summary: 'Playwright assertions failed', evidence: [], execution: facts };
  }
  if (exitCode !== 0) {
    return { result: 'Error', summary: 'Playwright execution failed before a passing verdict', evidence: [], execution: facts };
  }
  if (expected === 0 || skipped > 0 || flaky > 0 || assertions === 0) {
    return {
      result: 'Pending',
      summary: 'Browser Case has zero passed tests, skipped/flaky tests or no recorded assertions',
      evidence: [],
      execution: facts,
    };
  }
  return {
    result: 'Pass',
    summary: 'Playwright JSON confirms executed passing tests and assertions with no skips',
    evidence: [{ type: 'browser', value: 'Playwright discovered=' + tests.length +
      ' passed=' + expected + ' skipped=0 assertions=' + assertions }],
    execution: facts,
  };
}

function selfTest() {
  const test = (steps = [{ category: 'expect' }]) => ({
    results: [{ steps }], status: 'expected',
  });
  const report = (tests, expected, skipped = 0, unexpected = 0, flaky = 0) => ({
    suites: [{ specs: [{ tests }] }], stats: { expected, skipped, unexpected, flaky },
  });
  assert.equal(classifyBrowserReport(report([test()], 1), 0).result, 'Pass');
  assert.equal(classifyBrowserReport(report([], 0), 0).result, 'Error');
  assert.equal(classifyBrowserReport(report([test()], 0, 1), 0).result, 'Pending');
  assert.equal(classifyBrowserReport(report([test(), test()], 1, 1), 0).result, 'Pending');
  assert.equal(classifyBrowserReport(report([test([])], 1), 0).result, 'Pending');
  assert.equal(classifyBrowserReport(report([test()], 0, 0, 1), 1).result, 'Fail');
  assert.equal(classifyBrowserReport(null, 0).result, 'Error');
  assert.equal(classifyBrowserReport(report([test()], 1), 1).result, 'Fail');
  console.log('browser report contract: 8 positive/negative fixtures passed');
}
if (process.argv[1]?.endsWith('browser-report.mjs') && process.argv[2] === 'self-test') selfTest();
