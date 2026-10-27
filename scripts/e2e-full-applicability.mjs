#!/usr/bin/env node
// Owner: #2323 SC-06 / #2478 SC-01. Decide whether a change can affect the
// Full E2E suite (and whether any browser runtime is warranted at all), and
// emit an explicit Not Required receipt instead of silently skipping via a
// path filter. Unknown or unverifiable input fails closed to applicable.
//
// The policy is an ordered, auditable matrix:
//   tooling       known CI/Acceptance scheduler, ingestion and Gate tooling;
//   e2e-contract  E2E executor / selection / report contract, browser tests,
//                 fixtures, catalog and suite membership;
//   app-runtime   product runtime and build inputs;
//   unknown       anything not positively recognized (fail closed).
// Only a change whose every path is positively tooling may be `tooling-only`
// (Not Required). Mixed and unknown changes never silently downgrade.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Workflows that EXECUTE browser tests. Their routers/ingesters/schedulers are
// tooling; these are the runner/report contract and stay risk-bearing even
// though they live under .github/workflows/.
const E2E_EXECUTOR_WORKFLOWS = new Set([
  'e2e-tests.yml',
  'e2e-full-regression.yml',
  'e2e-scenario-smoke.yml',
  'acceptance-cases.yml',
  'acceptance-case-smoke.yml',
]);

function basename(file) {
  return file.slice(file.lastIndexOf('/') + 1);
}

function isE2ERisk(file) {
  if (file.startsWith('e2e/')) return true; // tests, fixtures, catalog, runner, Cases
  if (/^scripts\/(e2e-|issue-e2e-|ci\/)/.test(file)) return true;
  if (file.startsWith('.github/workflows/') &&
      E2E_EXECUTOR_WORKFLOWS.has(basename(file))) return true;
  // Browser gates define what browser evidence means; a change there can
  // invalidate prior design/E2E proof even though it cannot alter runtime.
  if (/^gates\/checks\/(e2e|.*playwright|.*browser)/i.test(file)) return true;
  // Suite membership decides which Gates run; it is part of the contract.
  if (file.startsWith('gates/suites/')) return true;
  return false;
}

function isRuntime(file) {
  return file.startsWith('crates/') ||
    file.startsWith('web/') ||
    file.startsWith('design/') ||
    file.startsWith('.cargo/') ||
    file === 'Cargo.toml' || file === 'Cargo.lock' ||
    file === 'rust-toolchain.toml';
}

function isTooling(file) {
  if (file.endsWith('.md') || file.startsWith('docs/')) return true;
  if (file.startsWith('gates/')) return true; // executor/suite paths handled first
  if (file.startsWith('.github/workflows/')) return true; // executor paths handled first
  if (file.startsWith('scripts/')) return true; // e2e/ci paths handled first
  return false;
}

export function categorizeChangedPath(file) {
  if (typeof file !== 'string' || !file || /[\r\n]/.test(file)) return 'unknown';
  // Documentation is tooling wherever it lives (web/AGENTS.md, e2e/README.md).
  if (file.endsWith('.md')) return 'tooling';
  if (isE2ERisk(file)) return 'e2e-contract';
  if (isRuntime(file)) return 'app-runtime';
  if (isTooling(file)) return 'tooling';
  return 'unknown';
}

const REASON = Object.freeze({
  'tooling-only': 'changed-paths-cannot-affect-runtime',
  'e2e-contract': 'e2e-runner-or-contract-change',
  'app-runtime': 'runtime-affecting-change',
  mixed: 'mixed-risk-change',
  unknown: 'unrecognized-changed-path',
});

export function classifyChangedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { applicable: true, category: 'unknown', reason: 'no-verifiable-change-scope', changed_paths: [] };
  }
  for (const file of paths) {
    if (typeof file !== 'string' || !file || /[\r\n]/.test(file)) {
      return { applicable: true, category: 'unknown', reason: 'unrecognized-changed-path', changed_paths: paths.slice(0, 50) };
    }
  }
  const entries = paths.map((file) => ({ file, category: categorizeChangedPath(file) }));
  const risk = entries.filter((entry) => entry.category !== 'tooling');
  if (risk.length === 0) {
    return {
      applicable: false, category: 'tooling-only',
      reason: REASON['tooling-only'], changed_paths: paths.slice(0, 50),
    };
  }
  const categories = new Set(entries.map((entry) => entry.category));
  const category = categories.has('unknown') ? 'unknown'
    : categories.size === 1 ? [...categories][0] : 'mixed';
  return {
    applicable: true,
    category,
    reason: REASON[category],
    changed_paths: risk.map((entry) => entry.file).slice(0, 50),
  };
}

