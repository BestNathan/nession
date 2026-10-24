#!/usr/bin/env node

// Canonical Acceptance Case evaluation.
//
// This file owns both the single-Case CLI and the Case execution itself. The
// execution half is exported so the job-scoped batch (#1866 Phase B,
// e2e/runner/acceptance-batch.mjs) can reuse the exact same identity, verifier
// and record logic instead of duplicating it — and so a Case can run against a
// caller-owned runtime. Importing this module never runs the CLI.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import {
  aggregateVerifierResults,
  discoverCases,
  validateCaseAgainstAcceptanceContext,
} from '../contract/cases.mjs';
import { executeVerifier } from '../../runner/drivers/index.mjs';
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

export function selectedCase(repoRoot, issue, criterion) {
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


// A deployed Case record binds the executed target to the exact attested
// environment. The trusted ingester re-validates the same shape.
export function deploymentRecord(binding, targetSha) {
  if (binding == null) return null;
  if (typeof binding !== 'object' || Array.isArray(binding)) {
    throw new Error('deployment binding must be an object');
  }
  const environment = String(binding.environment_id ?? '');
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(environment)) {
    throw new Error('deployment binding environment is invalid');
  }
  if (binding.attested !== true) {
    throw new Error('deployment binding must be attested');
  }
  const exact = (value, length, label) => {
    const text = String(value ?? '');
    if (!new RegExp('^[0-9a-f]{' + length + '}$').test(text)) {
      throw new Error(label + ' must be a ' + length + '-character hex digest');
    }
    return text;
  };
  const digests = binding.image_digests;
  if (!digests || typeof digests !== 'object' || Array.isArray(digests)) {
    throw new Error('deployment binding image_digests must be an object');
  }
  const imageDigests = {};
  for (const role of ['agent', 'server', 'ui']) {
    const value = String(digests[role] ?? '');
    if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
      throw new Error(role + ' deployment image digest is not immutable');
    }
    imageDigests[role] = value;
  }
  return {
    environment_id: environment,
    deployed_source_sha: exact(targetSha, 40, 'deployed source SHA'),
    attestation_execution_id: exact(binding.attestation_execution_id, 64, 'attestation_execution_id'),
    gitops_revision: exact(binding.gitops_revision, 40, 'gitops_revision'),
    image_digests: imageDigests,
  };
}

// Resolve everything a Case needs before any runtime exists, so a mismatched
// contract fails fast and never provisions a stack.
export function prepareCase({ repoRoot, issue, issueNumber, criterion, stage, targetSha, runId, deploymentBinding = null }) {
  const actualSha = git(repoRoot, ['rev-parse', 'HEAD']);
  if (actualSha !== targetSha) {
    throw new Error('Case target SHA mismatch: checkout ' + actualSha + ', requested ' + targetSha);
  }
  if (Number(issue.number) !== issueNumber) {
    throw new Error('trusted Issue JSON is #' + issue.number + ', requested #' + issueNumber);
  }
  const acceptanceContext = buildAcceptanceContext(issue, stage, {
    targetRef: targetSha,
    runId,
    deployment: deploymentBinding ? deploymentBinding.environment_id : stage,
    deploymentBinding,
  });
  const selected = selectedCase(repoRoot, issueNumber, criterion);
  const criterionContract = validateCaseAgainstAcceptanceContext(
    selected.manifest,
    acceptanceContext,
  );
  return {
    selected,
    acceptanceContext,
    criterionContract,
    caseTree: caseTreeSha(repoRoot, targetSha, issueNumber, criterion),
  };
}

/**
 * Run one Acceptance Case.
 *
 * `runtime` is optional. When supplied, the CALLER owns its lifecycle and this
 * function only executes the verifiers against it; when omitted, the Case gets
 * its own isolated runtime exactly as before.
 */
