#!/usr/bin/env node
// SC-09/15: prove a custom detector's regression fixture cannot silently fall
// out of the unconditional PR Quality profiles when a detector is changed.
// This maps rule owners to test entrypoints; it does not reimplement any rule.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qualityFile = '.github/workflows/quality.yml';
const sources = ['gates/suites/quality-rust.gates', 'gates/suites/quality-tooling.gates', qualityFile];
const pairs = [
  ['dev-workspace-commit', ['dev-workspace-selftest'], 'tooling'],
  ['dev-workspace-push', ['dev-workspace-selftest'], 'tooling'],
  ['protocol-integrity', ['protocol-integrity-selftest'], 'tooling'],
  ['test-isolation', ['test-isolation-selftest'], 'tooling'],
  ['tmux-socket-isolation', ['tmux-socket-isolation-selftest'], 'tooling'],
  ['server-handler-locality', ['server-handler-locality-selftest', 'server-handler-concurrency-selftest'], 'tooling'],
  ['release-version-consistency', ['release-version-consistency-selftest'], 'rust'],
  ['design-system-fast', ['design-token-boundary-selftest'], 'web'],
  ['design-system-full', ['design-token-boundary-selftest'], 'web'],
  ['acceptance-runtime-contract', ['e2e-cli-selftest'], 'tooling'],
  ['gate-runtime-contract', ['gate-runtime-contract'], 'tooling'],
  ['instruction-contract', ['instruction-contract'], 'tooling'],
  ['gate-router-contract', ['gate-router-contract'], 'tooling'],
  ['gate-consumer-parity', ['gate-consumer-parity'], 'tooling'],
];

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
function getSelected(quality, rust, tooling) {
  // Canonical suites are ID-only. Web checks explicitly select Gates in a
  // post-npm-ci runner step, so no Node-only Gate needs a fake suite.
  function suiteIds(text) {
    return text.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  }
  const webCommands = quality.split(/\r?\n/).map(x => x.trim())
    .filter(x => x.startsWith('run: ./gates/run ') || x.startsWith('./gates/run '));
  return {
    tooling: new Set(suiteIds(tooling)),
    rust: new Set(suiteIds(rust)),
    web: new Set(webCommands.flatMap(line => line.replace(/^run:\s*/, '').split(/\s+/).slice(1))
      .filter(x => /^[a-z0-9][a-z0-9-]*$/.test(x))),
  };
}
function check(loaded) {
  const errors = [];
  const [rust, tooling, quality] = sources.map(p => loaded.get(p) ?? '');
  if (!/^\s*pull_request:\s*$/m.test(quality) ||
      !/branches:\s*\[staging,\s*main\]/.test(quality) ||
      !quality.includes('./gates/run --suite quality-rust') ||
      !quality.includes('./gates/run --suite quality-tooling')) {
    errors.push('Quality PR must unconditionally execute Rust and tooling suites');
  }
  const selected = getSelected(quality, rust, tooling);
  for (const [detector, tests, surface] of pairs) {
    if (!fs.existsSync(path.join(ROOT, 'gates/checks', detector + '.sh'))) {
      errors.push('missing canonical detector: ' + detector);
    }
    for (const id of tests) {
      if (!fs.existsSync(path.join(ROOT, 'gates/checks', id + '.sh'))) {
        errors.push('missing test Gate: ' + id);
      }
      if (!selected[surface].has(id)) {
        errors.push(detector + ': missing ' + id + ' from Quality ' + surface + ' selftests');
      }
    }
  }
  // The two detectors with built-in tests cannot silently lose them, and
  // design must continue running its independent negative source fixtures.
  const special = [
    ['gates/checks/instruction-contract.sh', 'node --test scripts/instruction-contract.test.mjs'],
    ['gates/checks/gate-runtime-contract.sh', 'gates/lib/common-selftest.sh'],
    ['gates/checks/gate-runtime-contract.sh', 'gates/run-selftest.sh'],
    ['design/scripts/design-gate.mjs', 'node --test design/scripts/*.test.mjs'],
    ['design/scripts/design-gate.mjs', 'node --test web/eslint-plugin-nession/__tests__/*.test.js'],
  ];
  for (const [file, snippet] of special) {
    if (!read(file).includes(snippet)) errors.push(file + ': missing embedded negative fixture ' + snippet);
  }
  if (!selected.tooling.has('detector-selftest-coverage')) {
    errors.push('Quality tooling must run detector-selftest-coverage itself');
  }
  return errors;
}
const initial = new Map(sources.map(p => [p, read(p)]));
assert.deepEqual(check(initial), [], 'baseline detector/self-test coverage must hold');
let mutations = 0;
for (const [detector, tests, surface] of pairs) {
  const file = surface === 'rust' ? sources[0] : surface === 'tooling' ? sources[1] : sources[2];
  for (const id of tests) {
    const copy = new Map(initial);
    const lines = copy.get(file).split(/\r?\n/);
    const mutated = lines.map(line => {
      if (surface === 'web' && line.includes('run: ./gates/run ') && line.split(/\s+/).includes(id))
        return line.split(/\s+/).filter(x => x !== id).join(' ');
      if (surface !== 'web' && line.trim() === id) return '# mutation removed ' + id;
      return line;
    });
    copy.set(file, mutated.join('\n'));
    assert.ok(check(copy).some(x => x.includes(detector + ': missing ' + id)),
      'selftest removal escaped coverage detector: ' + detector + '/' + id);
    mutations++;
  }
}
console.log('detector-selftest-coverage: ' + pairs.length + ' custom families and ' + mutations + ' negative mutations passed');
