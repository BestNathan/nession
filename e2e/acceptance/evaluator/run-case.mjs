#!/usr/bin/env node

// Single-Case CLI. The Case execution itself lives in the canonical runtime
// owner (e2e/runner/acceptance-case.mjs) so a job-scoped batch can reuse the
// exact same identity, verifier and record logic (#1866 Phase B). This entry
// point is unchanged for every existing caller.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { runCase } from '../../runner/acceptance-case.mjs';

function arg(name, required = false) {
  const index = process.argv.indexOf('--' + name);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (required && (!value || value.startsWith('--'))) {
    throw new Error('--' + name + ' is required');
  }
  return value;
}

function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(label + ' must be a positive integer');
  return parsed;
}

async function main() {
  const { execFileSync } = await import('node:child_process');
  const repoRoot = path.resolve(
    arg('repo-root') || execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
  );
  const issueNumber = positiveInt(arg('issue', true), 'issue');
  const criterion = String(arg('criterion', true)).trim().toUpperCase();
  const stage = String(arg('stage', true)).trim().toLowerCase();
  const targetSha = String(arg('target-sha', true)).trim();
  const runId = positiveInt(arg('run-id') || process.env.GITHUB_RUN_ID || '1', 'run-id');
  const runAttempt = positiveInt(arg('run-attempt') || process.env.GITHUB_RUN_ATTEMPT || '1', 'run-attempt');
  const issueJsonPath = path.resolve(arg('issue-json', true));
  const output = arg('output');

  const issue = JSON.parse(fs.readFileSync(issueJsonPath, 'utf8'));
  const record = await runCase({
    repoRoot,
    issue,
    issueNumber,
    criterion,
    stage,
    targetSha,
    runId,
    runAttempt,
    output,
  });

  process.stdout.write(JSON.stringify(record) + '\n');
  if (record.result === 'Pass') return;
  process.exitCode = record.result === 'Error' ? 2 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 2;
});
