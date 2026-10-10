// The canonical E2E dispatcher must fail closed and never claim zero-work Pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repo, 'e2e', 'run');
const call = (...args) => {
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd: repo, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, CI: '' },
  });
  if (run.error) throw run.error;
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};
const expectError = (...args) => {
  const result = call(...args);
  assert.equal(result.code, 2, 'expected deterministic Error for: ' + args.join(' ') +
    '; stdout=' + result.stdout + '; stderr=' + result.stderr);
  assert.match(result.stderr, /E2E Error:/);
};
const listed = call('--list');
assert.equal(listed.code, 0);
const catalog = JSON.parse(listed.stdout);
assert.ok(catalog.browserTests > 0, 'regression catalog must never silently report 0 suites');
const migration = JSON.parse(fs.readFileSync(path.join(repo, 'e2e', 'tests', 'browser', 'migration-parity.json'), 'utf8'));
assert.equal(migration.schema_version, 1);
assert.match(migration.source_sha, /^[a-f0-9]{40}$/);
const browserRoot = path.join(repo, 'e2e', 'tests', 'browser');
assert.equal(fs.existsSync(path.join(repo, 'e2e', 'specs')), false, 'legacy tests must be retired');
const foundSpecs = fs.readdirSync(browserRoot).filter(name => name.endsWith('.spec.ts')).sort();
assert.deepEqual(foundSpecs, migration.specs, 'browser spec inventory changed during migration');
assert.equal(foundSpecs.length, 21, 'baseline migration needs all 21 spec files');
assert.equal(catalog.browserTests, 21, 'catalog may not silently count duplicates or omit specs');
const pngRoot = path.join(browserRoot, '__snapshots__', 'fixture-visual.spec.ts');
const foundPngs = fs.readdirSync(pngRoot).filter(name => name.endsWith('.png')).sort();
const pinned = Object.keys(migration.baseline_png_blobs).map(file => path.basename(file)).sort();
assert.deepEqual(foundPngs, pinned, 'snapshot inventory mismatch');
assert.equal(foundPngs.length, 43, 'all 43 snapshots must migrate unchanged');
for (const [relative, expectedSha] of Object.entries(migration.baseline_png_blobs)) {
  const filename = path.resolve(browserRoot, relative);
  assert.ok(filename.startsWith(browserRoot + path.sep), 'snapshot path escaped browser tree');
  assert.equal(fs.lstatSync(filename).isSymbolicLink(), false, 'snapshots must be real files');
  const bytes = fs.readFileSync(filename);
  const actual = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  assert.equal(actual, expectedSha, 'visual baseline bytes changed: ' + relative);
}

assert.ok(catalog.cases.length > 0, 'Case catalog must discover source-aligned Cases');
assert.ok(catalog.scenarios.length > 0, 'scenario catalog must not silently disappear');

// CI must preserve a single command surface after the Case source-tree migration.
// The trusted Case selector/updater stay in the workflow, but actual execution
// must flow through ./e2e/run rather than a second legacy entrypoint.
const caseWorkflow = fs.readFileSync(
  path.join(repo, '.github', 'workflows', 'acceptance-cases.yml'), 'utf8');
