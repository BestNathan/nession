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

/**
 * The Playwright JSON reporter captures test stdout in each test result.
 * Emit only a bounded, numeric proof for a CASE_EVIDENCE payload; never copy
 * arbitrary terminal content, URLs or the entire browser log into Run Records.
 */
export function extractGeometryEvidence(report, stdout, targetSha) {
  const logs = [String(stdout ?? '')];
  for (const test of allTests(report?.suites)) {
    for (const result of test.results ?? []) {
      for (const part of result.stdout ?? []) {
        logs.push(typeof part === 'string' ? part : String(part?.text ?? ''));
      }
    }
  }
  const stages = ['web', 'history', 'restored', 'app', 'compactApp', 'webRestored'];
  for (const log of logs) {
    for (const line of log.split(/\r?\n/)) {
      const start = line.indexOf('CASE_EVIDENCE ');
      if (start < 0) continue;
      const json = line.slice(start + 'CASE_EVIDENCE '.length).trim();
      if (json.length > 8192) continue;
      try {
        const data = JSON.parse(json);
        if (data?.target_sha !== targetSha || data?.case_issue !== 1482 ||
            data?.evidence_kind !== 'computed-css-and-rendered-xterm-cell-geometry') continue;
        const summary = stages.map(stage => {
          const g = data[stage];
          if (!g || !['inset', 'gridBottom', 'shellTop', 'cursorBottom'].every(k => Number.isFinite(g[k]))) {
            throw new Error('missing numeric geometry');
          }
          return stage + ':inset=' + g.inset.toFixed(1) +
            ',gridBottom=' + g.gridBottom.toFixed(1) +
            ',cursorBottom=' + g.cursorBottom.toFixed(1) +
            ',capsuleTop=' + g.shellTop.toFixed(1);
        });
        return { type: 'browser-geometry', value: 'sha=' + targetSha + ' ' + summary.join('; ') };
      } catch {
        // Malformed/untrusted console output must not become acceptance evidence.
      }
    }
  }
  return null;
}

export function classifyBrowserReport(report, exitCode, proof) {
  if (!report || typeof report !== 'object' || !report.stats) {
    return { result: 'Error', summary: 'Playwright JSON reporter output missing or invalid', evidence: [] };
  }
  const stats = report.stats;
  const expected = Number(stats.expected);
  const unexpected = Number(stats.unexpected);
  const skipped = Number(stats.skipped);
  const flaky = Number(stats.flaky ?? 0);
  const tests = allTests(report.suites);
  // The Playwright JSON reporter omits step events. A second reporter supplies
  // step callback counts; never infer that exit=0 implies actual assertions.
  if (!proof || proof.schema_version !== 1 ||
      !Number.isSafeInteger(proof.assertions) || proof.assertions < 0 ||
      !Number.isSafeInteger(proof.executed) || proof.executed < 0 ||
      !Number.isSafeInteger(proof.passed) || proof.passed < 0 ||
      !Number.isSafeInteger(proof.failedAssertions) || proof.failedAssertions < 0) {
    return { result: 'Error', summary: 'missing/invalid Playwright assertion reporter evidence', evidence: [] };
  }
  const assertions = proof.assertions;
  if (![expected, unexpected, skipped, flaky].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    return { result: 'Error', summary: 'invalid Playwright execution counters', evidence: [] };
  }
  if (tests.length === 0 || expected + unexpected + skipped + flaky !== tests.length) {
    return { result: 'Error', summary: 'Playwright test discovery/count mismatch', evidence: [] };
  }
  const facts = { discovered: tests.length, passed: expected, failed: unexpected, skipped, flaky, assertions };
  if (expected > proof.executed || expected !== proof.passed) {
    return { result: 'Error', summary: 'JSON and assertion reporter execution counts disagree', evidence: [], execution: facts };
  }
  // expect.poll/toPass can emit failing intermediate expect-step callbacks
  // before their enclosing Playwright test eventually passes. Those retries
  // are diagnostic evidence, not a failed test verdict. The JSON reporter's
  // final unexpected count and the process exit remain authoritative.
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
    summary: 'Playwright JSON confirms executed passing tests and assertions with no skips' +
      (proof.failedAssertions > 0 ? ' (' + proof.failedAssertions + ' recovered assertion retries)' : ''),
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
  const proof = (executed, assertions, passed = executed, failedAssertions = 0) =>
    ({ schema_version: 1, executed, assertions, passed, failedAssertions });
  assert.equal(classifyBrowserReport(report([test()], 1), 0, proof(1, 2)).result, 'Pass');
  assert.equal(classifyBrowserReport(report([], 0), 0, proof(0, 0)).result, 'Error');
  assert.equal(classifyBrowserReport(report([test()], 0, 1), 0, proof(0, 0)).result, 'Pending');
  assert.equal(classifyBrowserReport(report([test(), test()], 1, 1), 0, proof(1, 1)).result, 'Pending');
  assert.equal(classifyBrowserReport(report([test([])], 1), 0, proof(1, 0)).result, 'Pending');
  assert.equal(classifyBrowserReport(report([test()], 0, 0, 1), 1, proof(1, 1, 0, 1)).result, 'Fail');
  assert.equal(classifyBrowserReport(null, 0).result, 'Error');
  assert.equal(classifyBrowserReport(report([test()], 1), 0).result, 'Error');
  assert.equal(classifyBrowserReport(report([test()], 1), 1, proof(1, 1)).result, 'Fail');
  // A transient failed poll step may recover; only the final test result fails a Case.
  assert.equal(classifyBrowserReport(report([test()], 1), 0, proof(1, 1, 1, 1)).result, 'Pass');
  assert.equal(classifyBrowserReport(report([test()], 0, 0, 1), 1, proof(1, 2, 0, 1)).result, 'Fail');
  assert.equal(classifyBrowserReport(report([test()], 1), 0, proof(1, 1, 0)).result, 'Error');
  const sample = Object.fromEntries(['web','history','restored','app','compactApp','webRestored']
    .map(stage => [stage, { inset: 10, gridBottom: 20, cursorBottom: 20, shellTop: 30 }]));
  const payload = { target_sha: 'a'.repeat(40), case_issue: 1482,
    evidence_kind: 'computed-css-and-rendered-xterm-cell-geometry', ...sample };
  assert.equal(extractGeometryEvidence(null, 'CASE_EVIDENCE ' + JSON.stringify(payload), 'a'.repeat(40))?.type, 'browser-geometry');
  assert.equal(extractGeometryEvidence(null, 'CASE_EVIDENCE ' + JSON.stringify(payload), 'b'.repeat(40)), null);
  console.log('browser report contract: 14 positive/negative fixtures passed');
}
if (process.argv[1]?.endsWith('browser-report.mjs') && process.argv[2] === 'self-test') selfTest();