export function notRequiredReceipt(sha, classification) {
  if (!/^[a-f0-9]{40}$/.test(String(sha ?? ''))) throw new Error('invalid target SHA');
  if (classification?.applicable !== false || classification?.category !== 'tooling-only') {
    throw new Error('receipt requires a not-required classification');
  }
  return {
    schema_version: 1,
    kind: 'e2e_full_not_required',
    target_sha: sha,
    category: classification.category,
    reason: classification.reason,
    changed_paths: classification.changed_paths,
    full_regression: 'NOT_REQUIRED',
  };
}

// #2478 SC-03: the Acceptance harness never reads artifacts. Emit the same Not
// Required decision as a bounded job-log receipt that a trusted collector can
// re-attest against the exact run/attempt and the scope job's own steps.
export const FULL_NOT_REQUIRED_LOG_PREFIX = 'E2E_FULL_NOT_REQUIRED_V1 ';
export function notRequiredLogReceipt({ runId, runAttempt, classification }) {
  const run = Number(runId);
  const attempt = Number(runAttempt);
  const sha = String(classification?.target_sha ?? '');
  if (!Number.isSafeInteger(run) || run <= 0 ||
      !Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new Error('invalid Full Not Required run identity');
  }
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('invalid target SHA');
  if (classification?.applicable !== false ||
      classification?.category !== 'tooling-only' ||
      classification?.reason !== REASON['tooling-only'] ||
      !Array.isArray(classification.changed_paths) ||
      classification.changed_paths.length > 50 ||
      classification.changed_paths.some((file) =>
        typeof file !== 'string' || !file || /[\r\n]/.test(file))) {
    throw new Error('log receipt requires a tooling-only classification');
  }
  return {
    schema_version: 1,
    kind: 'e2e_full_not_required',
    repository: 'BestNathan/nession',
    workflow: '.github/workflows/e2e-full-regression.yml',
    run_id: run,
    run_attempt: attempt,
    target_sha: sha,
    category: classification.category,
    reason: classification.reason,
    changed_paths: classification.changed_paths,
    full_regression: 'NOT_REQUIRED',
  };
}

