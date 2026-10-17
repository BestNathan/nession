// Canonical single-Acceptance-Case execution (#1866 Phase B).
//
// The lifecycle used to live inside the `run-case.mjs` CLI, so every Case paid
// its own full-stack provision. This module owns the work itself and lets a
// caller supply an already-running job-scoped runtime; the CLI stays the same
// single-Case entry point and passes none.
//
// Whatever the runtime owner is, the Case identity, contract digest, Case tree
// SHA, verifier results and record are built here exactly once — a Case can
// never inherit another Case's verdict.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import {
  aggregateVerifierResults,
  discoverCases,
  validateCaseAgainstAcceptanceContext,
} from '../acceptance/contract/cases.mjs';
import { executeVerifier } from './drivers/index.mjs';
import { buildAcceptanceContext } from '../../scripts/acceptance-executor.mjs';

const require = createRequire(import.meta.url);
const {
  allocateLoopbackPort,
  startFullStackRuntime,
} = require('./runtime/full-stack.js');

function nowIso() {
  return new Date().toISOString();
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

function writeResult(file, result) {
  if (!file) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
}

// Resolve everything a Case needs before any runtime exists, so a mismatched
// contract fails fast and never provisions a stack.
export function prepareCase({ repoRoot, issue, issueNumber, criterion, stage, targetSha, runId }) {
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
    deployment: stage,
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
}) {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const prepared = prepareCase({
    repoRoot, issue, issueNumber, criterion, stage, targetSha, runId,
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
  };

  writeResult(output, record);
  return record;
}
