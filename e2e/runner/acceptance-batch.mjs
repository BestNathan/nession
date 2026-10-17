// Job-scoped Acceptance Case batching (#1866 Phase B, SC-04/SC-05).
//
// `acceptance-cases.yml` used to invoke `./e2e/run acceptance` once per Case, so
// every Case provisioned and tore down its own full stack even when several ran
// sequentially at the same target SHA and profile. This module owns ONE runtime
// for a batch of eligible Cases.
//
// Isolation first. Sharing a runtime is a claim about mutable state, so it is
// opt-in per Case: a manifest that does not declare `isolation: shared` keeps
// its own isolated runtime exactly as before. Ineligible, mismatched-profile or
// unknown Cases transparently fall back to a fresh runtime rather than joining a
// batch — a dirty DB/tmux/session can never turn into a false Pass or
// cross-Case contamination.
//
// Every Case still produces its own record through e2e/runner/acceptance-case.mjs:
// identity, contract digest, Case tree SHA, verifier results and verdict are
// built per Case. A failed Case cannot suppress another Case's evidence.
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { runCase, selectedCase } from '../acceptance/evaluator/run-case.mjs';

const require = createRequire(import.meta.url);
const { allocateLoopbackPort, startFullStackRuntime } = require('./runtime/full-stack.js');

export const CASE_ISOLATIONS = Object.freeze(['isolated', 'shared']);

// Resolve the manifest facts a batching decision needs, without starting
// anything. Unknown/unsupported Cases fall back to isolation.
export function planAcceptanceBatches({
  repoRoot,
  cases,
  resolveManifest = (root, entry) => selectedCase(root, entry.issue, entry.criterion).manifest,
}) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('acceptance batch requires at least one Case');
  }
  const entries = cases.map((entry) => {
    let manifest = null;
    try {
      manifest = resolveManifest(repoRoot, entry);
    } catch {
      manifest = null; // unknown Case: never join a batch, let runCase report it
    }
    return {
      ...entry,
      profile: manifest?.runtime ?? null,
      isolation: manifest?.isolation ?? 'isolated',
    };
  });

  // Consecutive cases may share one runtime only when each opted in AND they
  // agree on the runtime profile. Anything else becomes its own isolated batch.
  const batches = [];
  for (const entry of entries) {
    const previous = batches.at(-1);
    if (entry.isolation === 'shared' && entry.profile &&
        previous?.shared && previous.profile === entry.profile) {
      previous.cases.push(entry);
      continue;
    }
    if (entry.isolation === 'shared' && entry.profile) {
      batches.push({ shared: true, profile: entry.profile, cases: [entry] });
      continue;
    }
    batches.push({ shared: false, profile: entry.profile, cases: [entry] });
  }
  // A one-Case "shared" batch saves nothing; keep it isolated so the fallback
  // path is the one exercised for single Cases.
  for (const batch of batches) {
    if (batch.shared && batch.cases.length === 1) batch.shared = false;
  }
  return batches;
}

/**
 * Execute a batch plan.
 *
 * `runtimeFactory` is injectable so the grouping/isolation contract can be
 * tested without a real stack; production callers pass nothing.
 */
export async function executeAcceptanceBatches({
  repoRoot,
  batches,
  stage,
  targetSha,
  runId,
  runAttempt,
  resultsDir,
  contractsDir,
  runtimeFactory = null,
  log = () => {},
}) {
  const records = [];
  const errors = [];
  let sharedRuntimeCount = 0;

  for (const [index, batch] of batches.entries()) {
    let runtime = null;
    try {
      if (batch.shared) {
        const home = path.join(
          os.tmpdir(), 'nession-acceptance-batch-' + runId + '-' + runAttempt + '-' + index,
        );
        const tmuxSocket = path.join(os.tmpdir(),
          'nession-acceptance-batch-tmux-' + runId + '-' + runAttempt + '-' + index, 'tmux.sock');
        const [serverPort, agentPort, stalledProbePort, webPort] = await Promise.all([
          allocateLoopbackPort(), allocateLoopbackPort(),
          allocateLoopbackPort(), allocateLoopbackPort(),
        ]);
        runtime = runtimeFactory
          ? await runtimeFactory({ profile: batch.profile, home, tmuxSocket })
          : await startFullStackRuntime({
            repoRoot, targetSha, profile: batch.profile, home, tmuxSocket,
            serverPort, agentPort, stalledProbePort, webPort, cleanupHome: true,
          });
        sharedRuntimeCount += 1;
        log('batch ' + index + ': one runtime for ' + batch.cases.length +
          ' Case(s) at profile ' + batch.profile);
      }
      for (const entry of batch.cases) {
        const issue = JSON.parse(
          (await import('node:fs')).readFileSync(
            path.join(contractsDir, entry.issue + '.json'), 'utf8',
          ),
        );
        let record;
        try {
          record = await runCase({
            repoRoot,
            issue,
            issueNumber: Number(entry.issue),
            criterion: entry.criterion,
            stage,
            targetSha,
            runId,
            runAttempt,
            output: path.join(resultsDir, entry.issue + '-' + entry.criterion + '.case.json'),
            runtime,
          });
        } catch (error) {
          // A Case that cannot even be prepared (unknown Case, contract mismatch,
          // wrong SHA) must not abort the rest of the batch — the previous
          // per-Case loop continued too. No partial record is fabricated: an
          // invented record would be rejected by ingestion and would imply
          // evidence that does not exist. It is reported as a batch error.
          errors.push({
            issue: Number(entry.issue),
            criterion: entry.criterion,
            message: error instanceof Error ? error.message : String(error),
          });
          log('case ' + entry.issue + '/' + entry.criterion + ': ERROR ' +
            (error instanceof Error ? error.message : String(error)));
          continue;
        }
        records.push(record);
        log('case ' + entry.issue + '/' + entry.criterion + ': ' + record.result);
      }
    } finally {
      if (runtime) {
        try {
          await runtime.stop();
        } catch (error) {
          log('batch ' + index + ' teardown failed: ' +
            (error instanceof Error ? error.message : String(error)));
        }
      }
    }
  }

  return { records, errors, sharedRuntimeCount };
}
