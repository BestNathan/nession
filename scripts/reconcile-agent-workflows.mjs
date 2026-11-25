#!/usr/bin/env node
// Issue #4482/#4525 — trusted-main Agent Workflow V2 Reconcile entrypoint.
//
// Plan mode is read-only: it scans existing durable Issue states fairly,
// observes authenticated facts through the production fact observer and asks
// the canonical lifecycle owner for the next eligible decision. It performs no
// Store write, dispatch, publication, merge or Acceptance verdict.
//
// The exported artifact is a safe diagnostic projection only. The private
// next-state plan is never serialized.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readIssueWorkflowState } from './lib/agent/orchestration/state-store.mjs';
import { githubFetcher } from './lib/agent/github-read.mjs';
import { freezeCiObligation } from './lib/agent/workflow/ci-barrier.mjs';
import { collectExactCheckEvidence } from './lib/agent/workflow/ci-evidence.mjs';
import { resolveCiDeclarations } from './lib/agent/workflow/ci-policy.mjs';
import { buildReconcileTelemetry } from './lib/agent/workflow/telemetry.mjs';
import { normalizeReconcileWake, reconcileOnce } from './lib/agent/workflow/reconcile.mjs';
import {
  createFactObserver, createProductionObserverPorts,
} from './lib/agent/workflow/facts.mjs';
import { rotationSeed, scanLifecycleCandidates } from './lib/agent/workflow/scan.mjs';
import {
  assertSafeDiagnosticPayload, projectReconcileDiagnostic,
} from './lib/agent/workflow/diagnostic.mjs';

const REPO = 'BestNathan/nession';
const REF = 'agent-store';
const SHA40 = /^[a-f0-9]{40}$/;

function fail(message) {
  throw new Error('Agent Reconcile: ' + message);
}
function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 45000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    }).trim();
  } catch {
    // The remote URL may contain a credential; never print git stderr.
    fail('git ' + args[0] + ' failed');
  }
}
function cloneStore(remote) {
  if (typeof remote !== 'string' || !remote.trim() || /\s/.test(remote)) {
    fail('trusted Store remote required');
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reconcile-v2-'));
  const checkout = path.join(parent, 'store');
  try {
    execFileSync('git', ['clone', '--no-tags', '--single-branch', '--branch', REF,
      '--', remote, checkout], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 45000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    });
    if (git(checkout, ['symbolic-ref', '--short', 'HEAD']) !== REF) {
      fail('not an agent-store checkout');
    }
    return { parent, checkout };
  } catch (error) {
    fs.rmSync(parent, { recursive: true, force: true });
    if (error.message.startsWith('Agent Reconcile:')) throw error;
    fail('authenticated agent-store ref unavailable');
  }
}
function storePort(root) {
  return {
    async load(issue) {
      const record = readIssueWorkflowState(root, issue);
      return { state: record.state, version: record.version, digest: record.digest };
    },
    async cas() {
      fail('plan mode cannot write the Store');
    },
  };
}
async function collectCi({ fetchGitHub, state, now }) {
  if (!SHA40.test(state.thread?.head_sha ?? '')) return null;
  if (!['ci_checking', 'reviewing', 'evaluating', 'accepting',
    'waiting_merge', 'post_merge_acceptance'].includes(state.phase)) return null;
  if (state.pr == null || !Number.isSafeInteger(state.pr.number) ||
      !SHA40.test(state.pr.base_sha ?? '')) return null;
  const pr = await fetchGitHub('pulls/' + state.pr.number);
  if (pr?.head?.sha !== state.thread.head_sha || pr?.base?.sha !== state.pr.base_sha ||
      typeof pr?.base?.ref !== 'string' || !pr.base.ref ||
      pr.base.ref.length > 200 || pr.base.ref.startsWith('/') ||
      pr.base.ref.split('/').includes('..')) {
    // A stale/fork/moved PR binding is never turned into a smaller obligation.
    return null;
  }
  // Trusted policy owners freeze the expected set BEFORE any check-run is
  // read: server-side required contexts, Quality family scope, browser
  // applicability. A policy read failure propagates and is recorded as an
  // unavailable observation by the reconcile loop.
  const declarations = await resolveCiDeclarations({
    fetchGitHub, branch: pr.base.ref, pullNumber: state.pr.number,
    // Issue-selected browser applicability is fail-closed until its trusted
    // selector is wired into this plan-only observer.
    e2e: 'unknown', cases: 'unknown',
  });
  const obligation = freezeCiObligation({
    head_sha: state.thread.head_sha, base_sha: state.pr.base_sha, checks: declarations,
  });
  const ci = await collectExactCheckEvidence({
    fetchGitHub, repository: REPO, obligation,
    head_sha: state.thread.head_sha, base_sha: state.pr.base_sha,
    observed_at: now(),
  });
  return { verified: true, ...ci };
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (value == null || value.startsWith('--')) fail('missing value for ' + name);
  return value;
}

