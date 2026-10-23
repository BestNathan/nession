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
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCursorSdk, runCursorSession } from '../providers/cursor.mjs';
import { normalizeClaudeUsage } from '../providers/claude-code.mjs';
import { parseNativeEvents, toolUseNames } from '../providers/claude-stream.mjs';
import { claudeCliToolPolicy } from '../harness/native.mjs';
import { promptTelemetry } from '../telemetry/prompt.mjs';
import { normalizeNativeTrace, writeExecutionTrace } from '../telemetry/execution-trace.mjs';
import { buildAgentWorkflowTelemetry, writeAgentWorkflowTelemetry } from '../../../agent-workflow-telemetry.mjs';
import { assertReviewerAdmission, resolveReviewerIdentity } from './pr-admission.mjs';
import { REVIEW_TOOLS, assertUnprivilegedReviewerEnvironment, runReviewSlice } from './review-slice.mjs';

const MAX_ADMISSION = 16384;
const HEX64 = /^[a-f0-9]{64}$/;
const CLAUDE_TOOL = Object.freeze({ read: 'Read', grep: 'Grep' });
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
  const task = JSON.parse(fs.readFileSync(file, 'utf8'));
  // The identity must be a registered reviewer; the Worker must accept any
  // registered provider's admission, not only the cursor default.
  const identity = resolveReviewerIdentity(task?.agent_id);
  return assertReviewerAdmission(task, { agent_id: identity.agent_id });
}

// Same OS-isolation contract as the Developer slice: no host SDK sandbox,
// no ambient credentials, only the disposable container and provider key.
// A Cursor SDK mount is required only for the cursor provider.
export function assertIsolatedReviewerProcess(env, { dockerenv = false, provider = null } = {}) {
  assertUnprivilegedReviewerEnvironment(env);
  if (env.NESSION_REVIEWER_ISOLATED !== 'docker-v1' || env.GITHUB_WORKSPACE !== '/workspace' ||
      env.RUNNER_TEMP !== '/tmp' || !dockerenv)
    fail('OS-isolated Docker worker is mandatory, not local SDK sandbox');
  if (provider === 'cursor' && env.CURSOR_SDK_ROOT !== '/sdk')
    fail('missing mounted Cursor SDK for the cursor provider');
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

// Claude Code (Qwen) adapter for the same Slice contract. Restricted mode
// confines file tools to the disposable workspace; only Read/Grep are exposed.
export function createClaudeReviewRunner({
  model, workspace, env = process.env, spawn = spawnSync, timeoutMs = 480000,
}) {
  return async (prompt, { tools } = {}) => {
    if (!Array.isArray(tools) || tools.length !== REVIEW_TOOLS.length ||
        tools.some((tool, index) => tool !== REVIEW_TOOLS[index]))
      fail('Provider must be offered exactly read/grep');
    const nativeTools = tools.map((tool) => CLAUDE_TOOL[tool]);
    if (nativeTools.some((tool) => !tool)) fail('unsupported reviewer tool');
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--max-turns', '24', '--model', model,
      '--strict-mcp-config', ...claudeCliToolPolicy(nativeTools, { restricted: true })];
    const proc = spawn('claude', args, {
      cwd: workspace, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      env: { ...env, DISABLE_AUTOUPDATER: '1', ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model },
    });
    if (proc.error || proc.status !== 0) {
      // Safe diagnostics only: no raw model text, prompt or tool output.
      const detail = [
        proc.error?.code ? 'spawn=' + proc.error.code : '',
        proc.signal ? 'signal=' + proc.signal : '',
        Number.isInteger(proc.status) ? 'status=' + proc.status : '',
      ].filter(Boolean).join(', ');
      fail('restricted Claude Code CLI failed (' + (detail || 'no diagnostics') + ')');
    }
    const { events, envelope } = parseNativeEvents(proc.stdout);
    if (envelope.is_error === true) fail('Provider returned error');
    return {
      result: { status: 'finished', result: envelope.result, session_id: envelope.session_id },
      meta: {
        status: 'finished', agent_id: envelope.session_id, tool_calls: toolUseNames(events),
        turns: Number.isSafeInteger(envelope.num_turns) ? envelope.num_turns : null,
        usage: normalizeClaudeUsage(envelope),
        model: { id: model }, native_events: events,
        started_at: null, finished_at: null,
      },
    };
  };
}

