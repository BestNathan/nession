'use strict';
// Temporary #3358 SC-10 diagnostic verifier: the browser verifier writes page
// errors and DOM facts to /tmp when it fails. This verifier surfaces them in
// the Case record, which intentionally drops raw browser stderr.
const fs = require('node:fs');
const { run } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const file = '/tmp/nession-sc10-diag.json';
  if (!fs.existsSync(file)) {
    evidence.push({
      type: 'runtime',
      value: 'No browser failure diagnostics were produced; the SC-10 browser verifier passed',
    });
    return 'SC-10 browser verifier passed without diagnostics';
  }
  const diagnostic = JSON.parse(fs.readFileSync(file, 'utf8'));
  throw new Error('SC10_DIAG ' + JSON.stringify(diagnostic).slice(0, 4000));
});
