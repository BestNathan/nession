#!/usr/bin/env node
// Canonical Rust test-route selection and contract (#4064).
//
// Invariant: the required PR Rust Quality route executes the unit tests of
// every test-bearing lib/bin target and every integration test target of the
// workspace. Coverage thresholds are coverage policy, never an execution
// selector.
//
// One owner chooses the route: this module turns the workspace metadata
// (`cargo metadata`) into cargo arguments, an inventory of the selected
// targets and the explicit exclusions. `scripts/filtered-test.sh --route`
// executes exactly that selection. `./gates/run rust-test-route-contract`
// proves the suite still contains the two test Gates and that the selection
// still covers every test-capable target; a narrow reintroduction (for example
// `--test integration` alone) and a removed Gate both fail the contract.
//
// Subcommands (used by scripts/filtered-test.sh and the Gate):
//   --cargo-args <unit|integration> [--manifest-path <path>]
//   --inventory <unit|integration> [--manifest-path <path>]
//   --validate
//   --selftest
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE_PATH = path.join(ROOT, 'gates/suites/quality-rust.gates');
const UNIT_GATE_PATH = path.join(ROOT, 'gates/checks/rust-test-unit.sh');
const INTEGRATION_GATE_PATH = path.join(ROOT, 'gates/checks/rust-test-integration.sh');
const FILTERED_TEST_PATH = path.join(ROOT, 'scripts/filtered-test.sh');
const COVERAGE_PATH = path.join(ROOT, 'scripts/check-coverage.sh');

export const INVENTORY_SCHEMA = 'nession.rust-test-route.v1';
export const REQUIRED_SUITE_GATES = [
  'rust-test-unit',
  'rust-test-integration',
  'rust-test-route-contract'
];

// An exclusion is a package-level, explicitly justified exception. Empty by
// construction: no workspace crate is currently exempt from the route.
export const PACKAGE_EXCLUSIONS = new Map([
  // 'crate-name' => 'why the crate cannot run in this route'
]);

// Runtime-gated targets are still selected and executed. The annotation makes
// the platform condition visible in the inventory instead of looking like an
// omission on a host where the target contains zero cases.
export const RUNTIME_GATED = new Map([
  [
    'nession-sandbox:linux_runtime',
    'target_os = "linux": macOS hosts execute zero cases; Linux CI executes them'
  ]
]);

class ContractError extends Error {}

function fail(message) {
  throw new ContractError(message);
}

function parseFlags(argv) {
  const options = {mode: null, subcommand: null, manifestPath: null, validate: false, selftest: false};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cargo-args' || arg === '--inventory') {
      options.subcommand = arg === '--cargo-args' ? 'cargo-args' : 'inventory';
      options.mode = argv[index + 1];
      index += 1;
    } else if (arg === '--manifest-path') {
      options.manifestPath = argv[index + 1];
      index += 1;
    } else if (arg === '--validate') {
      options.validate = true;
    } else if (arg === '--selftest') {
      options.selftest = true;
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  if (options.subcommand) {
    if (options.mode !== 'unit' && options.mode !== 'integration') {
      fail('--cargo-args/--inventory require <unit|integration>');
    }
  } else if (!options.validate && !options.selftest) {
    fail('usage: rust-test-route.mjs <--cargo-args|--inventory> <unit|integration> | --validate | --selftest');
  }
  return options;
}

