#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import {
  aggregateVerifierResults,
  discoverCases,
  validateCaseAgainstAcceptanceContext,
} from '../../../acceptance/cases.mjs';
import { executeVerifier } from '../../../acceptance/verifiers/index.mjs';
import { buildAcceptanceContext } from '../../../scripts/acceptance-executor.mjs';

const require = createRequire(import.meta.url);
const {
  allocateLoopbackPort,
  startFullStackRuntime,
} = require('../../runner/runtime/full-stack.js');

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

function nowIso() {
  return new Date().toISOString();
}

function writeResult(file, result) {
  if (!file) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
}

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
}

function caseTreeSha(repoRoot, targetSha, issue, criterion) {
  return git(repoRoot, [
    'rev-parse',
    targetSha + ':e2e/acceptance/cases/' + issue + '/' + criterion,
  ]);
}

function executionId({ runId, runAttempt, targetSha, issue, criterion, contractSha256, caseTree }) {
  const canonical = JSON.stringify({
    schema_version: 1,
    run_id: runId,
    run_attempt: runAttempt,
    target_sha: targetSha,
    issue,
    criterion,
    contract_sha256: contractSha256,
    case_tree_sha: caseTree,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function selectedCase(repoRoot, issue, criterion) {
  const cases = discoverCases(path.join(repoRoot, 'e2e', 'acceptance', 'cases'));
  const found = cases.filter(
    (item) => item.manifest.issue === issue && item.manifest.criterion === criterion,
  );
  if (found.length !== 1) {
    throw new Error(
      'expected exactly one Case for ' + issue + '/' + criterion + ', found ' + found.length,
    );
  }
  return found[0];
}

async function main() {
  const repoRoot = path.resolve(arg('repo-root') || git(process.cwd(), ['rev-parse', '--show-toplevel']));
  const issueNumber = positiveInt(arg('issue', true), 'issue');
  const criterion = String(arg('criterion', true)).trim().toUpperCase();
  const stage = String(arg('stage', true)).trim().toLowerCase();
  const targetSha = String(arg('target-sha', true)).trim();
  const runId = positiveInt(arg('run-id') || process.env.GITHUB_RUN_ID || '1', 'run-id');
  const runAttempt = positiveInt(arg('run-attempt') || process.env.GITHUB_RUN_ATTEMPT || '1', 'run-attempt');
  const issueJsonPath = path.resolve(arg('issue-json', true));
  const output = arg('output');
  const startedAt = nowIso();
  const startedMs = Date.now();

  const actualSha = git(repoRoot, ['rev-parse', 'HEAD']);
  if (actualSha !== targetSha) {
    throw new Error('Case target SHA mismatch: checkout ' + actualSha + ', requested ' + targetSha);
  }

  const issue = JSON.parse(fs.readFileSync(issueJsonPath, 'utf8'));
  if (Number(issue.number) !== issueNumber) {
    throw new Error('trusted Issue JSON is #' + issue.number + ', requested #' + issueNumber);
  }

  const acceptanceContext = buildAcceptanceContext(issue, stage, {
    targetRef: targetSha,
    runId,
    deployment: stage,
  });
  const selected = selectedCase(repoRoot, issueNumber, criterion);
  const criterionContract = validateCaseAgainstAcceptanceContext(
    selected.manifest,
    acceptanceContext,
  );

  const caseTree = caseTreeSha(repoRoot, targetSha, issueNumber, criterion);
  const execution = executionId({
    runId,
    runAttempt,
    targetSha,
    issue: issueNumber,
    criterion,
    contractSha256: acceptanceContext.contract_sha256,
    caseTree,
  });

  const suffix = runId + '-' + runAttempt + '-' + issueNumber + '-' + criterion.toLowerCase();
  const home = path.join(os.tmpdir(), 'nession-acceptance-' + suffix);
  const tmuxSocket = path.join(os.tmpdir(), 'nession-acceptance-tmux-' + suffix, 'tmux.sock');
  const [serverPort, agentPort, stalledProbePort, webPort] = await Promise.all([
    allocateLoopbackPort(),
    allocateLoopbackPort(),
    allocateLoopbackPort(),
    allocateLoopbackPort(),
  ]);

  let runtime = null;
  let infrastructureStatus = 'starting';
  let verifierResults = [];
  let result = 'Error';
  let infrastructureError = null;

  try {
    runtime = await startFullStackRuntime({
      repoRoot,
      targetSha,
      profile: selected.manifest.runtime,
      home,
      tmuxSocket,
      serverPort,
      agentPort,
      stalledProbePort,
      webPort,
      cleanupHome: true,
    });
    infrastructureStatus = 'ready';

    const runtimeFile = path.join(home, 'runtime.json');
    for (const verifier of selected.manifest.verifiers) {
      verifierResults.push(await executeVerifier(verifier, {
        repoRoot,
        caseDir: selected.dir,
        runtimeFile,
        baseURL: runtime.base_url,
        targetSha,
        contractSha256: acceptanceContext.contract_sha256,
        criterion,
      }));
    }
    result = aggregateVerifierResults(verifierResults, selected.manifest.result_policy);
  } catch (error) {
    infrastructureStatus = 'error';
    infrastructureError = error instanceof Error ? error.message : String(error);
    result = 'Error';
  } finally {
    if (runtime) {
      try {
        await runtime.stop();
      } catch (error) {
        infrastructureStatus = 'error';
        infrastructureError = 'teardown: ' + (error instanceof Error ? error.message : String(error));
        result = 'Error';
      }
    }
  }

  const finishedAt = nowIso();
  const record = {
    schema_version: 1,
    kind: 'acceptance_case_result',
    execution_id: execution,
    run_id: runId,
    run_attempt: runAttempt,
    issue: issueNumber,
    criterion,
    criterion_text: criterionContract.text,
    stage,
    target_sha: targetSha,
    contract_sha256: acceptanceContext.contract_sha256,
    case_revision: targetSha,
    case_tree_sha: caseTree,
    runtime_profile: selected.manifest.runtime,
    result_policy: selected.manifest.result_policy,
    result,
    infrastructure_status: infrastructureStatus,
    infrastructure_error: infrastructureError,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Date.now() - startedMs,
    verifiers: verifierResults,
  };

  writeResult(output, record);
  process.stdout.write(JSON.stringify(record) + '\n');

  if (result === 'Pass') return;
  process.exitCode = result === 'Error' ? 2 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 2;
});
