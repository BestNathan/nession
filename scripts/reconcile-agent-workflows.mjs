#!/usr/bin/env node
// Issue #4482 — trusted-main Agent Workflow V2 Reconcile entrypoint.
//
// Plan mode is read-only: it loads the existing durable Issue states, observes
// bounded PR/CI facts with a read-only token and asks the canonical lifecycle
// owner for the next eligible decision. It performs no Store write, dispatch,
// publication, merge or Acceptance verdict.
//
// `--apply` is deliberately rejected here. Executing the committed effects is
// the separately authorized SC-06 canary through the existing controlled
// Agent/Store path; this entrypoint must not grow a second privileged writer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readIssueWorkflowState } from './lib/agent/orchestration/state-store.mjs';
import { githubFetcher } from './lib/agent/github-read.mjs';
import { classifyCiResults, freezeCiObligation } from './lib/agent/workflow/ci-barrier.mjs';
import { buildReconcileTelemetry } from './lib/agent/workflow/telemetry.mjs';
import { normalizeReconcileWake, reconcileOnce } from './lib/agent/workflow/reconcile.mjs';

const REPO = 'BestNathan/nession';
const REF = 'agent-store';
const SHA40 = /^[a-f0-9]{40}$/;
const MAX_ISSUES = 20;
const MAX_CHECKS = 100;

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
function activeIssues(root) {
  const directory = path.join(root, 'workflows', 'issues');
  if (!fs.existsSync(directory)) return [];
  const issues = [];
  for (const name of fs.readdirSync(directory)) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    const head = path.join(directory, name, 'head.json');
    if (!fs.existsSync(head)) continue;
    const stat = fs.lstatSync(head);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(head, 'utf8'));
    } catch {
      continue;
    }
    if (!Number.isSafeInteger(parsed?.version) || parsed.version < 1) continue;
    issues.push(Number(name));
    if (issues.length >= MAX_ISSUES) break;
  }
  return issues.sort((a, b) => a - b);
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
function checkConclusion(run) {
  if (run.status !== 'completed') return 'pending';
  switch (run.conclusion) {
    case 'success':
    case 'neutral':
    case 'failure':
    case 'timed_out':
    case 'cancelled':
    case 'skipped':
      return run.conclusion;
    default:
      return 'unknown';
  }
}
function checkIdentity(run) {
  const owner = run.app?.slug && /^[a-z0-9-]{1,40}$/.test(run.app.slug) ?
    run.app.slug : 'github';
  return { workflow: owner, name: String(run.name ?? '').slice(0, 200) };
}
function createObserver({ token, now }) {
  const fetchGitHub = githubFetcher(token, { repository: REPO });
  return {
    async legacyPr() {
      // A legacy state does not record its PR; plan mode never guesses one.
      return null;
    },
    async observe({ state, wake }) {
      const patch = {
        fencing_generation: state.thread.fencing_generation,
      };
      if (state.pr != null) {
        const pull = await fetchGitHub('pulls/' + state.pr.number);
        const merged = pull?.merged === true;
        patch.pr = {
          number: pull.number,
          head_sha: pull.head?.sha,
          base_sha: pull.base?.sha,
          state: merged ? 'merged' : pull.state,
          merged_sha: merged ? pull.merge_commit_sha : null,
        };
      }
      if (SHA40.test(state.thread.head_sha ?? '') &&
          ['ci_checking', 'reviewing', 'evaluating', 'accepting',
            'waiting_merge', 'post_merge_acceptance'].includes(state.phase)) {
        const runs = await fetchGitHub(
          'commits/' + state.thread.head_sha + '/check-runs?per_page=' + MAX_CHECKS);
        const checks = (runs?.check_runs ?? [])
          .filter((run) => run?.name && !/^Agent \/ Review\b/.test(run.name))
          .slice(0, MAX_CHECKS)
          .map((run) => {
            const identity = checkIdentity(run);
            return {
              name: identity.name,
              workflow: identity.workflow,
              conclusion: checkConclusion(run),
              applicability: 'applicable',
              // The trusted applicability policy is a canary input. Plan mode
              // is deliberately fail-closed and treats every observed check as
              // source-owned and required.
              category: 'source',
              required: true,
            };
          });
        if (checks.length) {
          const obligation = freezeCiObligation({
            head_sha: state.thread.head_sha, checks,
          });
          patch.ci = {
            verified: true,
            ...classifyCiResults({
              obligation,
              head_sha: state.thread.head_sha,
              results: checks.map((check) => ({
                name: check.name, workflow: check.workflow,
                conclusion: check.conclusion, evidence_ref: null,
              })),
              observed_at: now(),
            }),
          };
        }
      }
      return {
        issue: state.issue,
        state_version: state.version,
        observed_at: now(),
        wake: { source: wake.source, reason: wake.reason, correlation_id: wake.correlation_id },
        pr: null, developer: null, publisher: null, ci: null,
        reviewer: null, acceptance: null, merge: null,
        ...patch,
      };
    },
  };
}

async function realMain(argv) {
  if (argv.includes('--apply')) {
    fail('--apply is the separately authorized SC-06 canary, not this entrypoint');
  }
  if (!argv.includes('--plan')) fail('usage: --plan [--issue N] [--wake-source SOURCE]');
  const issueIndex = argv.indexOf('--issue');
  const hint = issueIndex >= 0 ? Number(argv[issueIndex + 1]) : null;
  if (hint != null && (!Number.isSafeInteger(hint) || hint < 1)) fail('invalid Issue hint');
  const sourceIndex = argv.indexOf('--wake-source');
  const source = sourceIndex >= 0 ? argv[sourceIndex + 1] : 'manual';
  const reasonIndex = argv.indexOf('--reason');
  const reason = reasonIndex >= 0 ? argv[reasonIndex + 1] : 'operator_plan';
  const wake = normalizeReconcileWake({ source, reason, correlation_id: null });
  const storeRootArg = argv.indexOf('--store-root');
  const storeRoot = storeRootArg >= 0 ? path.resolve(argv[storeRootArg + 1]) : null;
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
    const issues = hint ?? activeIssues(root);
    if (hint != null) {
      const record = readIssueWorkflowState(root, hint);
      if (record.state == null) fail('Issue has no durable lifecycle state');
    }
    const ports = {
      store: storePort(root),
      observer: createObserver({ token, now }),
      effects: null,
    };
    const results = [];
    const telemetry = [];
    for (const issue of Array.isArray(issues) ? issues : [issues]) {
      const loaded = await ports.store.load(issue);
      const summary = await reconcileOnce({
        issue, wake, ports, now: now(), apply: false,
      });
      results.push(summary);
      if (loaded.state?.schema_version === 2) {
        telemetry.push(buildReconcileTelemetry({
          summary, state: loaded.state, now: now(),
        }));
      }
    }
    console.log(JSON.stringify({
      schema_version: 1,
      kind: 'agent_workflow_v2_reconcile_plan',
      mode: 'plan',
      wake: { source: wake.source, reason: wake.reason },
      processes: results.length,
      results,
      telemetry,
    }, null, 2));
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