assert.match(caseWorkflow, /args=\(acceptance --issue-json/);
assert.match(caseWorkflow, /node workspace\/e2e\/run "\$\{args\[@\]\}"/);
assert.match(caseWorkflow, /while read -r issue criterion profile; do/);
assert.match(caseWorkflow, /done < <\(jq -r/);
assert.doesNotMatch(caseWorkflow, /node workspace\/acceptance\/run-case\.mjs/);
assert.equal(fs.existsSync(path.join(repo, 'acceptance', 'run-case.mjs')), false,
  'legacy public Case runner must be retired');
assert.equal(fs.existsSync(path.join(repo, 'acceptance', 'runtime', 'full-stack.js')), false,
  'legacy Runtime alias must be retired');
assert.equal(fs.existsSync(path.join(repo,'acceptance','verifiers')),false,
  'legacy verifier driver path must be retired');
assert.ok(fs.existsSync(path.join(repo,'e2e','runner','drivers','index.mjs')));
assert.ok(fs.existsSync(path.join(repo,'e2e','runner','drivers','playwright.config.cjs')));
const driverGate=fs.readFileSync(path.join(repo,'.github','workflows','quality.yml'),'utf8');
assert.match(driverGate, /\.\/gates\/run --suite quality-tooling/);
const toolingSuite = fs.readFileSync(path.join(repo, 'gates', 'suites', 'quality-tooling.gates'), 'utf8');
assert.match(toolingSuite, /^e2e-browser-report-selftest$/m);
const browserReportGate = fs.readFileSync(path.join(repo, 'gates', 'checks', 'e2e-browser-report-selftest.sh'), 'utf8');
assert.match(browserReportGate, /GATE_COMMAND='node e2e\/runner\/drivers\/browser-report\.mjs self-test'/);
assert.equal(fs.existsSync(path.join(repo, 'e2e', 'acceptance', 'evaluator', 'run-case.mjs')), true,
  'canonical internal Case evaluator must exist');
const gateRecipes = fs.readFileSync(path.join(repo, 'justfile'), 'utf8');
assert.match(gateRecipes, /check-acceptance-runtime:[\s\S]*?\.\/e2e\/run --validate/);
assert.doesNotMatch(gateRecipes, /acceptance\/runtime\/full-stack\.js/);
const acceptanceSkill = fs.readFileSync(path.join(repo, '.claude', 'skills',
  'nession-acceptance', 'SKILL.md'), 'utf8');
assert.match(acceptanceSkill, /\.\/e2e\/run acceptance/);
const acceptanceArchitecture = fs.readFileSync(path.join(repo, 'docs', 'architecture',
  'acceptance-cases.md'), 'utf8');
assert.match(acceptanceArchitecture, /e2e\/runner\/runtime\/full-stack\.js/);
assert.match(caseWorkflow, /--profile "\$\{profile\}"/);
assert.match(caseWorkflow, /--sha "\$\{TARGET_SHA\}"/);
const regressionWorkflow = fs.readFileSync(
  path.join(repo, '.github', 'workflows', 'e2e.yml'), 'utf8');
assert.match(regressionWorkflow, /\.\/run test --all/);
const caseSmokeWorkflow = fs.readFileSync(
  path.join(repo, '.github', 'workflows', 'acceptance-case-smoke.yml'), 'utf8');
assert.match(caseSmokeWorkflow, /\.\/e2e\/run acceptance/);
const scenarioSmokeWorkflow = fs.readFileSync(
  path.join(repo, '.github', 'workflows', 'e2e-scenario-smoke.yml'), 'utf8');
assert.match(scenarioSmokeWorkflow, /\.\/e2e\/run scenario/);


const checked = call('--validate');
assert.equal(checked.code, 0);
assert.ok(JSON.parse(checked.stdout).case_count > 0);

expectError('test');
expectError('test', '--all'); // CI-only: prevents unsafe local stack launch
expectError('test', '--suite', '../escape');
expectError('acceptance', '--issue', '0', '--sc', 'SC-01',
  '--sha', 'a'.repeat(40), '--stage', 'staging');
expectError('acceptance', '--issue', '1474', '--sc', 'SC-9999',
  '--sha', 'b'.repeat(40), '--stage', 'staging');
expectError('scenario', 'not-declared');
expectError('scenario', 'terminal-attach-resume');
expectError('compare', 'missing-file.json');
expectError('unknown');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-run-cli-selftest-'));
try {
  const left = path.join(temp, 'left.json');
  const right = path.join(temp, 'right.json');
  const fixture = (target, restored) => ({
    schema_version: 1, kind: 'e2e_scenario_observation', scenario: 'terminal-attach-resume',
    target_sha: target.repeat(40), config_sha256: 'c'.repeat(64),
    status: 'Completed', evaluation: null, observation_count: 3,
    observations: [
      { at: '2026-10-09T00:00:00.000Z', stage: 'before-reload',
        browser: { marker_count: 1, mounted: true }, backend: { marker_count: 240 } },
      { at: '2026-10-09T00:00:01.000Z', stage: 'after-reload',
        browser: { marker_count: 20, mounted: true }, backend: { marker_count: 240 } },
      { at: '2026-10-09T00:00:02.000Z', stage: 'after-reload',
        browser: { marker_count: restored, mounted: true }, backend: { marker_count: 240 } },
    ],
  });
  fs.writeFileSync(left, JSON.stringify(fixture('a', 100)));
  fs.writeFileSync(right, JSON.stringify(fixture('b', 240)));
  const compared = call('compare', left, right);
  assert.equal(compared.code, 0);
  const delta = JSON.parse(compared.stdout);
  assert.equal(delta.evaluation, null);
  assert.equal(delta.differences.some((item) => item.field === 'target_sha'), true);
  assert.equal(delta.scenario, 'terminal-attach-resume');
  assert.equal(delta.config_comparable, true);
  assert.equal(delta.left.timeline.length, 3);
  assert.equal(delta.observed_delta.final_browser_marker_count, 140);
  assert.match(delta.limitations, /not synchronized/);
  assert.equal(delta.source_comparison.same_target_sha, false);
  assert.equal(delta.source_comparison.left.independently_authenticated, false);
  assert.equal(delta.source_comparison.environment_identity, 'not-recorded');
  assert.match(delta.limitations, /not independently authenticated/);
  const sourceRecord = (target, runId) => ({
    ...fixture(target, 240), run_id: runId, run_attempt: 1, run_index: 1,
    source: { repository: 'BestNathan/nession', workflow_id: 378682095,
      run_id: runId, run_attempt: 1, event: 'pull_request',
      target_sha: target.repeat(40), scenario_tree_sha: 'a'.repeat(40),
      original_sha256: 'd'.repeat(64) },
  });
  fs.writeFileSync(left, JSON.stringify(sourceRecord('a', 101)));
  fs.writeFileSync(right, JSON.stringify(sourceRecord('b', 102)));
  const cross = call('compare', left, right);
  assert.equal(cross.code, 0);
  const comparison = JSON.parse(cross.stdout);
  assert.equal(comparison.source_comparison.left.source_fields,
    'internally-consistent-but-unverified');
  assert.equal(comparison.source_comparison.left.run_id, 101);
  assert.equal(comparison.source_comparison.right.run_id, 102);
  assert.equal(comparison.source_comparison.same_source_run, false);
  assert.equal(comparison.source_comparison.same_target_sha, false);
  assert.equal(comparison.source_comparison.left.independently_authenticated, false);
  const spoof = sourceRecord('b', 102);
  spoof.source.target_sha = 'a'.repeat(40);
  fs.writeFileSync(right, JSON.stringify(spoof));
  expectError('compare', left, right);
  const crossRun = sourceRecord('b', 102);
  crossRun.source.run_id = 999;
  fs.writeFileSync(right, JSON.stringify(crossRun));
  expectError('compare', left, right);
  // Source identity fields may be consistent yet still not authenticated.
  // This compares observations only; trusted ingestion must attest workflow_run.

  const corrupt = fixture('a', 240);
  corrupt.observations[1].browser.marker_count = -1;
  fs.writeFileSync(right, JSON.stringify(corrupt));
  expectError('compare', left, right);
  corrupt.observations[1].browser.marker_count = 20;
  corrupt.observation_count = 4;
  fs.writeFileSync(right, JSON.stringify(corrupt));
  expectError('compare', left, right);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('canonical E2E CLI self-test: catalog, validation, error/empty and compare contracts passed');
