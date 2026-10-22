// #2137/#1664 SC-04: bounded, read-only Reviewer Slice core.
// Runs only from a trusted #2176 admission plus a signed action/Run identity.
// This module never selects a target, writes GitHub/Issue/Store, merges or
// approves. It renders the canonical review Prompt, offers the Provider only
// read-only tools, validates the verdict and emits the canonical Agent result.
import { assertAuthenticatedReviewerAdmission } from './pr-admission.mjs';
import { renderReviewPrompt, reviewModelResult } from '../tasks/review.mjs';
import { parseAgentResult } from '../orchestration/result-artifact.mjs';

export const REVIEW_TOOLS = Object.freeze(['read', 'grep']);
// The Reviewer process must never hold a credential that can write GitHub,
// the Store, a Publisher PR or another Agent's checkpoint.
const PRIVILEGED = ['STORE_APP_TOKEN','STORE_WRITER_PRIVATE_KEY','ACTIONS_DISPATCH_TOKEN',
  'GITHUB_TOKEN','GH_TOKEN','AGENT_STORE_CONTROLLER_REMOTE','CURSOR_RESUME_PRIVATE_KEY_B64',
  'PUBLISHER_APP_PRIVATE_KEY','RUN_STORE_WRITER_PRIVATE_KEY'];
const WRITE_TOOLS = ['edit','write','shell','exec','terminal','apply_patch','delete'];
const HEX64 = /^[a-f0-9]{64}$/;
function fail(message) { throw new Error('Reviewer Slice: ' + message); }

export function assertUnprivilegedReviewerEnvironment(env) {
  for (const key of PRIVILEGED) {
    if (env?.[key]) fail('privileged credential leaked into model-execution Worker: ' + key);
  }
}

// The caller owns Provider mechanics (SDK loading, workspace, model). This
// function owns what a Review Slice may ask for and what it may return.
export async function runReviewSlice({ admission, runner, taskId, runId, runAttempt, env = process.env }) {
  assertUnprivilegedReviewerEnvironment(env);
  if (!HEX64.test(taskId ?? '')) fail('missing signed reviewer action ID');
  if (!Number.isSafeInteger(runId) || runId <= 0 ||
      !Number.isSafeInteger(runAttempt) || runAttempt <= 0)
    fail('missing authenticated source Run/Attempt');
  if (typeof runner !== 'function') fail('missing read-only Provider runner');
  // Admission validation (and the exact PR/Issue/target binding) happens here.
  const prompt = renderReviewPrompt(admission);
  const session = await runner(prompt.text, { tools: [...REVIEW_TOOLS] });
  const meta = session?.meta ?? {};
  if (session?.result?.status !== 'finished' || meta.status !== 'finished')
    fail('Provider session did not finish');
  if (!/^agent-[a-zA-Z0-9-]{4,100}$/.test(meta.agent_id ?? ''))
    fail('missing native Agent identity');
  const calls = (meta.tool_calls ?? []).map((name) => String(name).toLowerCase());
  if (calls.some((name) => WRITE_TOOLS.some((tool) => name.includes(tool))))
    fail('write/shell tool observed in a read-only review');
  if (!calls.some((name) => REVIEW_TOOLS.some((tool) => name.includes(tool))))
    fail('no read-only inspection observed');
  const verdict = reviewModelResult(admission, session.result.result);
  const artifact = reviewerResultArtifact({ admission, verdict, taskId, runId, runAttempt });
  return Object.freeze({ prompt, meta, verdict, artifact });
}

// Canonical Agent result artifact. parseAgentResult (the trusted owner) must
// accept it, so the Slice cannot invent a result shape the Ingest rejects.
export function reviewerResultArtifact({ admission, verdict, taskId, runId, runAttempt }) {
  assertAuthenticatedReviewerAdmission(admission);
  if (verdict?.kind !== 'reviewer' || verdict.issue !== admission.issue ||
      verdict.pr_number !== admission.pr_number ||
      verdict.target_sha !== admission.target_sha ||
      !['approved', 'changes_requested'].includes(verdict.outcome))
    fail('verdict is not bound to the admitted Issue/PR/target');
  if (!HEX64.test(taskId ?? '') ||
      !Number.isSafeInteger(runId) || runId <= 0 ||
      !Number.isSafeInteger(runAttempt) || runAttempt <= 0)
    fail('missing authenticated result identity');
  const doc = {
    kind: 'reviewer',
    issue: admission.issue,
    run_id: runId,
    run_attempt: runAttempt,
    target_sha: admission.target_sha,
    outcome: verdict.outcome,
    task_id: taskId,
  };
  return Object.freeze(parseAgentResult(Buffer.from(JSON.stringify(doc))));
}
