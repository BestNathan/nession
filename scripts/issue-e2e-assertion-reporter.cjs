'use strict';
// Trusted, assertion-only Playwright reporter. The built-in JSON reporter omits
// TestResult.steps, so a passed test without this receipt is unproven.
const fs = require('node:fs');
const path = require('node:path');

function countExpectSteps(steps) {
  let count = 0;
  for (const step of steps || []) {
    if (step.category === 'expect') count++;
    count += countExpectSteps(step.steps);
  }
  return count;
}

class IssueE2EAssertionReporter {
  constructor() { this.records = []; }
  printsToStdio() { return false; }

  onTestEnd(test, result) {
    const file = path.basename(String(test.location?.file || ''));
    const id = file.endsWith('.spec.ts') ? file.slice(0, -8) : '';
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
      throw Error('Playwright assertion receipt requires stable spec file ID');
    this.records.push({
      id,
      title: String(test.title),
      line: Number(test.location?.line),
      retry: Number(result.retry),
      status: result.status,
      assertions: countExpectSteps(result.steps),
    });
  }

  onEnd() {
    const filename = process.env.NESSION_E2E_ASSERTIONS_OUTPUT_FILE;
    if (!filename || !path.isAbsolute(filename))
      throw Error('Trusted Issue E2E assertion receipt output path is required');
    const tests = this.records.slice().sort((a, b) =>
      a.id.localeCompare(b.id) || a.line - b.line ||
      a.title.localeCompare(b.title) || a.retry - b.retry);
    fs.writeFileSync(filename,
      JSON.stringify({schema_version: 1, kind: 'playwright_assertion_steps', tests}, null, 2) + '\n',
      {flag: 'wx'});
  }
}
module.exports = IssueE2EAssertionReporter;
module.exports.countExpectSteps = countExpectSteps;
