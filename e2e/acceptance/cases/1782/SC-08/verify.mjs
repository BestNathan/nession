// #1782 SC-08: public export is versioned, deterministic, pin/source traceable,
// schema-validated, bounded and read-only. The Pages publication path owns no
// telemetry writer or Acceptance projector and never commits generated data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateProjection } from '../../../../../pages/scripts/project.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const hex40 = /^[a-f0-9]{40}$/;
const metricsSha = 'b'.repeat(40);
const acceptanceSha = 'c'.repeat(40);

function run(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: repo,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60000,
    env: { ...process.env, ...options.env },
  });
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || 'git command failed');
  return result.stdout.trim();
}

// The release artifact declares when it was generated. Every other byte must
// derive only from the pinned inputs; otherwise a rebuild is not reproducible.
function stripGeneratedAt(value) {
  if (Array.isArray(value)) return value.map(stripGeneratedAt);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === 'generated_at') continue;
      out[key] = stripGeneratedAt(value[key]);
    }
    return out;
  }
  return value;
}

function build(outDir, sha) {
  const result = run(['pages/scripts/build.mjs'], {
    env: {
      PAGES_OFFLINE: '1',
      PAGES_OUT_DIR: outDir,
      SOURCE_MAIN_SHA: sha,
      METRICS_SHA: metricsSha,
      ACCEPTANCE_RESULTS_SHA: acceptanceSha,
      // Never allow a live GitHub API path from an offline determinism proof.
      GITHUB_TOKEN: '',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || 'Pages build failed');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertRejects(projection, pattern, label) {
  assert.throws(() => validateProjection(projection), pattern, label);
}

function verifyWorkflowBoundary() {
  const workflow = fs.readFileSync(path.join(repo, '.github/workflows/deploy-pages.yml'), 'utf8');
  assert.doesNotMatch(workflow, /contents:\s*write/, 'Pages publication must not receive contents write');
  assert.doesNotMatch(workflow, /issues:\s*write/, 'Pages publication must not receive Issue write');
  assert.doesNotMatch(workflow, /git\s+push\b/, 'Pages publication must not push generated data');
  assert.doesNotMatch(workflow, /git\s+commit\b/, 'Pages publication must not commit generated data');
  assert.doesNotMatch(workflow, /run-store-(?:cas-push|receipt)/, 'Pages publication must not publish to a Run Store');
  assert.doesNotMatch(workflow, /publication-receipt\.mjs\s+(?:write|push)/, 'Pages publication must not write receipts');
  assert.match(workflow, /contents:\s*read/, 'Pages build requires read-only canonical sources');
  assert.match(workflow, /SOURCE_MAIN_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/, 'public export must be pinned to the exact main SHA');
  assert.match(workflow, /actions\/deploy-pages@/, 'trusted Pages deployment action required');
}

function main() {
  const sha = process.env.NESSION_ACCEPTANCE_TARGET_SHA || '';
  assert.match(sha, hex40, 'exact target SHA required');
  assert.equal(git('rev-parse', 'HEAD'), sha, 'Case checkout SHA mismatch');

  const checkoutBefore = git('status', '--porcelain', '--untracked-files=all');
  const headBefore = git('rev-parse', 'HEAD');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-1782-sc08-'));
  try {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    build(first, sha);
    build(second, sha);

    const site = readJson(path.join(first, 'data/site.json'));
    const siteAgain = readJson(path.join(second, 'data/site.json'));
    const graph = readJson(path.join(first, 'data/workflows.json'));
    const graphAgain = readJson(path.join(second, 'data/workflows.json'));

    // Versioned + pin/source traceable.
    assert.equal(site.schema_version, 1);
    assert.equal(graph.schema_version, 1);
    assert.equal(site.source.repository, 'BestNathan/nession');
    assert.equal(site.source.main_sha, sha, 'source main SHA is not the pinned target');
    assert.equal(site.source.metrics_sha, metricsSha, 'metrics revision is not pinned in the export');
    assert.equal(site.source.acceptance_results_sha, acceptanceSha, 'acceptance revision is not pinned in the export');
    assert.deepEqual(graph.source, {
      repository: 'BestNathan/nession',
      main_sha: sha,
      generated_at: graph.source.generated_at,
    });

    // Deterministic: identical inputs produce identical bytes apart from the
    // declared generation timestamp.
    assert.deepEqual(stripGeneratedAt(site), stripGeneratedAt(siteAgain), 'site.json is not reproducible from pinned inputs');
    assert.deepEqual(stripGeneratedAt(graph), stripGeneratedAt(graphAgain), 'workflows.json is not reproducible from pinned inputs');

    // Schema validated and bounded.
    assert.doesNotThrow(() => validateProjection(site));
    const serialized = JSON.stringify(site);
    assert.ok(Buffer.byteLength(serialized) <= 128 * 1024, 'public projection exceeds the release size limit');
    assert.ok(site.work.issues.length <= 12 && site.work.pulls.length <= 12, 'public work lists are not bounded');
    assert.ok(site.agents.roster.length <= 40, 'public Agent roster is not bounded');

    // Fail-closed negative fixtures: the release gate, not just the producer
    // allowlist, rejects raw or untrusted content.
    assertRejects({ ...site, extra_root: true }, /disallowed public field root\.extra_root/, 'unknown root field accepted');
    const privateField = structuredClone(site);
    privateField.work.issues.push({
      number: 1, title: 'x', url: 'https://github.com/BestNathan/nession/issues/1',
      state: 'open', updated_at: site.generated_at, observed_agent_runs_7d: null,
      pr_references: { status: 'unavailable', prs: [] }, agent_runs: [], prompt: 'private',
    });
    assertRejects(privateField, /disallowed public field issue\.prompt/, 'private Agent field accepted');
    const unsafeUrl = structuredClone(site);
    unsafeUrl.work.issues.push({
      number: 1, title: 'x', url: 'https://evil.example/issue/1',
      state: 'open', updated_at: site.generated_at, observed_agent_runs_7d: null,
      pr_references: { status: 'unavailable', prs: [] }, agent_runs: [],
    });
    assertRejects(unsafeUrl, /untrusted public URL/, 'non-canonical URL accepted');
    const unbounded = structuredClone(site);
    unbounded.work.issues = Array.from({ length: 13 }, (_, index) => ({
      number: index + 1, title: 'x', url: 'https://github.com/BestNathan/nession/issues/' + (index + 1),
      state: 'open', updated_at: site.generated_at, observed_agent_runs_7d: null,
      pr_references: { status: 'unavailable', prs: [] }, agent_runs: [],
    }));
    assertRejects(unbounded, /unbounded public data/, 'unbounded Issue list accepted');

    // Complete read-only behavior: the build changed no tracked or untracked
    // repository state and moved no commit.
    assert.equal(git('status', '--porcelain', '--untracked-files=all'), checkoutBefore, 'Pages build mutated the checkout');
    assert.equal(git('rev-parse', 'HEAD'), headBefore, 'Pages build moved HEAD');
    verifyWorkflowBoundary();

    process.stdout.write(JSON.stringify({
      status: 'pass',
      summary: 'Two offline builds from the same pinned revision produced identical schema-valid bounded exports; the release gate rejects private, unsafe and unbounded content and the publication path is read-only.',
      evidence: [
        { type: 'pin', value: 'source_main_sha=' + sha + ' metrics_sha=' + metricsSha.slice(0, 12) + ' acceptance_results_sha=' + acceptanceSha.slice(0, 12) },
        { type: 'determinism', value: 'site.json=' + Buffer.byteLength(JSON.stringify(site)) + 'B and workflows.json=' + Buffer.byteLength(JSON.stringify(graph)) + 'B reproducible apart from generated_at' },
        { type: 'schema', value: 'validateProjection accepted release artifact; extra root field, private field, untrusted URL and 13-Issue list rejected' },
        { type: 'read-only', value: 'git status unchanged; HEAD=' + headBefore + '; deploy-pages.yml has no contents/issues write, git push/commit or Run Store writer' },
      ],
    }) + '\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + '\n');
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: message,
    evidence: [{ type: 'release-contract', value: 'public export contract proof failed at the exact target SHA' }],
  }) + '\n');
  process.exitCode = 1;
}
