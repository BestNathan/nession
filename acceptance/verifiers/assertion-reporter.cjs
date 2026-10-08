// Playwright reporter callback evidence, separate from default JSON statistics.
// Playwright's built-in JSON output does not serialize expect step callbacks.
const fs = require('node:fs');

class AcceptanceAssertionReporter {
  constructor() {
    this.started = 0;
    this.executed = 0;
    this.passed = 0;
    this.assertions = 0;
    this.failedAssertions = 0;
  }
  onTestBegin() { this.started += 1; }
  onStepEnd(_test, _result, step) {
    if (step.category === 'expect') {
      this.assertions += 1;
      if (step.error) this.failedAssertions += 1;
    }
  }
  onTestEnd(_test, result) {
    if (result.status !== 'skipped') this.executed += 1;
    if (result.status === 'passed') this.passed += 1;
  }
  onEnd() {
    const output = process.env.NESSION_PLAYWRIGHT_PROOF_FILE;
    if (!output) throw new Error('NSESSION_PLAYWRIGHT_PROOF_FILE missing');
    fs.writeFileSync(output, JSON.stringify({
      schema_version: 1, started: this.started, executed: this.executed,
      passed: this.passed, assertions: this.assertions, failedAssertions: this.failedAssertions,
    }));
  }
}
module.exports = AcceptanceAssertionReporter;
