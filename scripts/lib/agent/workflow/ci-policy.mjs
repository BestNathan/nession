// Issue #4528 — CI obligation policy composition.
//
// The expected check set is NOT inferred from observed check-runs and is NOT a
// new check catalog. This module composes existing trusted owners:
//   - server-side branch protection (the required-check policy; never inferred
//     from workflow YAML);
//   - `scripts/ci/quality-scope.mjs` (Quality family applicability);
//   - the Issue-selected E2E/Case applicability supplied by their existing
//     trusted selectors;
//   - `scripts/staging-convergence-automerge.mjs` (the merge-admission status
//     context that is not source CI and therefore stays outside the pre-review
//     barrier).
//
// Adapters translate those decisions into declarations; `freezeCiObligation`
// then freezes them before any observation. A newly required context this
// adapter cannot classify is retained as `unknown` (fail closed) rather than
// silently dropped.
import { QUALIFICATION_CONTEXT } from '../../../staging-convergence-automerge.mjs';
import { selectQualityFamilies } from '../../../ci/quality-scope.mjs';

const APPLICABILITY = new Set(['applicable', 'not_applicable', 'unknown']);
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._ /()-]{0,199}$/;
const MAX_CONTEXTS = 64;

function reject(message) {
  throw new Error('agent workflow ci-policy: ' + message);
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function applicability(value, label) {
  if (!APPLICABILITY.has(value)) reject('invalid ' + label + ' applicability');
  return value;
}

function qualityDeclaration(name, { applicability: applies, category = 'source' }) {
  return {
    name,
    workflow: 'ci-quality.yml',
    applicability: applies,
    category,
    required: true,
    allow_neutral: false,
    run_path: '.github/workflows/ci-quality.yml',
    producer_app_slug: 'github-actions',
  };
}

// The Quality workflow jobs are path-scoped. `web-check` is the stable
// required aggregate and always runs on a PR; `rust-check` is skipped (at the
// stable context) only when the trusted trusted-main scope proves the Rust
// family not applicable.
export function qualityChecksFromFamilies(families) {
  if (families == null || typeof families !== 'object' || Array.isArray(families) ||
      typeof families.rust !== 'boolean' || typeof families.web !== 'boolean' ||
      typeof families.tooling !== 'boolean' ||
      !['scoped', 'unknown'].includes(families.applicability)) {
    reject('invalid Quality families');
  }
  const unknown = families.applicability === 'unknown';
  return [
    qualityDeclaration('rust-check', {
      applicability: unknown ? 'unknown' : families.rust ? 'applicable' : 'not_applicable',
    }),
    qualityDeclaration('web-check', {
      applicability: unknown ? 'unknown' : 'applicable',
    }),
  ];
}

// Issue-selected browser obligations. The selector decides applicability; this
// adapter only maps its decision onto the stable check contexts. `unknown`
// stays required (fail closed).
export function browserChecks({ e2e = 'unknown', cases = 'unknown' } = {}) {
  return [
    {
      name: 'e2e',
      workflow: 'e2e-tests.yml',
      applicability: applicability(e2e, 'E2E'),
      category: 'source',
      required: true,
      allow_neutral: false,
      run_path: '.github/workflows/e2e-tests.yml',
      producer_app_slug: 'github-actions',
    },
    {
      name: 'case-smoke',
      workflow: 'acceptance-case-smoke.yml',
      applicability: applicability(cases, 'Case'),
      category: 'source',
      required: true,
      allow_neutral: false,
      run_path: '.github/workflows/acceptance-case-smoke.yml',
      producer_app_slug: 'github-actions',
    },
  ];
}

// Map the server-side required-check policy into declarations. The caller
// supplies an already-authenticated response; no YAML is parsed and no local
// context list is kept here. `merge_admission_contexts` defaults to the single
// existing owner; a native Convergence qualification status is merge evidence,
// not source CI.
export function declarationsFromRequiredChecks({
  requiredChecks, families, e2e = 'unknown', cases = 'unknown',
  merge_admission_contexts = [QUALIFICATION_CONTEXT],
}) {
  if (!Array.isArray(requiredChecks) || requiredChecks.length > MAX_CONTEXTS) {
    reject('unbounded required-check policy');
  }
  if (!Array.isArray(merge_admission_contexts)) reject('invalid merge-admission contexts');
  const mergeAdmission = new Set(merge_admission_contexts);
  const quality = new Map(
    qualityChecksFromFamilies(families).map((entry) => [entry.name, entry]));
  const declarations = [];
  const seen = new Set();
  for (const entry of requiredChecks) {
    const context = entry?.context;
    if (typeof context !== 'string' || !CONTEXT.test(context)) {
      reject('invalid required-check context');
    }
    if (seen.has(context)) reject('duplicate required-check context');
    seen.add(context);
    if (mergeAdmission.has(context)) continue;
    if (context === 'rust-check' || context === 'web-check') {
      declarations.push(quality.get(context));
      continue;
    }
    declarations.push({
      name: context,
      workflow: 'required-check',
      applicability: 'unknown',
      category: 'source',
      required: true,
      allow_neutral: false,
      run_path: null,
      producer_app_slug: null,
    });
  }
  // Quality aggregates are required by the server-side policy; adding the
  // browser checks is safe only because their workflows run on every PR. The
  // Issue selector can prove one not applicable.
  declarations.push(...browserChecks({ e2e, cases }));
  return declarations;
}

// Read-only server-side policy fetch. Failures are surfaced (never converted
// into a smaller obligation): the caller records an unavailable observation.
export async function readRequiredChecks({ fetchGitHub, branch }) {
  if (typeof fetchGitHub !== 'function') reject('GitHub reader required');
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) ||
      branch.split('/').includes('..')) {
    reject('invalid protected branch');
  }
  const response = await fetchGitHub(
    'branches/' + encodeURIComponent(branch) + '/protection/required_status_checks');
  const checks = response?.checks;
  if (!Array.isArray(checks) || checks.length > MAX_CONTEXTS) {
    reject('required-check policy unavailable');
  }
  return checks.map((entry) => ({
    context: entry.context,
    app_id: entry.app_id,
  }));
}