export function loadWorkspace(manifestPath = null) {
  const args = ['metadata', '--no-deps', '--format-version', '1'];
  if (manifestPath) args.push('--manifest-path', manifestPath);
  const result = spawnSync('cargo', args, {cwd: ROOT, encoding: 'utf8'});
  if (result.error) fail(`cannot run cargo metadata: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`cargo metadata failed (exit ${result.status}): ${(result.stderr || '').trim()}`);
  }
  let metadata;
  try {
    metadata = JSON.parse(result.stdout);
  } catch (error) {
    fail(`cargo metadata is not JSON: ${error.message}`);
  }
  const members = new Set(metadata.workspace_members);
  const packages = metadata.packages
    .filter(pkg => members.has(pkg.id))
    .map(pkg => ({
      name: pkg.name,
      targets: pkg.targets.map(target => ({
        name: target.name,
        kind: target.kind,
        test: target.test !== false,
        srcPath: target.src_path
      }))
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!packages.length) fail('cargo metadata reported no workspace members');
  return {packages};
}

function kindOf(target) {
  return target.kind.join(',');
}

function targetKey(target) {
  return `${target.package}\u0000${target.target}\u0000${target.kind}`;
}

export function allTestTargets(workspace, mode) {
  const wanted = mode === 'unit'
    ? target => target.kind.includes('lib') || target.kind.includes('proc-macro') ||
        target.kind.includes('bin')
    : target => target.kind.includes('test');
  const targets = [];
  for (const pkg of workspace.packages) {
    for (const target of pkg.targets) {
      if (!target.test || !wanted(target)) continue;
      targets.push({package: pkg.name, target: target.name, kind: kindOf(target)});
    }
  }
  return targets.sort((left, right) => targetKey(left).localeCompare(targetKey(right)));
}

function excludedPackages() {
  return new Set(PACKAGE_EXCLUSIONS.keys());
}

export function routeArgs(workspace, mode) {
  if (mode === 'unit') {
    const args = ['--lib', '--bins'];
    for (const pkg of PACKAGE_EXCLUSIONS.keys()) args.push('--exclude', pkg);
    return args;
  }
  const excluded = excludedPackages();
  const names = [...new Set(
    allTestTargets(workspace, mode)
      .filter(target => !excluded.has(target.package))
      .map(target => target.target)
  )].sort();
  if (!names.length) fail('the workspace has no integration test targets; refusing an empty route');
  const args = [];
  for (const name of names) args.push('--test', name);
  for (const pkg of PACKAGE_EXCLUSIONS.keys()) args.push('--exclude', pkg);
  return args;
}

// The targets cargo actually selects from the emitted arguments. This is the
// seam the validator compares against the full metadata set, so a hardcoded or
// narrowed argument list cannot hide behind a correct-looking inventory.
export function selectedTargets(workspace, mode, args) {
  const excluded = new Set();
  const libNames = new Set();
  const binNames = new Set();
  const testNames = new Set();
  let allLibs = false;
  let allBins = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--lib') allLibs = true;
    else if (arg === '--bins') allBins = true;
    else if (arg === '--exclude') excluded.add(args[++index]);
    else if (arg === '--test') testNames.add(args[++index]);
    else fail(`unsupported route argument ${arg}`);
  }
  return allTestTargets(workspace, mode).filter(target => {
    if (excluded.has(target.package)) return false;
    if (mode === 'integration') return testNames.has(target.target);
    if (target.kind.includes('lib') || target.kind.includes('proc-macro')) {
      return allLibs || libNames.has(target.target);
    }
    if (target.kind.includes('bin')) return allBins || binNames.has(target.target);
    return false;
  });
}

export function coverageTestSkips(scriptText) {
  const skips = [];
  const pattern = /--skip\s+([^\s"']+)/g;
  let match;
  while ((match = pattern.exec(scriptText)) !== null) skips.push(match[1]);
  if (scriptText.includes('SKIP_FLAGS') && !skips.length) {
    fail('scripts/check-coverage.sh declares SKIP_FLAGS without a parseable --skip contract');
  }
  return [...new Set(skips)].sort();
}

export function buildInventory(workspace, mode, args, skips) {
  const selected = selectedTargets(workspace, mode, args);
  return {
    schema: INVENTORY_SCHEMA,
    mode,
    cargo_args: args,
    packages: workspace.packages.map(pkg => pkg.name),
    target_count: selected.length,
    targets: selected,
    package_exclusions: [...PACKAGE_EXCLUSIONS].map(([pkg, reason]) => ({package: pkg, reason})),
    runtime_gated: [...RUNTIME_GATED]
      .filter(([key]) => {
        const [pkg, target] = key.split(':');
        return selected.some(entry => entry.package === pkg && entry.target === target);
      })
      .map(([key, condition]) => {
        const [pkg, target] = key.split(':');
        return {package: pkg, target, condition};
      }),
    coverage_test_skips: skips.map(test => ({owner: 'scripts/check-coverage.sh', test}))
  };
}

export function parseSuite(suiteText) {
  return suiteText
    .split('\n')
    .map(line => line.replace(/#.*/, '').trim())
    .filter(Boolean);
}

export function validateSuite(suiteIds, required = REQUIRED_SUITE_GATES) {
  const present = new Set(suiteIds);
  const missing = required.filter(id => !present.has(id));
  if (missing.length) {
    fail(`gates/suites/quality-rust.gates omits required Rust test route Gate(s): ${missing.join(', ')}`);
  }
}

export function validateInventory(expected, inventory, label) {
  if (inventory.schema !== INVENTORY_SCHEMA) {
    fail(`${label}: unexpected inventory schema ${inventory.schema}`);
  }
  const got = new Set(inventory.targets.map(targetKey));
  const want = new Set(expected.map(targetKey));
  const missing = [...want].filter(key => !got.has(key));
  const extra = [...got].filter(key => !want.has(key));
  if (missing.length) {
    fail(`${label}: the route omits ${missing.length} test-capable target(s): ${missing.map(k => k.split('\u0000').join(':')).join(', ')}`);
  }
  if (extra.length) {
    fail(`${label}: the route selects ${extra.length} target(s) that are not test-capable: ${extra.map(k => k.split('\u0000').join(':')).join(', ')}`);
  }
}

export function validateExclusions(workspace) {
  const knownPackages = new Set(workspace.packages.map(pkg => pkg.name));
  for (const [pkg, reason] of PACKAGE_EXCLUSIONS) {
    if (!knownPackages.has(pkg)) fail(`stale package exclusion ${pkg}: no such workspace member`);
    if (!reason || !String(reason).trim()) fail(`package exclusion ${pkg} has no justification`);
  }
  // A runtime-gated target belongs to exactly one mode; validate against the
  // route's whole selected surface so each annotation must name a real target.
  const selected = new Set([
    ...allTestTargets(workspace, 'unit'),
    ...allTestTargets(workspace, 'integration')
  ].map(targetKey));
  for (const key of RUNTIME_GATED.keys()) {
    const [pkg, target] = key.split(':');
    const match = [...selected].some(entry => entry.startsWith(`${pkg}\u0000${target}\u0000`));
    if (!match) fail(`stale runtime-gated annotation ${key}: the target is not selected by any route mode`);
  }
}

function validateGateScripts() {
  const unit = fs.readFileSync(UNIT_GATE_PATH, 'utf8');
  const integration = fs.readFileSync(INTEGRATION_GATE_PATH, 'utf8');
  const filtered = fs.readFileSync(FILTERED_TEST_PATH, 'utf8');
  if (!unit.includes('--route unit')) {
    fail('gates/checks/rust-test-unit.sh no longer executes the canonical `--route unit` selection');
  }
  if (!integration.includes('--route integration')) {
    fail('gates/checks/rust-test-integration.sh no longer executes the canonical `--route integration` selection');
  }
  if (!filtered.includes('--route')) {
    fail('scripts/filtered-test.sh no longer owns the `--route` selection entrypoint');
  }
}

function validateContract() {
  const workspace = loadWorkspace();
  const suite = parseSuite(fs.readFileSync(SUITE_PATH, 'utf8'));
  validateSuite(suite);
  validateGateScripts();
  const skips = coverageTestSkips(fs.readFileSync(COVERAGE_PATH, 'utf8'));
  validateExclusions(workspace);
  for (const mode of ['unit', 'integration']) {
    const args = routeArgs(workspace, mode);
    const inventory = buildInventory(workspace, mode, args, skips);
    validateInventory(allTestTargets(workspace, mode), inventory, `${mode} route`);
  }
  console.log(`✓ rust test route contract: ${workspace.packages.length} packages, ` +
    `${allTestTargets(workspace, 'unit').length} unit target(s), ` +
    `${allTestTargets(workspace, 'integration').length} integration target(s), ` +
    `${skips.length} declared coverage test skip(s)`);
}

function expectRejected(label, action) {
  try {
    action();
  } catch (error) {
    if (error instanceof ContractError) {
      console.log(`  ✓ rejects ${label}: ${error.message.split('\n')[0]}`);
      return;
    }
    throw error;
  }
  fail(`selftest: ${label} was accepted but must be rejected`);
}

function run(command, args, options) {
  return spawnSync(command, args, {encoding: 'utf8', ...options});
}

function writeFixture(root) {
  const crate = path.join(root, 'omitted-crate');
  fs.mkdirSync(path.join(crate, 'src'), {recursive: true});
  fs.mkdirSync(path.join(crate, 'tests'), {recursive: true});
  fs.writeFileSync(path.join(root, 'Cargo.toml'),
    '[workspace]\nmembers = ["omitted-crate"]\nresolver = "2"\n');
  fs.writeFileSync(path.join(crate, 'Cargo.toml'),
    '[package]\nname = "omitted-crate"\nversion = "0.1.0"\nedition = "2021"\n');
  fs.writeFileSync(path.join(crate, 'src/lib.rs'), 'pub fn healthy() {}\n');
  // A bin target makes the `--bins` half of the unit route observable, so a
  // route narrowed to `--lib` is rejected by the same contract.
  fs.writeFileSync(path.join(crate, 'src/main.rs'), 'fn main() {}\n');
  fs.writeFileSync(path.join(crate, 'tests/custom_target.rs'),
    '#[test]\nfn route_fixture() {\n' +
    '    if std::env::var_os("NSESSION_ROUTE_FIXTURE_FAIL").is_some() {\n' +
    '        panic!("controlled failing test in a crate outside the coverage thresholds");\n' +
    '    }\n' +
    '}\n');
}

function selftest() {
  const suite = parseSuite(fs.readFileSync(SUITE_PATH, 'utf8'));
  expectRejected('a suite without rust-test-unit',
    () => validateSuite(suite.filter(id => id !== 'rust-test-unit')));
  expectRejected('a suite without rust-test-integration',
    () => validateSuite(suite.filter(id => id !== 'rust-test-integration')));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-rust-route-selftest.'));
  try {
    writeFixture(tmp);
    const manifestPath = path.join(tmp, 'Cargo.toml');
    const fixture = loadWorkspace(manifestPath);

    const unitArgs = routeArgs(fixture, 'unit');
    validateInventory(allTestTargets(fixture, 'unit'),
      buildInventory(fixture, 'unit', unitArgs, []), 'fixture unit route');
    expectRejected('a unit route without --bins', () => {
      const narrowed = unitArgs.filter(arg => arg !== '--bins');
      validateInventory(allTestTargets(fixture, 'unit'),
        buildInventory(fixture, 'unit', narrowed, []), 'fixture unit route');
    });
    expectRejected('an integration route narrowed to `--test integration`', () => {
      validateInventory(allTestTargets(fixture, 'integration'),
        buildInventory(fixture, 'integration', ['--test', 'integration'], []), 'fixture integration route');
    });
    expectRejected('an exclusion without a justification', () => {
      PACKAGE_EXCLUSIONS.set('omitted-crate', '');
      try {
        validateExclusions(fixture);
      } finally {
        PACKAGE_EXCLUSIONS.delete('omitted-crate');
      }
    });

    const inventory = run(process.execPath,
      [fileURLToPath(import.meta.url), '--inventory', 'integration', '--manifest-path', manifestPath],
      {cwd: ROOT});
    if (inventory.status !== 0) fail(`fixture inventory failed: ${inventory.stderr}`);
    const parsed = JSON.parse(inventory.stdout);
    const coversFixture = parsed.targets.some(target =>
      target.package === 'omitted-crate' && target.target === 'custom_target');
    if (!coversFixture) fail('the fixture inventory does not list the controlled integration target');

    const route = path.join(ROOT, 'scripts/filtered-test.sh');
    const failing = run('bash', [route, '--route', 'integration', '--manifest-path', manifestPath],
      {cwd: ROOT, env: {...process.env, NSESSION_ROUTE_FIXTURE_FAIL: '1'}});
    const failingOutput = `${failing.stdout}\n${failing.stderr}`;
    if (failing.status === 0) fail('a failing test in the fixture crate did not fail the canonical route');
    if (!failingOutput.includes('route_fixture') || !failingOutput.includes('FAILED')) {
      fail(`the failing fixture run did not report the failing target:\n${failingOutput}`);
    }
    console.log('  ✓ a failing test in a crate outside the coverage thresholds fails the canonical route');

    const passing = run('bash', [route, '--route', 'integration', '--manifest-path', manifestPath],
      {cwd: ROOT, env: Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => key !== 'NSESSION_ROUTE_FIXTURE_FAIL'))});
    const passingOutput = `${passing.stdout}\n${passing.stderr}`;
    if (passing.status !== 0) fail(`the positive fixture run failed:\n${passingOutput}`);
    if (!passingOutput.includes('route_fixture')) {
      fail(`the positive fixture run did not execute the target:\n${passingOutput}`);
    }
    console.log('  ✓ the same fixture crate passes when its test passes');
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
  console.log('✓ rust test route selftest passed');
}

function main() {
  try {
    const options = parseFlags(process.argv.slice(2));
    if (options.subcommand === 'cargo-args') {
      const workspace = loadWorkspace(options.manifestPath);
      for (const arg of routeArgs(workspace, options.mode)) console.log(arg);
    } else if (options.subcommand === 'inventory') {
      const workspace = loadWorkspace(options.manifestPath);
      const skips = options.manifestPath
        ? []
        : coverageTestSkips(fs.readFileSync(COVERAGE_PATH, 'utf8'));
      console.log(JSON.stringify(
        buildInventory(workspace, options.mode, routeArgs(workspace, options.mode), skips)));
    } else {
      if (options.validate) validateContract();
      if (options.selftest) selftest();
    }
  } catch (error) {
    if (error instanceof ContractError) {
      console.error(`[ERROR] rust-test-route: ${error.message}`);
      process.exit(1);
    }
    console.error(`[ERROR] rust-test-route: ${error.stack || error.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