export async function runCase({
  repoRoot,
  issue,
  issueNumber,
  criterion,
  stage,
  targetSha,
  runId,
  runAttempt,
  output = null,
  runtime: suppliedRuntime = null,
  home = null,
  deploymentBinding = null,
}) {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const prepared = prepareCase({
    repoRoot, issue, issueNumber, criterion, stage, targetSha, runId, deploymentBinding,
  });
  const { selected, acceptanceContext, criterionContract, caseTree } = prepared;
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
  const caseHome = home ?? path.join(os.tmpdir(), 'nession-acceptance-' + suffix);
  const tmuxSocket = path.join(os.tmpdir(), 'nession-acceptance-tmux-' + suffix, 'tmux.sock');

  let runtime = suppliedRuntime;
  const ownsRuntime = !suppliedRuntime;
  let infrastructureStatus = 'starting';
  let verifierResults = [];
  let result = 'Error';
  let infrastructureError = null;

  try {
    if (ownsRuntime) {
      const [serverPort, agentPort, stalledProbePort, webPort] = await Promise.all([
        allocateLoopbackPort(),
        allocateLoopbackPort(),
        allocateLoopbackPort(),
        allocateLoopbackPort(),
      ]);
      runtime = await startFullStackRuntime({
        repoRoot,
        targetSha,
        profile: selected.manifest.runtime,
        home: caseHome,
        tmuxSocket,
        serverPort,
        agentPort,
        stalledProbePort,
        webPort,
        cleanupHome: true,
      });
    }
    infrastructureStatus = 'ready';

    const runtimeFile = path.join(runtime.home, 'runtime.json');
    for (const verifier of selected.manifest.verifiers) {
      verifierResults.push(await executeVerifier(verifier, {
        repoRoot,
        caseDir: selected.dir,
        runtimeFile,
        baseURL: runtime.base_url,
        targetSha,
        contractSha256: acceptanceContext.contract_sha256,
        issueNumber,
        criterion,
      }));
    }
    result = aggregateVerifierResults(verifierResults, selected.manifest.result_policy);
  } catch (error) {
    infrastructureStatus = 'error';
    infrastructureError = error instanceof Error ? error.message : String(error);
    result = 'Error';
  } finally {
    if (ownsRuntime && runtime) {
      try {
        await runtime.stop();
      } catch (error) {
        infrastructureStatus = 'error';
        infrastructureError = 'teardown: ' + (error instanceof Error ? error.message : String(error));
        result = 'Error';
      }
    }
  }

  const deployment = deploymentRecord(deploymentBinding, targetSha);
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
    finished_at: nowIso(),
    duration_ms: Date.now() - startedMs,
    verifiers: verifierResults,
    ...(deployment ? { deployment } : {}),
  };

  writeResult(output, record);
  return record;
}

async function main() {
  const repoRoot = path.resolve(
    arg('repo-root') || git(process.cwd(), ['rev-parse', '--show-toplevel']),
  );
  const issueNumber = positiveInt(arg('issue', true), 'issue');
  const criterion = String(arg('criterion', true)).trim().toUpperCase();
  const stage = String(arg('stage', true)).trim().toLowerCase();
  const targetSha = String(arg('target-sha', true)).trim();
  const runId = positiveInt(arg('run-id') || process.env.GITHUB_RUN_ID || '1', 'run-id');
  const runAttempt = positiveInt(arg('run-attempt') || process.env.GITHUB_RUN_ATTEMPT || '1', 'run-attempt');
  const issueJsonPath = path.resolve(arg('issue-json', true));
  const output = arg('output');
  const deploymentBindingPath = arg('deployment-binding');
  const deploymentBinding = deploymentBindingPath
    ? JSON.parse(fs.readFileSync(deploymentBindingPath, 'utf8'))
    : null;

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
    deploymentBinding,
  });

  process.stdout.write(JSON.stringify(record) + '\n');
  if (record.result === 'Pass') return;
  process.exitCode = record.result === 'Error' ? 2 : 1;
}

// Importable: the job-scoped batch reuses runCase() without running the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 2;
  });
}
