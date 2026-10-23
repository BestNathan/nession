// #1782 SC-11: deterministic fixtures cover grouping, zero-vs-null, exact-SHA
// joins, mixed versions, missing Agent data, duplicate/out-of-order runs,
// pagination, source drift and safe partial failure. A renamed, removed or
// skipped fixture must fail this Case rather than pass by absence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

// Each declared behavior must be proved by a named deterministic fixture that
// actually ran. More than one fixture is required where the behavior has two
// independent failure surfaces.
const required = new Map([
  ['grouping', ['public 7d/30d workflow and provider aggregates derive only from source maps']],
  ['zero-vs-null', [
    'unknown source is unavailable, never zero or trusted integrity',
    'unknown source, unobserved zero, injected fields and source revision mismatch are distinct',
  ]],
  ['exact-sha-joins', [
    'only exact PR HEAD and canonical GitHub CI/E2E workflow runs are projected',
    'pinned selected E2E result must match original exact-SHA Run and trusted Ingest',
  ]],
  ['mixed-versions', [
    'strict v2 and legacy v1 extract only minimal unverified private candidates',
    'mixed main push and PR-head sources retain exact verified per-ID Ingest, never borrowing push proof',
  ]],
  ['missing-agent-data', [
    'per Agent observations do not inherit global token/cost totals',
    'unavailable source cannot masquerade as successful Lineage verification',
  ]],
  ['duplicate-out-of-order-runs', [
    'conflicting duplicates, bad target SHA and malformed version are never published',
    'missing, invalid and duplicated source cannot become trusted evidence',
  ]],
  ['pagination', [
    'Timeline unavailable, truncated, excessive and malformed references never imply no history',
    'full 100+100 workflow windows retain the 100th Test/Ingest receipt',
  ]],
  ['source-drift', [
    'pinned SHA drift, dirty input, unsafe symlink, forged counters and duplicate ID fail closed',
    'a candidate historical edge cannot become current proof after PR HEAD drift',
  ]],
  ['safe-partial-failure', [
    'bounded and partial PR review windows never imply exhaustive approval',
    'mixed legacy producer names and unrelated malformed historical runs do not suppress valid Issues',
  ]],
]);

function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || 'git command failed');
  return result.stdout.trim();
}

function main() {
  const sha = process.env.NESSION_ACCEPTANCE_TARGET_SHA || '';
  assert.match(sha, /^[a-f0-9]{40}$/, 'exact target SHA required');
  assert.equal(git('rev-parse', 'HEAD'), sha, 'Case checkout SHA mismatch');

  const testsDir = path.join(repo, 'pages/tests');
  const files = fs.readdirSync(testsDir).filter((name) => name.endsWith('.test.mjs')).sort();
  assert.ok(files.length >= 11, 'expected the full deterministic fixture suite');

  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files.map((name) => path.join('pages/tests', name))], {
    cwd: repo, encoding: 'utf8', timeout: 90000,
  });
  const tap = result.stdout;
  const counts = (label) => Number((tap.match(new RegExp('^# ' + label + ' (\\d+)$', 'm')) || [])[1]);
  assert.equal(result.status, 0, result.stderr || 'deterministic fixture suite failed');
  assert.equal(counts('fail'), 0, 'deterministic fixtures reported a failure');
  assert.equal(counts('skipped'), 0, 'deterministic fixtures must not skip');
  assert.ok(counts('tests') >= 50, 'fixture suite unexpectedly small');

  const ok = new Set([...tap.matchAll(/^ok \d+ - (.+)$/gm)].map((match) => match[1]));
  const missing = [];
  for (const [behavior, names] of required) {
    for (const name of names) {
      if (!ok.has(name)) missing.push(behavior + ': ' + name);
    }
  }
  assert.deepEqual(missing, [], 'required deterministic fixtures did not pass: ' + missing.join('; '));

  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'All deterministic public-projection fixtures ran at the exact target SHA and cover every cased behavior without skips.',
    evidence: [
      { type: 'fixtures', value: counts('tests') + ' tests passed, 0 failed, 0 skipped across ' + files.length + ' fixture files' },
      { type: 'coverage', value: [...required.keys()].join(', ') },
      { type: 'source', value: 'target_sha=' + sha.slice(0, 12) + ' required_named_fixtures=' + [...required.values()].flat().length },
    ],
  }) + '\n');
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + '\n');
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: message,
    evidence: [{ type: 'fixtures', value: 'deterministic fixture coverage proof failed at the exact target SHA' }],
  }) + '\n');
  process.exitCode = 1;
}
