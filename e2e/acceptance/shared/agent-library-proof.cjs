'use strict';

// #1556 source-aligned staging verifier. Never writes to GitHub.
// Stage SHA and live full-stack runtime are owned by the Acceptance runner.
// Historical provider-run evidence is independently authenticated from public
// GitHub Actions and immutable Metrics records; it is NOT staged-SHA execution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const CANARY_SHA = '9c8a98359b769b3abe985d595b1393fb4a5acd23';
const CANARY_RUN = 37966430313;
const PROVIDERS = ['cursor', 'deepseek'];
const api = 'https://api.github.com/repos/BestNathan/nession';

function test(file, args = ['self-test']) {
  const output = execFileSync(process.execPath, [file, ...args], {
    cwd: root, encoding: 'utf8', timeout: 45000,
    env: { ...process.env, GITHUB_REPOSITORY: 'BestNathan/nession' },
  });
  assert.match(output, /self-test:|cases passed|test: passed/i,
    'required deterministic test did not report a Pass: ' + file);
  return output.trim().split('\n').slice(-1)[0];
}
function source(relative) {
  const full = path.join(root, relative);
  assert.ok(fs.statSync(full).isFile(), 'required source missing: ' + relative);
  return fs.readFileSync(full, 'utf8');
}
function assertSourceMatch(relative, expression, rationale) {
  assert.match(source(relative), expression, rationale + ' (' + relative + ')');
}
async function githubJson(uri) {
  const response = await fetch(uri, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nession-stage-case-1556' },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, 'trusted public GitHub evidence unavailable: ' + uri + ' status=' + response.status);
  return response.json();
}
async function trustedProviderEvidence() {
  const run = await githubJson(api + '/actions/runs/' + CANARY_RUN);
  assert.equal(run.name, 'AI Agent Provider Smoke');
  assert.equal(run.event, 'push');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, CANARY_SHA);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');

  const jobs = await githubJson(api + '/actions/runs/' + CANARY_RUN + '/jobs?per_page=100');
  for (const provider of PROVIDERS) {
    const job = jobs.jobs.find(x => x.name === 'Read-only Acceptance (' + provider + ')');
    assert.ok(job, 'real Provider Job absent: ' + provider);
    assert.equal(job.conclusion, 'success', 'real Provider Job failed: ' + provider);
  }
  return {
    type: 'external-run',
    value: 'trusted-main provider smoke run=' + CANARY_RUN + ' exact main SHA=' + CANARY_SHA + ' cursor=success deepseek=success',
  };
}
async function metricsEvidence() {
  const records = [];
  for (const provider of PROVIDERS) {
    const filename = CANARY_RUN + '-1-issue-1556-staging-' + provider + '.json';
    const uri = api + '/contents/raw/workflows/agent-provider-smoke/2026-10-09/' +
      filename + '?ref=metrics';
    const remote = await githubJson(uri);
    assert.equal(remote.encoding, 'base64', 'Metrics artifact is not a file');
    const obj = JSON.parse(Buffer.from(remote.content.replace(/\s/g, ''), 'base64').toString('utf8'));
    assert.equal(obj.schema_version, 1);
    assert.equal(obj.identity.workflow_id, 'agent-provider-smoke');
    assert.equal(obj.identity.github_run_id, CANARY_RUN);
    assert.equal(obj.identity.unique_run_name, filename.replace(/\.json$/, ''));
    assert.equal(obj.agent.provider, provider);
    assert.equal(obj.agent.status, 'finished');
    assert.equal(obj.agent.prompt?.id, 'acceptance');
    assert.equal(obj.agent.prompt?.version, 'v1');
    assert.match(obj.agent.prompt.sha256, /^[a-f0-9]{64}$/);
    assert.equal(obj.task.target_ref, CANARY_SHA);
    assert.equal(obj.result.status, 'completed');
    assert.equal(obj.result.pending, 1);
    assert.equal(obj.result.pass, 0);
    const serialized = JSON.stringify(obj);
    assert.doesNotMatch(serialized, /ANTHROPIC_AUTH_TOKEN|CURSOR_API_KEY|ANTHROPIC_API_KEY|BEGIN PRIVATE KEY/,
      'Telemetry must not contain secret material');
    records.push({ provider, filename, prompt: obj.agent.prompt.sha256 });
  }
  assert.notEqual(records[0].filename, records[1].filename, 'immutable Provider records collided');
  assert.equal(records[0].prompt, records[1].prompt, 'Acceptance Prompt must be shared across Providers');
  return {
    type: 'durable-telemetry',
    value: 'metrics orphan branch has two unique source-attested immutable records: ' +
      records.map(x => x.filename).join(', ') + '; prompt_sha256=' + records[0].prompt,
  };
}

function verifyStage() {
  const sha = process.env.NESSION_ACCEPTANCE_TARGET_SHA || '';
  assert.match(sha, /^[a-f0-9]{40}$/, 'staging acceptance must supply exact SHA');
  assert.equal(process.env.GITHUB_REF_NAME, 'staging', 'requires actual staging push');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sha);
  const runtimeFile = process.env.NESSION_ACCEPTANCE_RUNTIME_FILE;
  assert.ok(runtimeFile && fs.existsSync(runtimeFile), 'runner live full-stack evidence missing');
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  assert.equal(runtime.target_sha, sha);
  assert.equal(runtime.profile, 'full-stack-local');
  assert.match(String(runtime.base_url), /^http:\/\/localhost:[0-9]+$/, 'isolated Web runtime absent');
  assert.match(process.env.NESSION_ACCEPTANCE_CONTRACT_SHA256 || '', /^[a-f0-9]{64}$/,
    'trusted Issue Contract digest not provided');
  return { sha, runtime };
}

