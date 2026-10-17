#!/usr/bin/env node
// Prove the coalesced Browser Design verdict is fail-closed (#1876 SC-04).
//
// A verifier that only ever sees good evidence is not evidence that it
// rejects bad evidence. This runs inside the real E2E job, against that job's
// own report and assertion receipt, and mutates them one at a time:
// missing spec, skipped test, flaky retry, zero assertions, foreign SHA,
// corrupt/missing report and a mismatched receipt row. Every mutation MUST be
// rejected; accepting any one of them fails the step.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { browserDesignTests } from './browser-design-catalog.mjs';
import { summarizeBrowserDesignReport } from './verify-browser-design-report.mjs';

const clone = (value) => structuredClone(value);

function matchesId(file, id) {
  const normalized = String(file).replaceAll('\\', '/');
  return normalized.endsWith('/' + id + '.spec.ts') || normalized === id + '.spec.ts';
}

function firstSpec(report, id) {
  for (const suite of report.suites ?? []) {
    const file = suite.file ?? '';
    if (matchesId(file, id)) {
      if (suite.specs?.length) return { suite, spec: suite.specs[0] };
      const nested = firstSpec(suite, id);
      if (nested) return nested;
    }
  }
  return null;
}

export function proveFailClosed({ report, assertions, root, sha, actualSha }) {
  const canonical = browserDesignTests(root).map(({ id }) => id);
  const genuine = summarizeBrowserDesignReport({ report, assertions, root, sha, actualSha });
  if (genuine.status !== 'Pass') throw new Error('genuine evidence did not pass');

  const probes = [
    ['missing-id', () => {
      const mutated = clone(report);
      const id = canonical.at(-1);
      mutated.suites = mutated.suites.filter((suite) => !matchesId(suite.file, id));
      return { report: mutated, assertions, sha, actualSha };
    }],
    ['skipped', () => {
      const mutated = clone(report);
      const found = firstSpec(mutated, canonical[0]);
      if (!found) throw new Error('fixture spec missing');
      found.spec.tests[0].status = 'skipped';
      found.spec.tests[0].results = [{ retry: 0, status: 'skipped' }];
      return { report: mutated, assertions, sha, actualSha };
    }],
    ['flaky', () => {
      const mutated = clone(report);
      const found = firstSpec(mutated, canonical[0]);
      if (!found) throw new Error('fixture spec missing');
      found.spec.tests[0].status = 'flaky';
      found.spec.tests[0].results = [{ retry: 1, status: 'passed' }];
      return { report: mutated, assertions, sha, actualSha };
    }],
    ['zero-assertions', () => {
      const mutated = clone(assertions);
      let changed = false;
      for (const row of mutated.tests) {
        if (row.id === canonical[0]) { row.assertions = 0; changed = true; }
      }
      if (!changed) throw new Error('fixture assertion rows missing');
      return { report, assertions: mutated, sha, actualSha };
    }],
    ['foreign-sha', () => ({
      report, assertions, sha: actualSha, actualSha: actualSha === '0'.repeat(40) ? '1'.repeat(40) : '0'.repeat(40),
    })],
    ['corrupt-report', () => ({ report: { suites: [], stats: {} }, assertions, sha, actualSha })],
    ['missing-assertions', () => ({ report, assertions: null, sha, actualSha })],
    ['mismatched-assertion', () => {
      const mutated = clone(assertions);
      const row = mutated.tests.find((item) => item.id === canonical[0]);
      if (!row) throw new Error('fixture assertion row missing');
      row.title = row.title + ' (forged)';
      return { report, assertions: mutated, sha, actualSha };
    }],
  ];

  const rejected = [];
  for (const [name, mutate] of probes) {
    const input = mutate();
    let accepted = false;
    try {
      summarizeBrowserDesignReport({ root, ...input });
      accepted = true;
    } catch {
      rejected.push(name);
    }
    if (accepted) throw new Error('mutated Browser Design evidence was accepted: ' + name);
  }
  return { status: 'Pass', sha, rejected, negatives: rejected.length };
}

function readJson(filename, label) {
  return JSON.parse(readFileSync(filename, 'utf8'));
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const index = args.indexOf('--' + name);
    return index < 0 ? '' : args[index + 1] ?? '';
  };
  const reportFile = arg('report');
  const assertionsFile = arg('assertions');
  const sha = arg('sha');
  const root = process.cwd();
  if (!reportFile || !assertionsFile || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('usage: --report FILE --assertions FILE --sha 40-hex');
  }
  const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const result = proveFailClosed({
    report: readJson(reportFile, 'report'),
    assertions: readJson(assertionsFile, 'assertions'),
    root,
    sha,
    actualSha,
  });
  process.stdout.write('BROWSER_DESIGN_FAIL_CLOSED_V1 ' + JSON.stringify(result) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write('prove-browser-design-fail-closed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
