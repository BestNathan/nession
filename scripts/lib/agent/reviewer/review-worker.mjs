#!/usr/bin/env node
// #2137/#1664 SC-04: production adapter for the bounded read-only Reviewer
// Slice. The trusted workflow stages the admitted PR commit and the verified
// admission file; this process receives ONLY the Cursor provider key inside an
// OS-isolated container, never a GitHub/Store/Publisher credential.
//
// The workflow must make admission.target_sha reachable in GITHUB_WORKSPACE
// (trusted fetch) before starting this process. This module performs no
// network, GitHub, Issue, Store, review or merge action.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCursorSdk, runCursorSession } from '../providers/cursor.mjs';
import { assertAuthenticatedReviewerAdmission } from './pr-admission.mjs';
import { REVIEW_TOOLS, assertUnprivilegedReviewerEnvironment, runReviewSlice } from './review-slice.mjs';

const MAX_ADMISSION = 16384;
const HEX64 = /^[a-f0-9]{64}$/;
function fail(message) { throw new Error('Reviewer Worker: ' + message); }
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// Read only a bounded regular file. The admission was produced by the trusted
// workflow step; a symlink or oversized document is never followed.
export function readReviewAdmission(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ADMISSION)
    fail('unsafe verified admission');
  return assertAuthenticatedReviewerAdmission(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Same OS-isolation contract as the Developer slice: no host SDK sandbox,
// no ambient credentials, only the disposable container and provider key.
export function assertIsolatedReviewerProcess(env, { dockerenv = false } = {}) {
  assertUnprivilegedReviewerEnvironment(env);
  if (env.NESSION_REVIEWER_ISOLATED !== 'docker-v1' || env.GITHUB_WORKSPACE !== '/workspace' ||
      env.CURSOR_SDK_ROOT !== '/sdk' || env.RUNNER_TEMP !== '/tmp' || !dockerenv)
    fail('OS-isolated Docker worker is mandatory, not local SDK sandbox');
}

// Adapts the real Cursor SDK to the Slice's injected runner contract. The
// runner is re-declared on every call; it can never widen the tool policy.
export function createCursorReviewRunner({
  sdkLoader = loadCursorSdk, apiKey, name = 'nession-issue-1997-reviewer',
  model, workspace, storePath,
}) {
  return async (prompt, { tools } = {}) => {
    if (!Array.isArray(tools) || tools.length !== REVIEW_TOOLS.length ||
        tools.some((tool, index) => tool !== REVIEW_TOOLS[index]))
      fail('Provider must be offered exactly read/grep');
    return runCursorSession({
      sdkLoader, apiKey, name, requestedModel: model, workspace, storePath,
      tools: [...tools], prompt, sandbox: false,
    });
  };
}

async function main() {
  if (process.argv.length !== 4) fail('usage: verified-admission.json output-directory');
  assertIsolatedReviewerProcess(process.env, { dockerenv: fs.existsSync('/.dockerenv') });
  const admission = readReviewAdmission(process.argv[2]);
  const taskId = process.env.NESSION_REVIEW_ACTION_ID;
  if (!HEX64.test(taskId ?? '')) fail('missing signed reviewer action ID');
  const runId = Number(process.env.GITHUB_RUN_ID);
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (!process.env.CURSOR_API_KEY) fail('missing Cursor provider key');
  const sdkPkg = JSON.parse(fs.readFileSync(
    path.join(process.env.CURSOR_SDK_ROOT, 'node_modules/@cursor/sdk/package.json'), 'utf8'));
  if (sdkPkg.version !== process.env.CURSOR_SDK_VERSION)
    fail('Cursor SDK version differs from pinned Environment version');
  const model = {
    id: process.env.CURSOR_MODEL || 'composer-2.5',
    fast: (process.env.CURSOR_MODEL_FAST || 'true') !== 'false',
  };
  const out = path.resolve(process.argv[3]);
  const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'nession-review-'));
  const workspace = path.join(temp, 'workspace');
  const storePath = path.join(temp, 'jsonl');
  let added = false;
  try {
    fs.mkdirSync(storePath, { mode: 0o700 });
    git(process.env.GITHUB_WORKSPACE, 'worktree', 'add', '--detach', workspace, admission.target_sha);
    added = true;
    if (git(workspace, 'rev-parse', 'HEAD') !== admission.target_sha)
      fail('workspace is not the exact admitted PR SHA');
    const runner = createCursorReviewRunner({
      apiKey: process.env.CURSOR_API_KEY, model, workspace, storePath,
    });
    const slice = await runReviewSlice({ admission, runner, taskId, runId, runAttempt });
    fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    const save = (name, value) => fs.writeFileSync(path.join(out, name),
      JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    save('agent-result.json', slice.artifact);
    save('review-verdict.json', {
      schema_version: 1, kind: 'reviewer_verdict',
      issue: admission.issue, action_id: taskId, target_sha: admission.target_sha,
      outcome: slice.verdict.outcome, summary: slice.verdict.summary,
      findings: slice.verdict.findings,
      prompt_template_sha256: slice.prompt.template_sha256,
      native_agent_id: slice.meta.agent_id, tool_calls: slice.meta.tool_calls,
    });
    console.log('Read-only Reviewer Slice finished with a host-bound verdict; no review was published');
  } finally {
    if (added) try { git(process.env.GITHUB_WORKSPACE, 'worktree', 'remove', '--force', workspace); } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('::error::' + error.message);
    process.exitCode = 1;
  });
}