function selfTest() {
  const tooling = [
    'docs/design/notes.md',
    'README.md',
    '.github/workflows/acceptance-orchestrator.yml',
    '.github/workflows/e2e-staging-lanes.yml', // scheduler, not executor
    '.github/workflows/e2e-full-failure-ingest.yml', // ingestion
    '.github/workflows/ci-quality.yml',
    'gates/checks/deployment-identity-selftest.sh',
    'scripts/staging-lane-admission-state.mjs',
    'scripts/staging-lane-scheduler.mjs',
    'scripts/acceptance-case-ingest.mjs',
    'scripts/deployment-binding-lookup.mjs',
  ];
  for (const file of tooling) {
    assert.equal(categorizeChangedPath(file), 'tooling', file + ' must be tooling');
  }
  const contract = [
    'e2e/tests/browser/login.spec.ts',
    'e2e/fixtures/server.js',
    'e2e/runner/test-catalog.cjs',
    'e2e/playwright.config.ts',
    'scripts/e2e-regression-policy.mjs',
    'scripts/issue-e2e-plan.mjs',
    'scripts/ci/try-web-build-reuse.sh',
    '.github/workflows/e2e-tests.yml',
    '.github/workflows/e2e-full-regression.yml',
    '.github/workflows/acceptance-cases.yml',
    'gates/checks/e2e-playwright.sh',
    'gates/checks/design-system-browser.sh',
    'gates/suites/quality-tooling.gates',
  ];
  for (const file of contract) {
    assert.equal(categorizeChangedPath(file), 'e2e-contract', file + ' must be E2E contract');
  }
  for (const file of ['crates/nession-agent/src/server/websocket.rs', 'web/src/App.tsx',
    'design/tokens.json', 'Cargo.lock']) {
    assert.equal(categorizeChangedPath(file), 'app-runtime', file + ' must be runtime');
  }
  for (const file of ['justfile', '.github/CODEOWNERS', 'terraform/main.tf']) {
    assert.equal(categorizeChangedPath(file), 'unknown', file + ' must fail closed as unknown');
  }

  // The real #2476 surface must be tooling-only (Not Required).
  const reproduction = classifyChangedPaths([
    '.github/workflows/e2e-staging-lanes.yml',
    'gates/checks/deployment-identity-selftest.sh',
    'scripts/staging-lane-admission-state.mjs',
  ]);
  assert.equal(reproduction.applicable, false);
  assert.equal(reproduction.category, 'tooling-only');

  // Matrix: tooling-only, contract, runtime, mixed, unknown.
  assert.deepEqual(classifyChangedPaths(['web/AGENTS.md', 'docs/a.md']).category, 'tooling-only');
  assert.equal(classifyChangedPaths(['e2e/tests/browser/login.spec.ts']).category, 'e2e-contract');
  assert.equal(classifyChangedPaths(['web/src/App.tsx']).category, 'app-runtime');
  assert.equal(classifyChangedPaths(['docs/a.md', 'web/src/App.tsx']).category, 'mixed');
  assert.equal(classifyChangedPaths(['scripts/acceptance-x.mjs', 'e2e/tests/y.ts']).category, 'mixed');
  assert.equal(classifyChangedPaths(['justfile']).category, 'unknown');
  assert.equal(classifyChangedPaths(['docs/a.md', 'justfile']).category, 'unknown',
    'an unknown path in a mixed change must fail closed');

  // Untrusted text cannot downgrade a risk-bearing path: a path carrying a
  // claim/newline is unrecognized, and Issue/PR prose is never an input.
  assert.equal(classifyChangedPaths(['crates/nession-agent/src/lib.rs\nnot-required']).category, 'unknown');
  assert.equal(classifyChangedPaths(['crates/nession-agent/src/server/websocket.rs']).applicable, true,
    'security-sensitive runtime stays applicable');

  // Empty/unverifiable scope fails closed.
  assert.equal(classifyChangedPaths([]).applicable, true);
  assert.equal(classifyChangedPaths([]).category, 'unknown');
  assert.equal(classifyChangedPaths(['']).applicable, true);

  const receipt = notRequiredReceipt('a'.repeat(40), reproduction);
  assert.equal(receipt.full_regression, 'NOT_REQUIRED');
  assert.equal(receipt.kind, 'e2e_full_not_required');
  assert.equal(receipt.category, 'tooling-only');
  assert.throws(() => notRequiredReceipt('main', reproduction), /invalid target SHA/);
  assert.throws(() => notRequiredReceipt('a'.repeat(40), { applicable: true }), /not-required classification/);
  assert.throws(() => notRequiredReceipt('a'.repeat(40),
    { applicable: false, category: 'e2e-contract' }), /not-required classification/);
  // #2478 SC-03: the job-log receipt binds the exact run identity and only a
  // positively tooling-only decision may be emitted.
  const target = 'a'.repeat(40);
  const logReceipt = notRequiredLogReceipt({ runId: 12, runAttempt: 2,
    classification: { ...reproduction, target_sha: target } });
  assert.equal(logReceipt.run_id, 12);
  assert.equal(logReceipt.run_attempt, 2);
  assert.equal(logReceipt.target_sha, target);
  assert.equal(logReceipt.full_regression, 'NOT_REQUIRED');
  assert.throws(() => notRequiredLogReceipt({ runId: 0, runAttempt: 1,
    classification: { ...reproduction, target_sha: target } }), /run identity/);
  assert.throws(() => notRequiredLogReceipt({ runId: 12, runAttempt: 2,
    classification: { ...reproduction, target_sha: 'main' } }), /invalid target SHA/);
  assert.throws(() => notRequiredLogReceipt({ runId: 12, runAttempt: 2,
    classification: { ...classifyChangedPaths(['web/src/App.tsx']), target_sha: target } }),
  /tooling-only classification/);
  assert.throws(() => notRequiredLogReceipt({ runId: 12, runAttempt: 2,
    classification: { ...reproduction, target_sha: target,
      changed_paths: ['scripts/a.mjs\nnot-required'] } }), /tooling-only classification/);
  console.log('e2e full applicability: impact matrix, fail-closed negatives and Not Required receipt fixtures passed');
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'self-test') return selfTest();
  if (command === 'log-receipt') {
    const [classFile] = args;
    if (!classFile) throw new Error('usage: log-receipt CLASSIFICATION_JSON');
    const classification = JSON.parse(fs.readFileSync(classFile, 'utf8'));
    process.stdout.write(FULL_NOT_REQUIRED_LOG_PREFIX + JSON.stringify(
      notRequiredLogReceipt({ runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT, classification })) + '\n');
    return;
  }
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
  throw new Error('usage: self-test | classify PATHS_JSON OUT_JSON [SHA] | log-receipt CLASSIFICATION_JSON');
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    main();
  } catch (error) {
    console.error('e2e-full-applicability: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 2;
  }
}
