import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalJson, digest, validateRegistry, resolveIdentity,
  resolveProviderPlan, verifyEffectiveHarness, verifyExternalDependencies } from './harness/contract.mjs';
import { advanceWorkflow, authorizeCommentCommand } from './orchestration/transition.mjs';
import { issueSnapshot, reconcileIssueThread, formatResumeContext } from './orchestration/issue-thread.mjs';
import { checkpointPath, sealCheckpoint, unsealCheckpoint, advanceCheckpointHead } from './store/checkpoint.mjs';
import { canonicalToolId, normalizeProviderEvent, makeExecutionEvent } from './telemetry/execution-event.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
validateRegistry(registry);
const id = resolveIdentity(registry, 'dev-cursor-01', 'implement', 'agent-dev-cursor-01');
assert.equal(id.provider, 'cursor');
assert.throws(() => resolveIdentity(registry, 'dev-cursor-01', 'review', 'agent-dev-cursor-01'), /unauthorized/);
assert.throws(() => resolveIdentity(registry, 'dev-cursor-01', 'implement', 'agent-review-cursor-01'), /environment/);
assert.throws(() => resolveIdentity(registry, 'unknown', 'implement', 'cursor'), /unregistered/);
assert.throws(() => validateRegistry({ ...registry, instances: { ...registry.instances,
  'another-agent': { role: 'reviewer', provider: 'cursor', environment: id.environment } } }), /duplicate environment/);
assert.throws(() => validateRegistry({ ...registry, instances: { ...registry.instances,
  'another-agent': { role: 'reviewer', provider: 'cursor', environment: 'agent-another', api_key: 'oops' } } }), /secret/);
assert.equal(canonicalJson({ z: 1, a: { q: 2 } }), canonicalJson({ a: { q: 2 }, z: 1 }));
assert.match(digest(registry.roles.developer), /^[a-f0-9]{64}$/);
const plan = resolveProviderPlan(registry, id, []);
assert.ok(plan.native_tools.some(x => x.id === 'repo.read' && x.native_name === 'read'));
const observed = { tools: [...new Set(plan.native_tools.map(x=>x.native_name))], skills: plan.canonical_capabilities.skills,
  mcp: plan.canonical_capabilities.mcp, plugins: plan.canonical_capabilities.plugins };
const effective = verifyEffectiveHarness(plan, observed, 'a'.repeat(40), 'sdk-1');
assert.equal(effective.sha256, verifyEffectiveHarness(plan, observed, 'a'.repeat(40), 'sdk-1').sha256);
assert.notEqual(effective.sha256, verifyEffectiveHarness(plan, observed, 'b'.repeat(40), 'sdk-1').sha256);
assert.throws(() => verifyEffectiveHarness(plan, { ...observed, skills: [] }, 'a'.repeat(40), 'sdk-1'), /was not loaded/);
assert.throws(() => verifyEffectiveHarness(plan, observed, 'main', 'sdk-1'), /source SHA/);

const folder = mkdtempSync(path.join(tmpdir(), 'nession-agent-harness-'));
try {
  mkdirSync(path.join(folder, 'plugin'));
  writeFileSync(path.join(folder, 'plugin', 'SKILL.md'), 'verified content');
  const rawSha = createHash('sha256').update(Buffer.from('verified content')).digest('hex');
  const depDigest = digest([{ path: 'SKILL.md', sha256: rawSha }]);
  const dependency = { id: 'superpowers', kind: 'skill', revision: 'v9.2.1',
    path: 'plugin', sha256: depDigest };
  const locked = { ...registry, external_dependencies: [dependency] };
  assert.deepEqual(verifyExternalDependencies(locked, folder), [
    { id: 'superpowers', kind: 'skill', revision: 'v9.2.1', sha256: depDigest },
  ]);
  assert.throws(() => resolveProviderPlan(locked, id, []), /unverified/);
  writeFileSync(path.join(folder, 'plugin', 'SKILL.md'), 'tampered content');
  assert.throws(() => verifyExternalDependencies(locked, folder), /sha256 mismatch/);
  assert.throws(() => validateRegistry({ ...registry, external_dependencies: [
    { ...dependency, revision: 'latest' },
  ] }), /unversioned/);
  assert.throws(() => validateRegistry({ ...registry, external_dependencies: [
    { ...dependency, path: '../escape' },
  ] }), /unsafe/);
} finally { rmSync(folder, { recursive: true, force: true }); }

let state = null, actions;
const event = (kind, outcome, run_id, target_sha = 'a'.repeat(40)) =>
  ({ kind, outcome, issue: 1664, target_sha, run_id, run_attempt: 1 });
const attest = (e) => ({ workflow_run_id: e.run_id, attempt: e.run_attempt,
  role: e.kind, issue: e.issue, source_sha: e.target_sha });