// The PR changed-path source for Quality applicability. Bounded pagination:
// a diff larger than the bound is `unknown` and therefore fail closed.
export async function readChangedPaths({ fetchGitHub, pullNumber, maxFiles = 300 }) {
  if (!positive(pullNumber) || !Number.isSafeInteger(maxFiles) || maxFiles < 1 ||
      maxFiles > 1000) reject('invalid changed-path source');
  const paths = [];
  for (let page = 1; page <= Math.ceil(maxFiles / 100); page++) {
    const files = await fetchGitHub(
      'pulls/' + pullNumber + '/files?per_page=100&page=' + page);
    if (!Array.isArray(files)) reject('invalid changed-path response');
    for (const file of files) {
      if (typeof file?.filename !== 'string' || !file.filename ||
          file.filename.length > 500 || file.filename.startsWith('/') ||
          file.filename.split('/').includes('..')) {
        reject('invalid changed path');
      }
      paths.push(file.filename);
      if (paths.length > maxFiles) return { paths: [], families: null };
    }
    if (files.length < 100) return { paths, families: selectQualityFamilies(paths) };
  }
  return { paths: [], families: null };
}

// Convenience composition for a production reconcile observer. Every input is
// an authenticated reader; no model or write authority is involved.
export async function resolveCiDeclarations({
  fetchGitHub, branch, pullNumber, e2e, cases,
  merge_admission_contexts = [QUALIFICATION_CONTEXT],
}) {
  const requiredChecks = await readRequiredChecks({ fetchGitHub, branch });
  const changed = await readChangedPaths({ fetchGitHub, pullNumber });
  const families = changed.families ?? {
    rust: true, web: true, tooling: true, workflow: true, instruction: true,
    applicability: 'unknown',
  };
  return declarationsFromRequiredChecks({
    requiredChecks, families, e2e, cases, merge_admission_contexts,
  });
}

export { QUALIFICATION_CONTEXT };
