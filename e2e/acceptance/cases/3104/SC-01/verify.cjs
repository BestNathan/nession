'use strict';
// #3104 SC-01: trusted Acceptance routing is platform-exact. A macOS Case is
// selected only by the macOS job, existing Linux Cases stay on the Ubuntu job,
// and the ingest consumes both source-bound artifacts from one run.
const fs = require('node:fs');
const path = require('node:path');
const {
  run, checked, targetSha,
} = require('../../../shared/control-mode-cases.cjs');

const root = path.resolve(__dirname, '../../../../..');

function requireText(file, values) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const value of values) {
    if (!text.includes(value)) throw new Error(file + ' does not contain: ' + value);
  }
  return text;
}

run(({ evidence }) => {
  const sha = targetSha();

  // The selector owns platform filtering; its fixtures prove that a macOS
  // Case is not expected on Linux, is selected on macOS, and an unknown
  // platform fails closed.
  checked('node', ['scripts/select-acceptance-cases.mjs', 'self-test'], 120000);
  checked('node', ['scripts/acceptance-case-selection-contract.mjs', 'self-test'], 120000);

  requireText('.github/workflows/acceptance-cases.yml', [
    'execute-macos:',
    'runs-on: macos-15-intel',
    'if: github.event_name != \'workflow_dispatch\' || inputs.platform == \'macos\'',
    'ACCEPTANCE_PLATFORM: macos',
    'ACCEPTANCE_PLATFORM: linux',
    'name: acceptance-case-results-macos-${{ github.run_id }}-${{ github.run_attempt }}',
  ]);
  requireText('.github/workflows/acceptance-case-ingest.yml', [
    'pattern: acceptance-case-results-*',
    'merge-multiple: true',
  ]);
  requireText('e2e/acceptance/contract/cases.mjs', [
    "CASE_PLATFORMS = new Set(['linux', 'macos'])",
    "raw.platform ?? 'linux'",
  ]);

  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the trusted selector self-test proves Linux/macOS platform routing and fail-closed unknown-platform handling',
  });
  evidence.push({
    type: 'runtime',
    value: 'the macOS job pins macos-15-intel, sets ACCEPTANCE_PLATFORM=macos, and the ingest downloads both platform artifacts from one run',
  });
  return 'Acceptance Cases are routed only to their declared platform and both platform artifacts are ingested from one source run';
});
