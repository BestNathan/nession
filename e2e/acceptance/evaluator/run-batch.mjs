#!/usr/bin/env node

// Job-scoped Acceptance Case batch entry (#1866 Phase B).
//
// Same contract as the single-Case CLI: one record per <issue>/<SC>, the same
// identity fields and the same exit codes. The only difference is that eligible
// Cases may share one job-owned runtime instead of provisioning one each.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

import {
  executeAcceptanceBatches,
  planAcceptanceBatches,
} from '../../runner/acceptance-batch.mjs';

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
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(label + ' must be a positive integer');
  }
  return parsed;
}

async function main() {
  const repoRoot = path.resolve(
    arg('repo-root') || execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
  );
  const sha = String(arg('sha', true)).trim();
  const stage = String(arg('stage', true)).trim().toLowerCase();
  const selectionPath = path.resolve(arg('selection', true));
  const contractsDir = path.resolve(arg('contracts-dir', true));
  const resultsDir = path.resolve(arg('results-dir', true));
  const runId = positiveInt(arg('run-id') || process.env.GITHUB_RUN_ID || '1', 'run-id');
  const runAttempt = positiveInt(arg('run-attempt') || process.env.GITHUB_RUN_ATTEMPT || '1', 'run-attempt');

  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('--sha must be an exact 40-character SHA');
  if (!['pre-merge', 'staging', 'post-merge'].includes(stage)) throw new Error('unsupported --stage');
  const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (sha !== targetSha) throw new Error('requested SHA does not match checked-out source SHA');

  const selection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
  fs.mkdirSync(resultsDir, { recursive: true });
  const batches = planAcceptanceBatches({ repoRoot, cases: selection });
  const { records, sharedRuntimeCount } = await executeAcceptanceBatches({
    repoRoot,
    batches,
    stage,
    targetSha,
    runId,
    runAttempt,
    resultsDir,
    contractsDir,
    log: (line) => process.stderr.write('[acceptance-batch] ' + line + '\n'),
  });

  for (const record of records) process.stdout.write(JSON.stringify(record) + '\n');

  const failed = records.filter((record) => record.result !== 'Pass');
  // Bounded, non-sensitive measurement (#1866 SC-08): how many runtimes a batch
  // of N Cases actually needed.
  process.stderr.write('[acceptance-batch] summary cases=' + records.length +
    ' shared_runtimes=' + sharedRuntimeCount + ' failed=' + failed.length + '\n');

  if (failed.some((record) => record.result === 'Error')) process.exitCode = 2;
  else if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 2;
});
