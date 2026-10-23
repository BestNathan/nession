#!/usr/bin/env node
// #2031: applicability of the canonical Quality and E2E PR sources for one
// exact change set. The workflow YAML owns `pull_request.paths` routing; this
// script only interprets that text. An absent source run is `waiting` when the
// diff is applicable and explicit `not-required` only when it is not.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isApplicable} from './lib/workflow-pr-paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = Object.freeze({quality: 'ci-quality.yml', e2e: 'e2e-tests.yml'});
const MAX_FILES = 3000;

export function sourceApplicability(changedFiles, {truncated = false, rootDir = root} = {}) {
  if (typeof truncated !== 'boolean') throw Error('invalid truncation flag');
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    throw Error('changed file list is empty or invalid');
  }
  if (changedFiles.length > MAX_FILES) {
    throw Error('changed file list exceeds the bounded applicability window');
  }
  // GitHub caps the pull-files endpoint at 3000 entries. An incomplete list
  // cannot prove that a source is inapplicable, so it fails closed.
  if (truncated) return {quality: true, e2e: true, truncated: true};
  const result = {truncated: false};
  for (const [key, file] of Object.entries(WORKFLOWS)) {
    result[key] = isApplicable(
      fs.readFileSync(path.join(rootDir, '.github/workflows', file), 'utf8'),
      changedFiles,
    );
  }
  return result;
}

function selfTest() {
  const cases = [
    ['workflow-only', ['.github/workflows/agent-controller-dispatch.yml'], {quality: true, e2e: false}],
    ['quality-yaml', ['.github/workflows/ci-quality.yml'], {quality: true, e2e: false}],
    ['e2e-yaml', ['.github/workflows/e2e-tests.yml'], {quality: true, e2e: true}],
    ['rust-only', ['crates/nession-server/src/lib.rs'], {quality: true, e2e: true}],
    ['web-only', ['web/src/App.tsx'], {quality: true, e2e: true}],
    ['design-only', ['design/tokens.json'], {quality: true, e2e: true}],
    ['e2e-case', ['e2e/acceptance/cases/1258/SC-03/verify.js'], {quality: true, e2e: true}],
    ['gate', ['gates/checks/quality.sh'], {quality: true, e2e: true}],
    ['script', ['scripts/acceptance-dependency-state.mjs'], {quality: true, e2e: true}],
    ['automation', ['automation/collector.mjs'], {quality: true, e2e: false}],
    ['clippy', ['clippy.toml'], {quality: true, e2e: false}],
    ['rust-toolchain', ['rust-toolchain.toml'], {quality: true, e2e: true}],
    ['cargo-config', ['.cargo/config.toml'], {quality: true, e2e: true}],
    ['justfile', ['justfile'], {quality: true, e2e: true}],
    ['docs-only', ['docs/engineering/notes.md'], {quality: false, e2e: false}],
  ];
  for (const [name, files, expected] of cases) {
    const actual = sourceApplicability(files);
    assert.deepEqual(
      {quality: actual.quality, e2e: actual.e2e},
      expected,
      `${name} applicability mismatch`,
    );
    assert.equal(actual.truncated, false, `${name} must not claim truncation`);
  }
  // A mixed diff is applicable to a source if any changed path matches.
  assert.deepEqual(
    (({quality, e2e}) => ({quality, e2e}))(
      sourceApplicability(['docs/engineering/notes.md', 'crates/nession-server/src/lib.rs']),
    ),
    {quality: true, e2e: true},
  );
  // Conservative fail-closed shapes.
  assert.deepEqual(sourceApplicability(['docs/x.md'], {truncated: true}),
    {quality: true, e2e: true, truncated: true});
  assert.throws(() => sourceApplicability([]), /empty or invalid/);
  assert.throws(() => sourceApplicability(['docs/x.md'], {truncated: 'yes'}), /truncation/);
  assert.throws(() => sourceApplicability(Array.from({length: MAX_FILES + 1}, (_, i) => `f/${i}`)),
    /bounded applicability window/);
  assert.throws(() => sourceApplicability(['x'], {rootDir: path.join(root, 'missing')}), /ENOENT/);
  console.log(`Acceptance source applicability: ${cases.length} exact-diff fixtures and fail-closed negatives passed`);
}

function parseFlag(name) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!hit) return false;
  const value = hit.slice(name.length + 3);
  if (value !== 'true' && value !== 'false') throw Error(`--${name} must be true or false`);
  return value === 'true';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  if (command === 'self-test') selfTest();
  else if (command === 'classify') {
    const file = process.argv[3];
    if (!file) throw Error('usage: classify PR_FILES_JSON [--truncated=true|false]');
    const files = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(`${JSON.stringify(sourceApplicability(files, {
      truncated: parseFlag('truncated'),
    }))}\n`);
  } else {
    throw Error('usage: self-test | classify PR_FILES_JSON [--truncated=true|false]');
  }
}