async function realMain(argv) {
  if (argv.includes('--apply')) {
    fail('--apply is the separately authorized SC-06 canary, not this entrypoint');
  }
  if (!argv.includes('--plan')) {
    fail('usage: --plan [--issue N] [--cursor N] [--max-issues N] [--wake-source SOURCE]');
  }
  const hintValue = argValue(argv, '--issue');
  const hint = hintValue == null ? null : Number(hintValue);
  if (hint != null && (!Number.isSafeInteger(hint) || hint < 1)) fail('invalid Issue hint');
  const cursorValue = argValue(argv, '--cursor');
  const cursor = cursorValue == null ? null : Number(cursorValue);
  if (cursor != null && (!Number.isSafeInteger(cursor) || cursor < 0)) {
    fail('invalid scan cursor');
  }
  const maxIssuesValue = argValue(argv, '--max-issues');
  const maxIssues = maxIssuesValue == null ? 20 : Number(maxIssuesValue);
  if (!Number.isSafeInteger(maxIssues) || maxIssues < 1 || maxIssues > 100) {
    fail('invalid max-issues');
  }
  const source = argValue(argv, '--wake-source') ?? 'manual';
  const reason = argValue(argv, '--reason') ?? 'operator_plan';
  const wake = normalizeReconcileWake({ source, reason, correlation_id: null });
  const storeRootArg = argValue(argv, '--store-root');
  const storeRoot = storeRootArg == null ? null : path.resolve(storeRootArg);
  let checkout = null;
  let root = storeRoot;
  if (root == null) {
    checkout = cloneStore(process.env.AGENT_STORE_CONTROLLER_REMOTE);
    root = checkout.checkout;
  }
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) fail('read-only GitHub token required');
  const now = () => Date.now();
  try {
    const store = storePort(root);
    const seed = cursor ?? rotationSeed(process.env.GITHUB_RUN_ID ?? 0);
    const scan = hint == null ? scanLifecycleCandidates({
      storeRoot: root,
      loadState: (issue) => store.load(issue),
      cursor: seed,
      maxIssues,
    }) : null;
    const issues = hint != null ? [hint] : scan.issues.map((entry) => entry.issue);
    if (hint != null) {
      const record = await store.load(hint);
      if (record.state == null) fail('Issue has no durable lifecycle state');
    }
    const fetchGitHub = githubFetcher(token, { repository: REPO });
    const factObserver = createFactObserver({
      ports: createProductionObserverPorts({ token, storeRoot: root }),
      now,
    });
    const observer = {
      async observe({ issue, state, wake: activeWake }) {
        const observation = await factObserver.observe({
          issue, state, wake: activeWake,
        });
        observation.ci = await collectCi({ fetchGitHub, state, now });
        return observation;
      },
      async legacyPr({ issue, state }) {
        return factObserver.legacyPr({ issue, state });
      },
    };
    const ports = { store, observer, effects: null };
    const results = [];
    const telemetry = [];
    for (const issue of issues) {
      const loaded = await store.load(issue);
      const summary = await reconcileOnce({
        issue, wake, ports, now: now(), apply: false,
      });
      results.push(projectReconcileDiagnostic({ summary, state: loaded.state }));
      const telemetryState = loaded.state?.schema_version === 2 ? loaded.state :
        summary.plan?.schema_version === 2 ? summary.plan : null;
      if (telemetryState != null) {
        telemetry.push(buildReconcileTelemetry({
          summary, state: telemetryState, now: now(),
        }));
      }
    }
    const output = {
      schema_version: 1,
      kind: 'agent_workflow_v2_reconcile_plan',
      mode: 'plan',
      wake: { source: wake.source, reason: wake.reason },
      cursor: {
        requested: cursor,
        next: scan == null ? null : scan.next_cursor,
      },
      processes: results.length,
      results,
      telemetry,
    };
    assertSafeDiagnosticPayload(output);
    console.log(JSON.stringify(output, null, 2));
  } finally {
    if (checkout != null) fs.rmSync(checkout.parent, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  realMain(process.argv.slice(2)).catch((error) => {
    console.error('::error::' + error.message);
    process.exitCode = 1;
  });
}
