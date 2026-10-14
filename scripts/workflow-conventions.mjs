#!/usr/bin/env node
// Workflow taxonomy and reference integrity — Issue #1649.
// Baseline names are intentionally supported until each producer/consumer is
// migrated atomically. This is an inventory, not a second acceptance/CI policy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = path.join(ROOT, '.github/workflows');

// Each entry is [logical id, legacy path, legacy display name,
//                target path, target display name, domain].
// Never silently drop a workflow from this inventory. Remove a retired entry
// only with replacement/provenance/required-check evidence in the owning PR.
export const CATALOG = [
  ['agent-sc-acceptance', 'acceptance.yml', 'Acceptance', 'agent-sc-acceptance.yml', 'Agent / SC Acceptance', 'agent'],
  ['agent-issue-audit', 'issue-audit.yml', 'Issue Audit Agent', 'agent-issue-audit.yml', 'Agent / Issue Audit', 'agent'],
  ['agent-provider-smoke', 'agent-provider-smoke.yml', 'AI Agent Provider Smoke', 'agent-provider-smoke.yml', 'Agent / Provider Smoke', 'agent'],
  ['acceptance-orchestrator', 'requirement-acceptance.yml', 'Requirement Acceptance', 'acceptance-orchestrator.yml', 'Acceptance / Orchestrator', 'acceptance'],
  ['acceptance-postrun-waker', 'acceptance-postrun-waker.yml', 'Acceptance / Post-Run Waker', 'acceptance-postrun-waker.yml', 'Acceptance / Post-Run Waker', 'acceptance'],
  ['acceptance-cases', 'acceptance-cases.yml', 'Acceptance Cases', 'acceptance-cases.yml', 'Acceptance / Cases', 'acceptance'],
  ['acceptance-case-ingest', 'acceptance-case-ingest.yml', 'Acceptance Case Ingest', 'acceptance-case-ingest.yml', 'Acceptance / Case Ingest', 'acceptance'],
  ['acceptance-case-smoke', 'acceptance-case-smoke.yml', 'Acceptance Case Smoke', 'acceptance-case-smoke.yml', 'Acceptance / Case Smoke', 'acceptance'],
  ['e2e-tests', 'e2e.yml', 'E2E Tests', 'e2e-tests.yml', 'E2E / Tests', 'e2e'],
  ['e2e-scenario-smoke', 'e2e-scenario-smoke.yml', 'E2E Scenario Smoke', 'e2e-scenario-smoke.yml', 'E2E / Scenario Smoke', 'e2e'],
  ['e2e-scenario-ingest', 'e2e-run-ingest.yml', 'E2E Run Ingest', 'e2e-scenario-ingest.yml', 'E2E / Scenario Ingest', 'e2e'],
  ['e2e-test-ingest', 'e2e-test-run-ingest.yml', 'E2E Test Run Ingest', 'e2e-test-ingest.yml', 'E2E / Test Ingest', 'e2e'],
  ['ci-quality', 'quality.yml', 'Quality Gate', 'ci-quality.yml', 'CI / Quality Gate', 'ci'],
  ['ci-pages', 'ci-pages.yml', 'CI / Pages', 'ci-pages.yml', 'CI / Pages', 'ci'],
  ['deploy-pages', 'deploy-pages.yml', 'Deploy / Public Pages', 'deploy-pages.yml', 'Deploy / Public Pages', 'delivery'],
  ['metrics-agent-telemetry', 'metrics-ingest.yml', 'Metrics Ingest', 'metrics-agent-telemetry.yml', 'Metrics / Agent Telemetry Ingest', 'metrics'],
  ['metrics-repository', 'repo-metrics.yml', 'Repository Metrics', 'metrics-repository.yml', 'Metrics / Repository Health', 'metrics'],
  ['release-staging', 'staging.yml', 'Staging', 'release-staging.yml', 'Release / Staging Artifacts', 'delivery'],
  ['release-production', 'release.yml', 'Release', 'release-production.yml', 'Release / Production', 'delivery'],
  ['deploy-manual', 'deploy.yml', 'Deploy', 'deploy-manual.yml', 'Deploy / Manual', 'delivery'],
  ['task-runner', 'task-runner.yml', 'Ephemeral Task Runner', 'task-runner.yml', 'Task / Ephemeral Runner', 'task'],
  ['task-result-ingest', 'task-result-ingest.yml', 'Task Result Ingest', 'task-result-ingest.yml', 'Task / Result Ingest', 'task'],
  ['store-governance-audit', 'store-governance-audit.yml', 'Store / Governance Audit', 'store-governance-audit.yml', 'Store / Governance Audit', 'store'],
];