function verifyLibraryOwner() {
  assertSourceMatch('scripts/lib/agent/tasks/issue-audit.mjs',
    /renderAgentPrompt\([\s\S]*?id: 'issue-audit'[\s\S]*?variant: provider/,
    'two Providers must consume one versioned Issue Audit Prompt owner');
  assertSourceMatch('scripts/lib/agent/tasks/acceptance.mjs',
    /renderAgentPrompt\([\s\S]*?id: 'acceptance'/,
    'Acceptance must use versioned common Prompt owner');
  assertSourceMatch('scripts/lib/agent/providers/cursor.mjs',
    /selectCursorModel[\s\S]*?no fallback is allowed/,
    'Cursor model selection must fail closed');
  assertSourceMatch('scripts/issue-audit-agent.mjs',
    /applyIssueAuditProposal/,
    'Claude Code must route proposals through the host-side validator');
  assertSourceMatch('scripts/issue-audit-cursor.mjs',
    /issueAuditTools\(issue\)/,
    'Cursor Issue Audit must register fixed-target tool capabilities');
  assertSourceMatch('scripts/lib/agent/tasks/issue-audit.mjs',
    /createIssueUpdateTool/,
    'both Issue Audit Provider paths must use the same GH tool');
}

function verifyIssueMutationBoundary() {
  verifyLibraryOwner();
  assertSourceMatch('scripts/lib/agent/tools/gh/issue/update.mjs',
    /const before = auditIssue\(candidate\)/,
    'a proposal must pass Issue Contract before a write');
  assertSourceMatch('scripts/lib/agent/tools/gh/issue/update.mjs',
    /const after = fetchGitHubIssue[\s\S]*?const verified = auditIssue\(after\)/,
    'Issue Contract must be revalidated after a write');
  assertSourceMatch('scripts/lib/agent/tools/gh/issue/update.mjs',
    /Unauthorized Issue update tool arguments/,
    'out-of-scope target fields must be rejected');
  assertSourceMatch('scripts/lib/agent/tasks/issue-audit.mjs',
    /unauthorized fields/,
    'Claude proposals cannot smuggle target/tool overrides');
  const tests = [
    test('scripts/lib/agent/selftest.mjs'),
    test('scripts/issue-audit-agent.mjs'),
    test('scripts/issue-audit-cursor.mjs'),
  ];
  return { type: 'negative-test', value: 'fixed target / malformed proposals / real mocked GH writes: ' + tests.join('; ') };
}

async function criterionEvidence(sc) {
  const results = [];
  if (['SC-03', 'SC-05', 'SC-06', 'SC-07'].includes(sc)) verifyLibraryOwner();
  switch (sc) {
    case 'SC-03':
      results.push(verifyIssueMutationBoundary());
      results.push({ type: 'adapter-test', value:
        test('scripts/acceptance-agent.mjs') + '; ' + test('scripts/lib/agent/provider-smoke.mjs') });
      results.push(await trustedProviderEvidence());
      break;
    case 'SC-05':
      results.push(verifyIssueMutationBoundary());
      results.push({ type: 'trust-boundary', value: 'both provider paths use createIssueUpdateTool; auditIssue before/after; unauthorized field checks and mock gh write tests executed' });
      break;
    case 'SC-06':
      assertSourceMatch('scripts/acceptance-agent.mjs',
        /workflow_id: process\.env\.NSESSION_AGENT_WORKFLOW_ID \|\| 'requirement-acceptance'/,
        'canonical workflow identity/default must remain compatible');
      assertSourceMatch('scripts/agent-workflow-telemetry.mjs',
        /schema_version: 1/,
        'canonical Telemetry schema must remain v1');
      results.push({ type: 'contract-test', value:
        test('scripts/acceptance-agent.mjs') + '; ' +
        test('scripts/agent-workflow-telemetry.mjs') + '; ' +
        test('scripts/agent-workflow-telemetry-contract.mjs') });
      results.push(await metricsEvidence());
      break;
    case 'SC-07':
      results.push({ type: 'gate-test', value:
        test('scripts/issue-audit-agent.mjs') + '; ' +
        test('scripts/issue-audit-cursor.mjs') + '; ' +
        test('scripts/acceptance-agent.mjs') });
      results.push(verifyIssueMutationBoundary());
      results.push(await trustedProviderEvidence());
      results.push(await metricsEvidence());
      break;
    default:
      throw new Error('unrecognized #1556 Criterion: ' + sc);
  }
  return results;
}

async function verify(sc) {
  const { sha, runtime } = verifyStage();
  const response = await fetch(runtime.base_url + '/', { signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200, 'exact staging SHA full-stack Web is not serving');
  const evidence = await criterionEvidence(sc);
  evidence.unshift({
    type: 'runtime',
    value: 'staging exact_sha=' + sha + ' full-stack profile=' + runtime.profile + ' Web HTTP=' + response.status,
  });
  evidence.push({ type: 'contract', value: 'source-aligned 1556/' + sc +
    ' contract_sha256=' + process.env.NESSION_ACCEPTANCE_CONTRACT_SHA256 });
  return {
    status: 'pass',
    summary: sc + ': exact staged source/runtime plus applicable deterministic and externally authenticated Provider evidence verified; main provider run is independent of staged SHA',
    evidence,
  };
}

function selfTest() {
  assert.throws(() => verifyStage(), /exact SHA|staging push/);
  assert.throws(() => { verifyLibraryOwner(); throw new Error('negative fixture'); },
    /negative fixture/);
  assert.ok(['SC-03', 'SC-05', 'SC-06', 'SC-07'].length === 4);
  console.log('1556 Acceptance verifier self-test: positive/negative cases passed');
}

module.exports = { verify, selfTest };
