#!/usr/bin/env node
// Owner: #2323 SC-06. Decide whether a Main push can affect the Full E2E
// suite and emit an explicit Not Required receipt instead of silently
// skipping via a path filter. Unknown or unverifiable input fails closed to
// applicable, so a real runtime change can never be mistaken for a no-op.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const NON_RUNTIME = [
  (file) => file.endsWith('.md'),
  (file) => file.startsWith('docs/'),
  (file) => file.startsWith('.github/workflows/'),
];

export function classifyChangedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { applicable: true, reason: 'no-verifiable-change-scope', changed_paths: [] };
  }
  for (const file of paths) {
    if (typeof file !== 'string' || !file || /[\r\n]/.test(file)) {
      return { applicable: true, reason: 'unrecognized-changed-path', changed_paths: paths.slice(0, 50) };
    }
  }
  const runtime = paths.filter((file) => !NON_RUNTIME.some((rule) => rule(file)));
  if (runtime.length === 0) {
    return { applicable: false, reason: 'changed-paths-cannot-affect-runtime', changed_paths: paths.slice(0, 50) };
  }
  return { applicable: true, reason: 'runtime-affecting-change', changed_paths: runtime.slice(0, 50) };
}

export function notRequiredReceipt(sha, classification) {
  if (!/^[a-f0-9]{40}$/.test(String(sha ?? ''))) throw new Error('invalid target SHA');
  if (classification?.applicable !== false) throw new Error('receipt requires a not-required classification');
  return {
    schema_version: 1,
    kind: 'e2e_full_not_required',
    target_sha: sha,
    reason: classification.reason,
    changed_paths: classification.changed_paths,
    full_regression: 'NOT_REQUIRED',
  };
}

function selfTest() {
  assert.deepEqual(classifyChangedPaths(['docs/design/notes.md']),
    { applicable: false, reason: 'changed-paths-cannot-affect-runtime', changed_paths: ['docs/design/notes.md'] });
  assert.equal(classifyChangedPaths(['README.md']).applicable, false);
  assert.equal(classifyChangedPaths(['.github/workflows/e2e-full-regression.yml']).applicable, false);
  assert.equal(classifyChangedPaths(['web/AGENTS.md', 'docs/architecture/x.md']).applicable, false);
  assert.equal(classifyChangedPaths(['crates/nession-server/src/lib.rs']).applicable, true);
  assert.equal(classifyChangedPaths(['docs/a.md', 'scripts/e2e-full-applicability.mjs']).applicable, true);
  assert.equal(classifyChangedPaths(['e2e/tests/browser/login.spec.ts']).applicable, true);
  assert.equal(classifyChangedPaths(['justfile']).applicable, true);
  assert.equal(classifyChangedPaths([]).applicable, true, 'unverifiable scope must fail closed to applicable');
  assert.equal(classifyChangedPaths(['']).applicable, true, 'unrecognized path must fail closed to applicable');
  const receipt = notRequiredReceipt('a'.repeat(40), classifyChangedPaths(['docs/x.md']));
  assert.equal(receipt.full_regression, 'NOT_REQUIRED');
  assert.equal(receipt.kind, 'e2e_full_not_required');
  assert.throws(() => notRequiredReceipt('main', classifyChangedPaths(['docs/x.md'])), /invalid target SHA/);
  assert.throws(() => notRequiredReceipt('a'.repeat(40), { applicable: true }), /not-required classification/);
  console.log('e2e full applicability: path classification and Not Required receipt fixtures passed');
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'self-test') return selfTest();
  if (command === 'classify') {
    const [pathsFile, outFile] = args;
    if (!pathsFile || !outFile) throw new Error('usage: classify PATHS_JSON OUT_JSON [SHA]');
    const paths = JSON.parse(fs.readFileSync(pathsFile, 'utf8'));
    const sha = args[2] ?? process.env.GITHUB_SHA ?? '';
    const classification = classifyChangedPaths(paths);
    fs.writeFileSync(outFile, JSON.stringify({ ...classification, target_sha: sha }, null, 2) + '\n');
    if (!classification.applicable) {
      const receiptFile = path.join(path.dirname(outFile), 'e2e-full-not-required.json');
      fs.writeFileSync(receiptFile, JSON.stringify(notRequiredReceipt(sha, classification), null, 2) + '\n');
    }
    process.stdout.write(classification.applicable + '\n');
    return;
  }
  throw new Error('usage: self-test | classify PATHS_JSON OUT_JSON [SHA]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    main();
  } catch (error) {
    console.error('e2e-full-applicability: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 2;
  }
}
