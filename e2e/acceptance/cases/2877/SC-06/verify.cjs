'use strict';
// #2877 SC-06: a controlled, reproducible baseline/candidate measurement of
// frame counts and per-subscriber issued-credit peaks under burst, quiet-tail,
// slow-browser and high-output fixtures has not been implemented. The
// requirement explicitly forbids claiming this from fake-timer tests alone, so
// this Case reports Pending with its prerequisite rather than inventing a Pass.
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

const sha = targetSha();
process.stdout.write(JSON.stringify({
  status: 'pending',
  summary:
    'No controlled CI measurement lane exists yet for frame counts and per-subscriber issued-credit peaks under burst/idle/slow-browser fixtures',
  evidence: [{
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': prerequisite is a reproducible runner comparison that ' +
      'records outgoing Progress, normal responses, reconcile notices, issued-credit peak, ' +
      'stalls, gaps and teardown under identical scripted workloads; not claimed by this Case',
  }],
}) + '\n');
