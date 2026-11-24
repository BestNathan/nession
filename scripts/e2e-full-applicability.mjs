#!/usr/bin/env node
// Owner: #2323 SC-06 / #2478 SC-01. Decide whether a change can affect the
// Full E2E suite (and whether any browser runtime is warranted at all), and
// emit an explicit Not Required receipt instead of silently skipping via a
// path filter. Unknown or unverifiable input fails closed to applicable.
//
// The policy is an ordered, auditable six-category matrix (#2478 SC-01):
//   tooling              known CI/Acceptance scheduler, ingestion and Gate
//                        tooling;
//   e2e-runner           E2E executor / selection / report contract, browser
//                        tests, test support and Gate suite membership;
//   app-runtime          product runtime and build inputs;
//   e2e-fixture-catalog  browser fixtures, scenario fixtures and the Case
//                        catalog/verifiers that decide what is executed;
//   unknown              anything not positively recognized (fail closed).
// A change whose every path is positively tooling is `tooling-only`
// (Not Required); a change spanning several risk categories is `mixed`. Mixed
// and unknown changes never silently downgrade.
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

function isE2ERunner(file) {
  // The executor, selection/report contract, browser tests, test support and
  // suite membership are implementation, not data.
  //
  // `e2e/run` is the canonical CLI entrypoint: it selects the Issue-owned
  // Cases and provisions the suite. Leaving it in `unknown` fails the whole
  // convergence batch closed for a runner file that cannot affect product
  // runtime by itself (measured on the main->staging integration batch).
  if (file === 'e2e/run') return true;
  if (file.startsWith('e2e/runner/')) return true;
  if (file.startsWith('e2e/tests/')) return true;
  // #4454: standalone Pages browser tests run under their own Playwright
  // config outside the product testDir; they are runner code, not data.
  if (file.startsWith('e2e/pages/')) return true;
  // #4477: the standalone Pages runner's config/global setup execute that
  // suite; they are runner contract, not unrecognized data.
  if (file === 'e2e/playwright.pages.config.ts' ||
      file === 'e2e/pagesGlobalSetup.mjs') return true;
  if (file.startsWith('e2e/acceptance/evaluator/') ||
      file.startsWith('e2e/acceptance/contract/') ||
      file.startsWith('e2e/acceptance/shared/')) return true;
  if (file.startsWith('e2e/helpers/')) return true;
  if (file === 'e2e/playwright.config.ts') return true;
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

function isE2EFixtureCatalog(file) {
  // Data that decides what the runner executes: browser fixtures, scenario
  // fixtures and the Case catalog with its verifiers.
  if (file.startsWith('e2e/fixtures/')) return true;
  if (file.startsWith('e2e/scenarios/')) return true;
  if (file.startsWith('e2e/acceptance/cases/')) return true;
  return false;
}

function isRuntime(file) {
  // Root ignore rules determine which sources/build inputs become visible to
  // the checkout (e.g. EROFS build modules). Never classify them as tooling.
  //
  // Container and deployment assets are also build inputs: a Dockerfile and
  // the deploy entrypoints/Compose/nginx projection decide what the shipped
  // process executes. Leaving them "unknown" makes an otherwise scoped
  // main->staging batch unmergeable (measured on the #3791 MCP image sync).
  //
  // #4454: shipped public Pages assets are runtime-affecting. The React/Vite
  // migration keeps the two HTML entrypoints directly under pages/, the stable
  // public CSS/favicon under pages/public/, and all compiled UI source under
  // pages/src/. These are not tooling or build scripts; they are the shipped
  // public UI. Nested test and publisher script subtrees are handled
  // separately (tooling/test-only or runtime build inputs).
  //
  // #4477: the migration's trusted Pages build pipeline (pages/scripts/**)
  // assembles the shipped artifact and produces its manifest/readback. Like
  // Dockerfile*/deploy/ it is a build input, so it must stay risk-bearing
  // app-runtime rather than an unknown scope that blocks convergence.
  if (/^pages\/[^/]+\.(js|css|html|svg)$/.test(file)) return true;
  if (file.startsWith('pages/public/') || file.startsWith('pages/src/') ||
      file.startsWith('pages/scripts/')) return true;
  if (file === 'pages/package.json' || file === 'pages/package-lock.json' ||
      file === 'pages/vite.config.ts' || file === 'pages/tsconfig.json') return true;
  return file === '.gitignore' ||
    file.startsWith('crates/') ||
    file.startsWith('web/') ||
    file.startsWith('design/') ||
    file.startsWith('.cargo/') ||
    file === 'Cargo.toml' || file === 'Cargo.lock' ||
    file === 'rust-toolchain.toml' ||
    file === 'Dockerfile' || file.startsWith('Dockerfile.') ||
    file.startsWith('deploy/');
}

function isTooling(file) {
  if (file.endsWith('.md') || file.startsWith('docs/')) return true;
  // #4018: Pages' Node.js test-only sources under pages/tests/ are not shipped
  // by the compiled UI. Do not broaden this to pages/ source/public assets
  // (runtime) or the Pages build pipeline (pages/scripts/, runtime build
  // inputs): those may change the public runtime and must remain risk-bearing.
  if (file.startsWith('pages/tests/')) return true;
  // #4477: repository developer tooling cannot affect product runtime or the
  // E2E suite: Claude worktree hooks and just recipes, plus the E2E tree's
  // ignore rules. Only these exact surfaces are trusted, not arbitrary
  // dotfiles.
  if (file === 'justfile' || file.startsWith('.claude/') ||
      file === 'e2e/.gitignore') return true;
  if (file.startsWith('gates/')) return true; // executor/suite paths handled first
  if (file.startsWith('.github/workflows/')) return true; // executor paths handled first
  if (file.startsWith('scripts/')) return true; // e2e/ci paths handled first
  return false;
}

export function categorizeChangedPath(file) {
  if (typeof file !== 'string' || !file || /[\r\n]/.test(file)) return 'unknown';
  // Documentation is tooling wherever it lives (web/AGENTS.md, e2e/README.md).
  if (file.endsWith('.md')) return 'tooling';
  if (isE2ERunner(file)) return 'e2e-runner';
  if (isE2EFixtureCatalog(file)) return 'e2e-fixture-catalog';
  if (isRuntime(file)) return 'app-runtime';
  if (isTooling(file)) return 'tooling';
  return 'unknown';
}

const REASON = Object.freeze({
  'tooling-only': 'changed-paths-cannot-affect-runtime',
  'e2e-runner': 'e2e-runner-or-contract-change',
  'e2e-fixture-catalog': 'e2e-fixture-or-catalog-change',
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
    'pages/tests/public-deployment.test.mjs', // #4018: publisher verification, not public runtime
    // #4477: repository developer tooling, not product runtime/E2E behavior
    'justfile', '.claude/hooks/create-worktree.sh', 'e2e/.gitignore',
  ];
  for (const file of tooling) {
    assert.equal(categorizeChangedPath(file), 'tooling', file + ' must be tooling');
  }
  const runner = [
    'e2e/run',
    'e2e/tests/browser/login.spec.ts',
    'e2e/runner/test-catalog.cjs',
    'e2e/runner/runtime/full-stack.cjs',
    'e2e/acceptance/evaluator/run-case.mjs',
    'e2e/acceptance/contract/cases.mjs',
    'e2e/acceptance/shared/terminal-sizing-cases.cjs',
    'e2e/helpers/wait.ts',
    'e2e/playwright.config.ts',
    // #4454: standalone Pages browser tests run under their own config
    'e2e/pages/knowledge.test.ts',
    // #4477: the standalone Pages runner config/global setup are runner contract
    'e2e/playwright.pages.config.ts', 'e2e/pagesGlobalSetup.mjs',
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
  for (const file of runner) {
    assert.equal(categorizeChangedPath(file), 'e2e-runner', file + ' must be E2E runner');
  }
  // The canonical CLI wrapper is the runner entrypoint, not an unrecognized
  // path: without this classification a main->staging integration batch that
  // carries only runner/tooling changes is rejected as `unknown`.
  assert.equal(categorizeChangedPath('e2e/run'), 'e2e-runner',
    'e2e/run is the canonical E2E runner entrypoint');
  const fixtureCatalog = [
    'e2e/fixtures/server.js',
    'e2e/fixtures/browser/state.json',
    'e2e/scenarios/terminal-attach-resume/case.json',
    'e2e/acceptance/cases/2487/SC-09/case.yaml',
    'e2e/acceptance/cases/2520/SC-03/verify.cjs',
  ];
  for (const file of fixtureCatalog) {
    assert.equal(categorizeChangedPath(file), 'e2e-fixture-catalog',
      file + ' must be E2E fixture/catalog');
  }
  for (const file of ['crates/nession-agent/src/server/websocket.rs', 'web/src/App.tsx',
    'design/tokens.json', 'Cargo.lock',
    // #3791: container/deploy assets are runtime build inputs, not an
    // unrecognized scope that blocks a main->staging integration batch.
    'Dockerfile', 'Dockerfile.server', 'Dockerfile.mcp.prebuilt',
    'deploy/docker-compose.yml', 'deploy/docker-compose.mcp.yml',
    'deploy/mcp.example.toml', 'deploy/entrypoint-server.sh',
    // #4454: shipped public Pages surfaces are runtime-affecting (HTML
    // entrypoints, React/TS UI source, stable public assets, locked build)
    'pages/index.html', 'pages/workflows.html',
    'pages/src/app/App.tsx', 'pages/src/features/knowledge/KnowledgePage.tsx',
    'pages/public/styles.css', 'pages/public/favicon.svg', 'pages/favicon.svg',
    'pages/package.json', 'pages/package-lock.json', 'pages/vite.config.ts',
    'pages/tsconfig.json',
    // #4477: the trusted Pages build/assembly/publisher pipeline is a build input
    'pages/scripts/build.mjs', 'pages/scripts/build-data.mjs',
    'pages/scripts/assemble.mjs', 'pages/scripts/artifact-manifest.mjs',
    'pages/scripts/mcp-export-gate.mjs', 'pages/scripts/verify-published-artifact.mjs']) {
    assert.equal(categorizeChangedPath(file), 'app-runtime', file + ' must be runtime');
  }
  // #3520: the root .gitignore can expose/hide build inputs, not just docs.
  // PR #3515 combined EROFS source, Case catalog, workflow and ignore-rule
  // changes, so its historical scope must be known mixed risk, never unknown
  // and never Not Required.
  assert.equal(categorizeChangedPath('.gitignore'), 'app-runtime');
  const ignoreRules = classifyChangedPaths(['.gitignore']);
  assert.equal(ignoreRules.category, 'app-runtime');
  assert.equal(ignoreRules.applicable, true);
  const historicalConvergence = classifyChangedPaths([
    '.github/workflows/store-qwen-publisher.yml',
    '.gitignore',
    'crates/nession-erofs/src/build/import.rs',
    'e2e/acceptance/cases/3498/SC-04/verify.cjs',
  ]);
  assert.equal(historicalConvergence.category, 'mixed');
  assert.equal(historicalConvergence.applicable, true);
  // #3791: the standalone MCP image release batch mixes tooling, a new
  // Dockerfile and deploy samples. It must be known mixed risk, not an
  // `unknown` scope that blocks the main->staging integration.
  const mcpImageConvergence = classifyChangedPaths([
    '.github/workflows/release-staging.yml',
    'Dockerfile.mcp.prebuilt',
    'deploy/docker-compose.mcp.yml',
    'deploy/mcp.example.toml',
    'scripts/mcp-standalone-image.mjs',
  ]);
  assert.equal(mcpImageConvergence.category, 'mixed');
  assert.equal(mcpImageConvergence.applicable, true);
  // #4018: actual #4017 integration changed only the Pages publisher router
  // and a Node.js test. This pair is known tooling, not unknown or browser
  // runner code. It cannot bypass the normal PR Quality required checks.
  const pagesTestConvergence = classifyChangedPaths([
    '.github/workflows/deploy-pages.yml',
    'pages/tests/public-deployment.test.mjs',
  ]);
  assert.equal(pagesTestConvergence.category, 'tooling-only');
  assert.equal(pagesTestConvergence.applicable, false);
  assert.equal(notRequiredReceipt('a'.repeat(40),pagesTestConvergence).full_regression,
    'NOT_REQUIRED');
  // #4454: shipped public Pages assets are runtime-affecting. The React/Vite
  // migration groups them under pages/src and pages/public while keeping the
  // HTML entrypoints at pages/. This batch stays mixed (tooling + runner +
  // runtime) and applicable; an unknown path still fails closed.
  const pagesShippedConvergence = classifyChangedPaths([
    '.github/workflows/metrics-agent-telemetry.yml',
    'e2e/pages/knowledge.test.ts',
    'pages/src/features/knowledge/KnowledgePage.tsx',
    'pages/public/styles.css',
    'scripts/acceptance-4342-downstream-evidence.mjs',
    'scripts/agent-telemetry-reconcile.mjs',
    'scripts/run-store-inventory.mjs',
  ]);
  assert.equal(pagesShippedConvergence.category, 'mixed');
  assert.equal(pagesShippedConvergence.applicable, true);
  // Negative: an unknown path in the same batch must still fail closed
  assert.equal(classifyChangedPaths([
    'e2e/pages/knowledge.test.ts',
    'pages/src/app/App.tsx',
    'unknown/path/that/does/not/exist.ts',
  ]).category, 'unknown', 'an unknown path must still fail closed alongside known Pages paths');
  // #4477: the Pages migration made pages/scripts/** the trusted build
  // pipeline for the shipped public artifact. They are risk-bearing runtime
  // build inputs (never tooling-only, never unknown) while the Pages test
  // subtree remains tooling.
  assert.equal(classifyChangedPaths([
    'pages/tests/public-deployment.test.mjs','pages/scripts/build.mjs',
  ]).category,'mixed','Pages build inputs must stay risk-bearing, not tooling-only');
  // Exact 13-path batch from PR #4474 integration head
  // bb48184ec2d2ada20dd63420bc14e7188e337418 after #4462/#4470 merged to
  // main. Every path must be positively classified; the batch is mixed and
  // applicable, and a truly unknown path in the same batch still fails closed.
  const convergenceBatch = [
    '.claude/hooks/create-worktree.sh',
    'e2e/.gitignore',
    'e2e/pagesGlobalSetup.mjs',
    'e2e/playwright.pages.config.ts',
    'justfile',
    'pages/favicon.svg',
    'pages/scripts/artifact-manifest.mjs',
    'pages/scripts/assemble.mjs',
    'pages/scripts/build-data.mjs',
    'pages/scripts/build.mjs',
    'pages/scripts/dev-fixtures.ts',
    'pages/scripts/mcp-export-gate.mjs',
    'pages/scripts/verify-published-artifact.mjs',
  ];
  for(const file of convergenceBatch){
    assert.notEqual(categorizeChangedPath(file),'unknown',file+' must be positively classified');
  }
  const convergenceBatchClass=classifyChangedPaths(convergenceBatch);
  assert.equal(convergenceBatchClass.category,'mixed');
  assert.equal(convergenceBatchClass.applicable,true);
  assert.equal(classifyChangedPaths([...convergenceBatch,'terraform/main.tf']).category,
    'unknown','an unknown path must still fail closed in the same batch');
  assert.equal(classifyChangedPaths([
    'pages/tests/public-deployment.test.mjs','web/src/App.tsx',
  ]).category,'mixed','Pages test-only paths must not hide runtime changes');
  assert.throws(() => notRequiredReceipt('a'.repeat(40), ignoreRules),
    /not-required classification/,
    'build-input ignore changes must never emit a Full Not Required receipt');
  assert.equal(classifyChangedPaths(['.gitignore', 'terraform/main.tf']).category, 'unknown',
    'truly unrecognized paths must still fail closed in the same batch');
  assert.equal(categorizeChangedPath('local/.gitignore'), 'unknown',
    'root path recognition must not broadly trust arbitrary nested dotfiles');

  for (const file of ['.github/CODEOWNERS', 'terraform/main.tf']) {
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

  // Six-category matrix: tooling-only, runner contract, app runtime,
  // fixture/catalog, mixed and unknown. Every risk-bearing category stays
  // applicable; only an all-tooling change is Not Required.
  assert.deepEqual(classifyChangedPaths(['web/AGENTS.md', 'docs/a.md']).category, 'tooling-only');
  assert.equal(classifyChangedPaths(['e2e/tests/browser/login.spec.ts']).category, 'e2e-runner');
  assert.equal(classifyChangedPaths(['web/src/App.tsx']).category, 'app-runtime');
  assert.equal(classifyChangedPaths(['e2e/fixtures/server.js']).category, 'e2e-fixture-catalog');
  assert.equal(classifyChangedPaths(['e2e/acceptance/cases/2487/SC-09/case.yaml']).category,
    'e2e-fixture-catalog');
  assert.equal(classifyChangedPaths(['docs/a.md', 'web/src/App.tsx']).category, 'mixed');
  assert.equal(classifyChangedPaths(['scripts/acceptance-x.mjs', 'e2e/tests/y.ts']).category, 'mixed');
  assert.equal(classifyChangedPaths(['e2e/fixtures/server.js', 'e2e/tests/browser/y.ts']).category,
    'mixed', 'runner and fixture/catalog changes are distinct risks');
  assert.equal(classifyChangedPaths(['e2e/acceptance/cases/2487/SC-09/verify.cjs',
    'crates/nession-agent/src/lib.rs']).category, 'mixed');
  assert.equal(classifyChangedPaths(['justfile']).category, 'tooling-only');
  assert.equal(classifyChangedPaths(['terraform/main.tf']).category, 'unknown');
  assert.equal(classifyChangedPaths(['docs/a.md', 'terraform/main.tf']).category, 'unknown',
    'an unknown path in a mixed change must fail closed');
  for (const category of ['e2e-runner', 'e2e-fixture-catalog', 'app-runtime', 'mixed', 'unknown']) {
    assert.equal(classifyChangedPaths(category === 'e2e-runner'
      ? ['e2e/tests/browser/login.spec.ts']
      : category === 'e2e-fixture-catalog'
        ? ['e2e/fixtures/server.js']
        : category === 'app-runtime'
          ? ['web/src/App.tsx']
          : category === 'mixed'
            ? ['web/src/App.tsx', 'e2e/fixtures/server.js']
            : ['terraform/main.tf']).applicable, true, category + ' must stay applicable');
  }

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
    { applicable: false, category: 'e2e-runner' }), /not-required classification/);
  assert.throws(() => notRequiredReceipt('a'.repeat(40),
    { applicable: false, category: 'e2e-fixture-catalog' }), /not-required classification/);
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