// Canonical sanitized telemetry for the Review Slice. Unobserved values stay
// null; no raw model text, tool arguments or prompts enter the summary.
export function writeReviewTelemetry({ outDir, admission, slice, identity, taskId, env = process.env }) {
  if (!HEX64.test(taskId ?? '')) fail('missing signed reviewer action ID');
  const meta = slice.meta ?? {};
  const outcome = String(slice.verdict?.outcome ?? '').replace(/_/g, '-');
  const summary = buildAgentWorkflowTelemetry({
    workflow_id: 'agent-review',
    github_workflow: env.GITHUB_WORKFLOW ?? 'Agent / Review',
    github_run_id: Number(env.GITHUB_RUN_ID),
    github_run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    repository: env.GITHUB_REPOSITORY ?? 'BestNathan/nession',
    event: env.GITHUB_EVENT_NAME ?? 'workflow_dispatch',
    job: 'reviewer',
    task: {
      id: 'issue-1997-review', type: 'review', issue: admission.issue,
      pr: admission.pr_number, target_ref: admission.target_sha, action_id: taskId,
      native_session_id: meta.agent_id, native_resumed: false,
    },
    agent: {
      provider: identity.provider, id: identity.agent_id, role: 'reviewer',
      model: meta.model ?? null, run_id: meta.run_id ?? null, status: meta.status,
      prompt: promptTelemetry(slice.prompt),
    },
    execution: {
      turns: meta.turns ?? null, tool_calls: meta.tool_calls ?? [], tools_observed: true,
    },
    tokens: meta.usage ?? {},
    cost: meta.cost ?? { raw_usd: null, charged_usd: null, estimated_usd: null },
    timing: {
      started_at: meta.started_at ?? new Date().toISOString(),
      finished_at: meta.finished_at ?? new Date().toISOString(),
      agent_duration_ms: null,
    },
    result: { status: 'review-' + outcome },
  });
  writeAgentWorkflowTelemetry(path.join(outDir, 'agent-telemetry.json'), summary);
  const trace = normalizeNativeTrace(
    identity.provider === 'cursor' ? 'cursor' : 'claude-code',
    meta.native_events ?? [], summary,
    {
      model: meta.usage ? 'observed' : 'unobserved',
      tools: 'partial', skills: 'unobserved', mcp: 'unobserved',
    },
  );
  writeExecutionTrace(path.join(outDir, 'agent-execution-trace.json'), trace);
}

async function main() {
  if (process.argv.length !== 4) fail('usage: verified-admission.json output-directory');
  assertIsolatedReviewerProcess(process.env, { dockerenv: fs.existsSync('/.dockerenv') });
  const admission = readReviewAdmission(process.argv[2]);
  const taskId = process.env.NESSION_REVIEW_ACTION_ID;
  if (!HEX64.test(taskId ?? '')) fail('missing signed reviewer action ID');
  const runId = Number(process.env.GITHUB_RUN_ID);
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const identity = resolveReviewerIdentity(admission.agent_id);
  const provider = identity.provider;
  assertIsolatedReviewerProcess(process.env,
    { dockerenv: fs.existsSync('/.dockerenv'), provider });
  const out = path.resolve(process.argv[3]);
  const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'nession-review-'));
  const workspace = path.join(temp, 'workspace');
  const storePath = path.join(temp, 'jsonl');
  try {
    fs.mkdirSync(storePath, { mode: 0o700 });
    // Materialize the admitted tree without .git metadata; restricted Claude
    // mode and the Cursor SDK both read ordinary files from the workspace.
    fs.mkdirSync(workspace, { mode: 0o700 });
    const archive = path.join(temp, 'target.tar');
    execFileSync('git', ['-C', process.env.GITHUB_WORKSPACE, 'archive', '--format=tar',
      '--output=' + archive, admission.target_sha], {
      timeout: 120000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    });
    execFileSync('tar', ['-xf', archive, '-C', workspace], {
      timeout: 120000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let runner;
    if (provider === 'cursor') {
      if (!process.env.CURSOR_API_KEY) fail('missing Cursor provider key');
      const sdkPkg = JSON.parse(fs.readFileSync(
        path.join(process.env.CURSOR_SDK_ROOT, 'node_modules/@cursor/sdk/package.json'), 'utf8'));
      if (sdkPkg.version !== process.env.CURSOR_SDK_VERSION)
        fail('Cursor SDK version differs from pinned Environment version');
      runner = createCursorReviewRunner({
        apiKey: process.env.CURSOR_API_KEY,
        model: {
          id: process.env.CURSOR_MODEL || 'composer-2.5',
          fast: (process.env.CURSOR_MODEL_FAST || 'true') !== 'false',
        },
        workspace, storePath,
      });
    } else if (provider === 'claude-code') {
      if (!process.env.ANTHROPIC_BASE_URL ||
          (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN))
        fail('missing Claude gateway credentials');
      const model = process.env.ACCEPTANCE_CLAUDE_MODEL || process.env.ANTHROPIC_MODEL;
      if (!/^qwen[a-z0-9._-]*$/i.test(model ?? '')) fail('Qwen model must be explicit');
      runner = createClaudeReviewRunner({ model, workspace, env: process.env });
    } else fail('unsupported reviewer Provider');
    const slice = await runReviewSlice({ admission, runner, taskId, runId, runAttempt, provider });
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
    writeReviewTelemetry({ outDir: out, admission, slice, identity, taskId, env: process.env });
    console.log('Read-only Reviewer Slice finished with a host-bound verdict; no review was published');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('::error::' + error.message);
    process.exitCode = 1;
  });
}