// Resolve the actual checked-in path from the single canonical catalog.
// Reject missing and ambiguous dual legacy/target copies, rather than choosing
// a different implicit owner than the taxonomy validator.
export function resolveWorkflowPath(id, root = ROOT) {
  const row = CATALOG.find(([value]) => value === id);
  if (!row) throw new Error('unknown workflow catalog id: ' + id);
  const [, legacy, , target] = row;
  const paths = [...new Set([legacy, target])];
  const present = paths.filter((file) => fs.existsSync(path.join(root, '.github/workflows', file)));
  if (present.length !== 1) {
    throw new Error(id + ': expected exactly one workflow file, found ' + present.join(', '));
  }
  return '.github/workflows/' + present[0];
}

const DOMAIN_PREFIX = {
  agent: 'Agent /',
  acceptance: 'Acceptance /',
  e2e: 'E2E /',
  ci: 'CI /',
  metrics: 'Metrics /',
  store: 'Store /',
  task: 'Task /',
};
const stripComment = (line) => line.replace(/\s+#.*$/, '');
const unquote = (s) => {
  const trimmed = stripComment(s).trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
};

export function workflowName(content) {
  const matches = [...content.matchAll(/^name:\s*(.*?)\s*$/gm)];
  if (matches.length !== 1 || !unquote(matches[0][1])) return null;
  return unquote(matches[0][1]);
}

export function reusableReferences(content) {
  return [...content.matchAll(/^\s*uses:\s*['"]?\.\/\.github\/workflows\/([a-zA-Z0-9._-]+\.ya?ml)/gm)]
    .map((m) => m[1]);
}

// This is a deliberately restricted reader for GitHub's top-level
// on.workflow_run.workflows YAML list (inline or block). It is not a YAML
// parser or a new policy engine for arbitrary workflow syntax.
export function upstreamWorkflowNames(content) {
  const lines = content.split(/\r?\n/);
  let insideOn = false, insideRun = false, insideList = false, sawRun = false, sawList = false;
  const names = [];
  for (const raw of lines) {
    const line = stripComment(raw);
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.match(/^ */)[0].length;
    const text = line.trim();
    if (indent === 0) {
      insideOn = /^on:\s*$/.test(text);
      insideRun = false; insideList = false;
      continue;
    }
    if (!insideOn) continue;
    if (indent === 2) {
      insideRun = /^workflow_run:\s*$/.test(text);
      if (insideRun) sawRun = true;
      insideList = false;
      continue;
    }
    if (!insideRun) continue;
    if (indent === 4) {
      insideList = /^workflows:\s*$/.test(text);
      const inline = text.match(/^workflows:\s*\[([^\]]*)\]\s*$/);
      if (insideList || inline) sawList = true;
      if (inline) names.push(...inline[1].split(',').map(unquote).filter(Boolean));
      continue;
    }
    if (insideList && indent === 6) {
      const item = text.match(/^-\s+(.+)$/);
      if (item) names.push(unquote(item[1]));
    }
  }
  return { used: sawRun, valid: !sawRun || (sawList && names.length > 0), names };
}

// Detect direct model entrypoints, NOT references to "nession-agent" as a
// server binary or to model-generated result artifacts. The existing
// agent-workflow-telemetry Gate is the canonical telemetry validator.
export function directlyInvokesModel(content) {
  const lines = content.split(/\r?\n/).filter((l) => !l.trimStart().startsWith('#')).join('\n');
  return /@cursor\/sdk|@anthropic-ai\/claude-code|node\s+scripts\/(?:acceptance-agent|issue-audit-agent|issue-audit-cursor)\.mjs/.test(lines);
}

// SC-16: Gate the *documented* live workflow entrypoints against the same
// canonical catalog that owns path and Actions display names. No second
// independent list of workflow names may evolve inside an individual Skill.
const DOCUMENTED_WORKFLOW_IDS = new Map([
  ['.claude/skills/nession-acceptance/SKILL.md',
    ['agent-sc-acceptance', 'acceptance-cases', 'acceptance-orchestrator']],
  ['.claude/skills/nession-agent-workflow-metrics/SKILL.md',
    ['metrics-agent-telemetry']],
  ['docs/architecture/acceptance-cases.md',
    ['acceptance-cases', 'acceptance-case-ingest']],
]);

export function auditWorkflowDocumentation(documents, catalog = CATALOG) {
  const errors = [];
  const byId = new Map(catalog.map(row => [row[0], row]));
  for (const [docPath, ids] of DOCUMENTED_WORKFLOW_IDS) {
    const doc = documents instanceof Map ? documents.get(docPath) : documents?.[docPath];
    if (typeof doc !== 'string' || !doc) {
      errors.push('missing workflow documentation: ' + docPath);
      continue;
    }
    for (const id of ids) {
      const owner = byId.get(id);
      if (!owner) { errors.push('unknown documented workflow id: ' + id); continue; }
      if (!doc.includes(owner[4])) {
        errors.push(docPath + ': missing current workflow display name ' + owner[4]);
      }
    }
  }
  return errors;
}

export function auditWorkflows(files, catalog = CATALOG, { complete = true, trustedSources = '', ownerDocs = '', requireTargetNames = false, documents = null } = {}) {
  const errors = [];
  const byPath = new Map();
  const names = new Map();
  const seenIds = new Set();

  for (const [id, oldPath, oldName, newPath, newName, domain] of catalog) {
    if (seenIds.has(id)) errors.push('duplicate catalog id: ' + id);
    seenIds.add(id);
    if (domain !== 'delivery' && !DOMAIN_PREFIX[domain]) errors.push(id + ': unknown domain ' + domain);
    if (domain === 'delivery' && !/^(Deploy|Release) \//.test(newName)) errors.push(id + ': invalid delivery prefix');
    if (domain !== 'delivery' && !newName.startsWith(DOMAIN_PREFIX[domain] ?? '\0')) errors.push(id + ': target display prefix mismatch');
    if (!newPath.startsWith(domain === 'delivery' ? (newName.startsWith('Deploy /') ? 'deploy-' : 'release-') : domain + '-')) {
      errors.push(id + ': target path prefix mismatch');
    }
    const oldExists = files.has(oldPath), newExists = files.has(newPath);
    if (oldPath !== newPath && oldExists && newExists) errors.push(id + ': both legacy and target paths exist');
    const presentPath = newExists ? newPath : oldExists ? oldPath : null;
    if (!presentPath) {
      if (complete) errors.push(id + ': missing workflow (expected ' + oldPath + ' or ' + newPath + ')');
      continue;
    }
    if (requireTargetNames && presentPath !== newPath) {
      errors.push(id + ': live workflow must use canonical target path ' + newPath);
    }
    if (byPath.has(presentPath)) errors.push(presentPath + ': multiple catalog owners');
    byPath.set(presentPath, id);
    const actual = workflowName(files.get(presentPath));
    if (requireTargetNames && actual !== newName) {
      errors.push(presentPath + ': live workflow display name must be ' + newName);
    }
    const expectedName = presentPath === newPath && oldPath !== newPath ? newName : null;
    if (expectedName ? actual !== expectedName : !(actual === oldName || (actual === newName && oldPath === newPath))) {
      errors.push(presentPath + ': unexpected name "' + actual + '"');
    }
    if (names.has(actual)) errors.push(presentPath + ': duplicate workflow display name "' + actual + '"');
    names.set(actual, presentPath);
    if (directlyInvokesModel(files.get(presentPath)) && domain !== 'agent') {
      errors.push(presentPath + ': direct LLM invocation must belong to Agent domain');
    }
  }
  for (const file of files.keys()) {
    if (!byPath.has(file)) errors.push('unclassified workflow: ' + file);
  }
  for (const [file, content] of files.entries()) {
    const consumer = upstreamWorkflowNames(content);
    if (!consumer.valid) errors.push(file + ': malformed/empty on.workflow_run.workflows');
    for (const name of consumer.names) {
      if (!names.has(name)) errors.push(file + ': dangling workflow_run upstream display name: ' + name);
    }
    for (const reference of reusableReferences(content)) {
      if (!files.has(reference)) errors.push(file + ': missing reusable workflow path: ' + reference);
    }
  }
  // The trusted provenance source allowlist is an independent stable owner.
  // Check that registered source paths still exist; don't reimplement its
  // event, workflow_id and authorization policy.
  if (trustedSources) {
    const section = trustedSources.split('const TRUSTED_TELEMETRY_SOURCES = new Map(')[1]?.split(']);')[0];
    if (!section) errors.push('unable to locate canonical telemetry source allowlist');
    else {
      for (const match of section.matchAll(/\['\.github\/workflows\/([a-zA-Z0-9._-]+\.ya?ml)'/g)) {
        if (!files.has(match[1])) errors.push('telemetry allowlist references absent workflow: ' + match[1]);
      }
    }
  }
  // CI/CD Skill must advertise paths that actually exist. This is a doc-path
  // invariant only; execution policy and workflow ownership stay elsewhere.
  if (ownerDocs) {
    const owners = ownerDocs.match(/## 3\. Current workflow owners([\s\S]*?)(?=\n## \d+\.|$)/)?.[1];
    if (!owners) errors.push('CI/CD Skill missing current workflow owners section');
    else {
      for (const match of owners.matchAll(/^\s*- \x60\.github\/workflows\/([^\x60]+\.ya?ml)\x60/gm)) {
        if (!files.has(match[1])) errors.push('CI/CD Skill references absent workflow: ' + match[1]);
      }
    }
  }
  if (documents) errors.push(...auditWorkflowDocumentation(documents, catalog));
  return { ok: errors.length === 0, errors, inventory: [...byPath.entries()].map(([file, id]) => ({ file, id })) };
}

function selfTest() {
  const catalog = [
    ['agent-job', 'model.yml', 'Model', 'agent-model.yml', 'Agent / Model', 'agent'],
    ['task-job', 'task.yml', 'Task', 'task-task.yml', 'Task / Runner', 'task'],
    ['task-subscriber', 'subscriber.yml', 'Subscriber', 'task-subscriber.yml', 'Task / Subscriber', 'task'],
  ];
  const old = new Map([
    ['model.yml', 'name: Model\non:\n  workflow_dispatch:\njobs:\n  x:\n    steps:\n      - run: npm install @cursor/sdk'],
    ['task.yml', 'name: Task\non:\n  workflow_dispatch:\njobs:\n  x:\n    steps:\n      - run: cargo build -p nession-agent'],
    ['subscriber.yml', 'name: Subscriber\non:\n  workflow_run:\n    workflows: [Model]\n    types: [completed]\njobs:\n  x:\n    uses: ./.github/workflows/model.yml'],
  ]);
  assert.deepEqual(auditWorkflows(old, catalog).errors, []);
  assert.match(auditWorkflows(old, catalog, { requireTargetNames: true }).errors.join('\n'), /canonical target path/);
  assert.equal(directlyInvokesModel(old.get('task.yml')), false, 'nession-agent binary is not LLM');
  const rename = new Map(old);
  rename.delete('model.yml');
  rename.set('agent-model.yml', old.get('model.yml').replace('name: Model', 'name: Agent / Model'));
  assert.match(auditWorkflows(rename, catalog).errors.join('\n'), /dangling workflow_run upstream/);
  assert.match(auditWorkflows(rename, catalog).errors.join('\n'), /missing reusable workflow path/);
  rename.set('subscriber.yml', old.get('subscriber.yml')
    .replace('workflows: [Model]', 'workflows: [Agent / Model]')
    .replace('/model.yml', '/agent-model.yml'));
  assert.deepEqual(auditWorkflows(rename, catalog).errors, []);
  const bad = new Map(old);
  bad.set('unexpected.yml', 'name: Unexpected');
  assert.match(auditWorkflows(bad, catalog).errors.join('\n'), /unclassified workflow/);
  bad.delete('unexpected.yml');
  bad.set('task.yml', old.get('task.yml').replace('name: Task', 'name: Model'));
  assert.match(auditWorkflows(bad, catalog).errors.join('\n'), /duplicate workflow display name/);
  bad.set('task.yml', old.get('task.yml') + '\n  - run: npm install @anthropic-ai/claude-code');
  assert.match(auditWorkflows(bad, catalog).errors.join('\n'), /direct LLM invocation/);
  const withoutSubscriber = new Map(old);
  withoutSubscriber.delete('subscriber.yml');
  assert.match(auditWorkflows(withoutSubscriber, catalog).errors.join('\n'), /missing workflow/);
  assert.match(auditWorkflows(old, catalog, { trustedSources: 'const TRUSTED_TELEMETRY_SOURCES = new Map([\n  [\'.github/workflows/missing.yml\', {}],\n]);' }).errors.join('\n'), /telemetry allowlist references absent/);
  assert.deepEqual(upstreamWorkflowNames('on:\n  workflow_run:\n    workflows:\n      - Model\n      - Task\n').names, ['Model', 'Task']);
  assert.match(auditWorkflows(old, catalog, { ownerDocs: '## 3. Current workflow owners\n- \x60.github/workflows/missing.yml\x60\n## 4. Other' }).errors.join('\n'), /CI\/CD Skill references absent workflow/);
  assert.equal(workflowName('name: One\nname: Two'), null);
  const docs = new Map([
    ['.claude/skills/nession-acceptance/SKILL.md',
      'Agent / SC Acceptance; Acceptance / Cases; Acceptance / Orchestrator'],
    ['.claude/skills/nession-agent-workflow-metrics/SKILL.md',
      'Metrics / Agent Telemetry Ingest'],
    ['docs/architecture/acceptance-cases.md',
      'Acceptance / Cases; Acceptance / Case Ingest'],
  ]);
  assert.deepEqual(auditWorkflowDocumentation(docs), []);
  const staleDoc = new Map(docs);
  staleDoc.set('.claude/skills/nession-acceptance/SKILL.md', 'Actions -> Acceptance');
  assert.match(auditWorkflowDocumentation(staleDoc).join('\n'), /missing current workflow display name/);
  console.log('workflow-conventions: 10 positive/negative scenarios passed');
}

function check() {
  const files = new Map(fs.readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8')]));
  const sources = fs.readFileSync(path.join(ROOT, 'scripts/agent-workflow-telemetry-contract.mjs'), 'utf8');
  const ownerDocs = fs.readFileSync(path.join(ROOT, '.claude/skills/nession-cicd/SKILL.md'), 'utf8');
  const documents = new Map([...DOCUMENTED_WORKFLOW_IDS.keys()].map(docPath => [
    docPath, fs.readFileSync(path.join(ROOT, docPath), 'utf8'),
  ]));
  const audit = auditWorkflows(files, CATALOG, {
    trustedSources: sources, ownerDocs, requireTargetNames: true, documents,
  });
  if (!audit.ok) {
    for (const error of audit.errors) console.error('✗ ' + error);
    process.exitCode = 1;
    return;
  }
  console.log('workflow-conventions: ' + audit.inventory.length + ' target-name workflows, consumers, trusted telemetry sources and documented entrypoints valid');
}

// Importing this contract for workflow consumers must never run the CLI Gate.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? 'check';
  if (command === 'self-test' || command === '--self-test') selfTest();
  else if (command === 'check') check();
  else throw new Error('Usage: node scripts/workflow-conventions.mjs <check|self-test>');
}