function drive(e) { const result = advanceWorkflow(state, e, attest(e), { max_repairs: 2 }); state = result.state; actions = result.actions; return result; }
const dev = event('developer','implementation_ready',1);
drive(dev);
assert.equal(state.phase, 'review');
assert.equal(actions[0].role, 'reviewer');
assert.equal(drive(dev).duplicate, true);
assert.throws(() => advanceWorkflow(state, event('reviewer','approved',2), null), /untrusted/);
assert.throws(() => advanceWorkflow(state, { ...event('reviewer','approved',2), next_role:'merge' }, attest(event('reviewer','approved',2))), /model cannot/);
assert.throws(() => drive(event('reviewer','approved',2,'b'.repeat(40))), /stale SHA/);
drive(event('reviewer', 'changes_requested', 3));
assert.equal(state.phase, 'repair');
assert.equal(actions[0].resume, true);
drive(event('developer', 'implementation_ready', 4, 'b'.repeat(40)));
assert.equal(state.phase, 'review');
drive(event('reviewer', 'approved', 5, 'b'.repeat(40)));
assert.equal(state.phase, 'quality');
drive(event('quality', 'passed', 6, 'b'.repeat(40)));
assert.equal(state.phase, 'acceptance');
assert.equal(actions[0].gate, 'sc-acceptance');
assert.equal(actions[0].when, 'pr');
assert.throws(() => drive(event('acceptor', 'passed', 7, 'b'.repeat(40))), /invalid event envelope/);
drive(event('acceptance', 'passed', 7, 'b'.repeat(40)));
assert.equal(state.phase, 'waiting-merge');
assert.deepEqual(actions[0], { type: 'notify', reason: 'requires_authorized_merge' });
drive(event('merge', 'completed', 8, 'c'.repeat(40)));
assert.equal(state.phase, 'post-merge-acceptance');
assert.equal(actions[0].when, 'merged');
drive(event('acceptance', 'passed', 9, 'c'.repeat(40)));
assert.equal(state.phase, 'done');
assert.equal(authorizeCommentCommand('/agent review', 'write').role, 'reviewer');
assert.throws(() => authorizeCommentCommand('/agent review', 'read'), /authority/);
assert.throws(() => authorizeCommentCommand('/agent merge', 'write'), /unsupported/);

const identity = { role: 'developer', agent_id: 'dev-cursor-01', issue: 1664 };
const key = randomBytes(32);
const secret = Buffer.from('PRIVATE SESSION TEXT');
const sealed = sealCheckpoint(identity, 1, secret, key, { provider:'cursor' });
assert.ok(!JSON.stringify(sealed).includes('PRIVATE SESSION TEXT'));
assert.equal(unsealCheckpoint(identity, sealed, key).toString(), secret.toString());
assert.throws(() => unsealCheckpoint(identity, sealed, randomBytes(32)), /authentication failed/);
assert.throws(() => unsealCheckpoint({ ...identity, issue: 1665 }, sealed, key), /identity/);
assert.match(checkpointPath(identity, 1), /roles\/developer\/dev-cursor-01\/issues\/1664\/checkpoints\/00000001.json/);
const next = advanceCheckpointHead(null, null, { version: 1, checkpoint_path: checkpointPath(identity, 1) });
assert.equal(next.version, 1);
assert.throws(() => advanceCheckpointHead(next, null, { version: 2, checkpoint_path: checkpointPath(identity, 2) }), /stale/);

const context = { role: 'developer', agent_id: 'dev-cursor-01', issue: 1664,
  github_run_id: 123, github_run_attempt: 1 };
const cur = normalizeProviderEvent('cursor', { type:'tool_call', name:'read', id:'x1', status:'running' }, context, 0);
assert.equal(cur.type, 'tool.started');
assert.equal(cur.data.tool.id, 'repo.read');
const claude = normalizeProviderEvent('claude-code', { type:'assistant',
  message:{ content:[{type:'tool_use', name:'Read', id:'x2', input:{ file_path:'/secret' }}] } }, context, 1);
assert.equal(claude.data.tool.id, cur.data.tool.id);
assert.ok(!JSON.stringify(claude).includes('/secret'));
assert.equal(canonicalToolId('claude-code', 'mcp__github__issue_read').server, 'github');
assert.equal(normalizeProviderEvent('claude-code', {type:'other'}, context, 2), null);
assert.throws(() => makeExecutionEvent(context, 'tool.completed', 3,
  { observation:'native-event', arguments:{ key:'secret' } }), /unsafe/);
const usage = normalizeProviderEvent('cursor', { type:'usage', inputTokens:100 }, context, 3);
assert.equal(usage.data.usage.input, 100);
assert.equal(usage.data.usage.output, null);
const issue = { number: 1664, title: 'test', body: 'SC-01', updated_at: '2026-10-13T00:00:00Z' };
const comment = { id: 1001, user: { login: 'bot' }, body: 'Review feedback',
  created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z' };
const snapshot = issueSnapshot(issue, [comment]);
const initial = reconcileIssueThread(snapshot);
assert.equal(initial.comments.length, 1);
const none = reconcileIssueThread(snapshot, initial.cursor);
assert.equal(none.comments.length, 0);
const edited = issueSnapshot(issue, [{ ...comment, body: 'New review feedback',
  updated_at: '2026-10-13T01:00:00Z' }]);
const delta = reconcileIssueThread(edited, initial.cursor);
assert.equal(delta.comments.length, 1);
assert.match(formatResumeContext(edited, delta, 'b'.repeat(40)), /New review feedback/);
assert.throws(() => reconcileIssueThread(issueSnapshot(issue, []), initial.cursor), /disappeared/);
console.log('agent development foundation self-test: passed');
