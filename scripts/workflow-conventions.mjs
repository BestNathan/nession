#!/usr/bin/env node
// Workflow taxonomy and reference integrity — Issue #1649.
// Baseline names are intentionally supported until each producer/consumer is
// migrated atomically. This is an inventory, not a second acceptance/CI policy.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  ['automation-comment-router', 'automation-comment-router.yml', 'Automation / Comment Router', 'automation-comment-router.yml', 'Automation / Comment Router', 'automation'],
  ['agent-controller-dispatch', 'agent-controller-dispatch.yml', 'Agent / Controller Dispatch', 'agent-controller-dispatch.yml', 'Agent / Controller Dispatch', 'agent'],
  ['agent-develop', 'agent-develop.yml', 'Agent / Development', 'agent-develop.yml', 'Agent / Development', 'agent'],
  ['agent-staging-developer-canary', 'agent-staging-developer-canary.yml', 'Agent / Staging Developer Canary', 'agent-staging-developer-canary.yml', 'Agent / Staging Developer Canary', 'agent'],
  ['agent-review', 'agent-review.yml', 'Agent / Review', 'agent-review.yml', 'Agent / Review', 'agent'],
  ['agent-e2e-failure-analysis', 'agent-e2e-failure-analysis.yml', 'Agent / E2E Failure Analysis', 'agent-e2e-failure-analysis.yml', 'Agent / E2E Failure Analysis', 'agent'],
  ['agent-staging-convergence-review', 'agent-staging-convergence-review.yml', 'Agent / Staging Convergence Review', 'agent-staging-convergence-review.yml', 'Agent / Staging Convergence Review', 'agent'],
  ['store-agent-dispatch-reconcile', 'store-agent-dispatch-reconcile.yml', 'Store / Agent Dispatch Reconcile', 'store-agent-dispatch-reconcile.yml', 'Store / Agent Dispatch Reconcile', 'store'],
  ['store-agent-development-ingest', 'store-agent-development-ingest.yml', 'Store / Agent Development Ingest', 'store-agent-development-ingest.yml', 'Store / Agent Development Ingest', 'store'],
  ['store-agent-review-result-ingest', 'store-agent-review-result-ingest.yml', 'Store / Agent Review Result Ingest', 'store-agent-review-result-ingest.yml', 'Store / Agent Review Result Ingest', 'store'],
  ['store-controlled-publisher', 'store-controlled-publisher.yml', 'Store / Controlled Publisher', 'store-controlled-publisher.yml', 'Store / Controlled Publisher', 'store'],
  ['store-knowledge-proposal-signal', 'store-knowledge-proposal-signal.yml', 'Store / Knowledge Proposal Signal', 'store-knowledge-proposal-signal.yml', 'Store / Knowledge Proposal Signal', 'store'],
  ['store-knowledge-publisher', 'store-knowledge-publisher.yml', 'Store / Knowledge Publisher', 'store-knowledge-publisher.yml', 'Store / Knowledge Publisher', 'store'],
  ['store-knowledge-canary-probe', 'store-knowledge-canary-probe.yml', 'Store / Knowledge Canary Probe', 'store-knowledge-canary-probe.yml', 'Store / Knowledge Canary Probe', 'store'],
  ['store-qwen-publisher', 'store-qwen-publisher.yml', 'Store / Qwen Publisher', 'store-qwen-publisher.yml', 'Store / Qwen Publisher', 'store'],
  ['store-publisher-review-ingest', 'store-publisher-review-ingest.yml', 'Store / Publisher Review Ingest', 'store-publisher-review-ingest.yml', 'Store / Publisher Review Ingest', 'store'],
  ['agent-sc-acceptance', 'acceptance.yml', 'Acceptance', 'agent-sc-acceptance.yml', 'Agent / SC Acceptance', 'agent'],
  ['agent-issue-audit', 'issue-audit.yml', 'Issue Audit Agent', 'agent-issue-audit.yml', 'Agent / Issue Audit', 'agent'],
  ['agent-provider-smoke', 'agent-provider-smoke.yml', 'AI Agent Provider Smoke', 'agent-provider-smoke.yml', 'Agent / Provider Smoke', 'agent'],
  ['agent-cursor-resume-seed', 'agent-cursor-resume-seed.yml', 'Agent / Cursor Resume Seed', 'agent-cursor-resume-seed.yml', 'Agent / Cursor Resume Seed', 'agent'],
  ['agent-cursor-resume-verify', 'agent-cursor-resume-verify.yml', 'Agent / Cursor Resume Verify', 'agent-cursor-resume-verify.yml', 'Agent / Cursor Resume Verify', 'agent'],
  ['agent-claude-resume-seed', 'agent-claude-resume-seed.yml', 'Agent / Claude Resume Seed', 'agent-claude-resume-seed.yml', 'Agent / Claude Resume Seed', 'agent'],
  ['agent-claude-resume-verify', 'agent-claude-resume-verify.yml', 'Agent / Claude Resume Verify', 'agent-claude-resume-verify.yml', 'Agent / Claude Resume Verify', 'agent'],
  ['acceptance-agent-controller', 'acceptance-agent-controller.yml', 'Acceptance / Agent Controller', 'acceptance-agent-controller.yml', 'Acceptance / Agent Controller', 'acceptance'],
  ['acceptance-agent-reconcile', 'acceptance-agent-reconcile.yml', 'Acceptance / Agent Reconcile', 'acceptance-agent-reconcile.yml', 'Acceptance / Agent Reconcile', 'acceptance'],
  ['acceptance-staging-developer-admission', 'acceptance-staging-developer-admission.yml', 'Acceptance / Staging Developer Admission', 'acceptance-staging-developer-admission.yml', 'Acceptance / Staging Developer Admission', 'acceptance'],
  ['acceptance-staging-developer-dispatch', 'acceptance-staging-developer-dispatch.yml', 'Acceptance / Staging Developer Dispatch', 'acceptance-staging-developer-dispatch.yml', 'Acceptance / Staging Developer Dispatch', 'acceptance'],
  ['store-agent-controller-ingest', 'store-agent-controller-ingest.yml', 'Store / Agent Controller Ingest', 'store-agent-controller-ingest.yml', 'Store / Agent Controller Ingest', 'store'],
  ['acceptance-orchestrator', 'requirement-acceptance.yml', 'Requirement Acceptance', 'acceptance-orchestrator.yml', 'Acceptance / Orchestrator', 'acceptance'],
  ['acceptance-manual-request', 'acceptance-manual-request.yml', 'Acceptance / Manual Request', 'acceptance-manual-request.yml', 'Acceptance / Manual Request', 'acceptance'],
  ['acceptance-orchestrator-background', 'acceptance-orchestrator-background.yml', 'Acceptance / Orchestrator Background', 'acceptance-orchestrator-background.yml', 'Acceptance / Orchestrator Background', 'acceptance'],
  ['acceptance-postrun-waker', 'acceptance-postrun-waker.yml', 'Acceptance / Post-Run Waker', 'acceptance-postrun-waker.yml', 'Acceptance / Post-Run Waker', 'acceptance'],
  ['acceptance-pr-quality-waker', 'acceptance-pr-quality-waker.yml', 'Acceptance / PR Quality Waker', 'acceptance-pr-quality-waker.yml', 'Acceptance / PR Quality Waker', 'acceptance'],
  ['acceptance-event-consumer', 'acceptance-event-consumer.yml', 'Acceptance / Event Consumer', 'acceptance-event-consumer.yml', 'Acceptance / Event Consumer', 'acceptance'],
  ['acceptance-e2e-failure-bug', 'acceptance-e2e-failure-bug.yml', 'Acceptance / E2E Failure Bug', 'acceptance-e2e-failure-bug.yml', 'Acceptance / E2E Failure Bug', 'acceptance'],
  ['acceptance-verified-stage', 'acceptance-verified-stage.yml', 'Acceptance / Verified Issue Stage', 'acceptance-verified-stage.yml', 'Acceptance / Verified Issue Stage', 'acceptance'],
  ['acceptance-quota-recovery', 'acceptance-quota-recovery.yml', 'Acceptance / Quota Recovery', 'acceptance-quota-recovery.yml', 'Acceptance / Quota Recovery', 'acceptance'],
  ['acceptance-cases', 'acceptance-cases.yml', 'Acceptance Cases', 'acceptance-cases.yml', 'Acceptance / Cases', 'acceptance'],
  ['acceptance-case-ingest', 'acceptance-case-ingest.yml', 'Acceptance Case Ingest', 'acceptance-case-ingest.yml', 'Acceptance / Case Ingest', 'acceptance'],
  ['acceptance-case-smoke', 'acceptance-case-smoke.yml', 'Acceptance Case Smoke', 'acceptance-case-smoke.yml', 'Acceptance / Case Smoke', 'acceptance'],
  ['e2e-tests', 'e2e.yml', 'E2E Tests', 'e2e-tests.yml', 'E2E / Tests', 'e2e'],
  ['e2e-full-regression', 'e2e-full-regression.yml', 'E2E / Full Regression', 'e2e-full-regression.yml', 'E2E / Full Regression', 'e2e'],
  ['e2e-staging-lanes', 'e2e-staging-lanes.yml', 'E2E / Staging Lanes', 'e2e-staging-lanes.yml', 'E2E / Staging Lanes', 'e2e'],
  ['e2e-scenario-smoke', 'e2e-scenario-smoke.yml', 'E2E Scenario Smoke', 'e2e-scenario-smoke.yml', 'E2E / Scenario Smoke', 'e2e'],
  ['e2e-scenario-ingest', 'e2e-run-ingest.yml', 'E2E Run Ingest', 'e2e-scenario-ingest.yml', 'E2E / Scenario Ingest', 'e2e'],
  ['e2e-test-ingest', 'e2e-test-run-ingest.yml', 'E2E Test Run Ingest', 'e2e-test-ingest.yml', 'E2E / Test Ingest', 'e2e'],
  ['e2e-full-failure-ingest', 'e2e-full-failure-ingest.yml', 'E2E Full Failure Intake', 'e2e-full-failure-ingest.yml', 'E2E / Full Failure Intake', 'e2e'],
  ['ci-quality', 'quality.yml', 'Quality Gate', 'ci-quality.yml', 'CI / Quality Gate', 'ci'],
  ['ci-toolchain-candidate', 'ci-toolchain-candidate.yml', 'CI / Toolchain Candidate', 'ci-toolchain-candidate.yml', 'CI / Toolchain Candidate', 'ci'],
  ['ci-web-dist-reuse-proof', 'ci-web-dist-reuse-proof.yml', 'CI / Web Dist Reuse Proof', 'ci-web-dist-reuse-proof.yml', 'CI / Web Dist Reuse Proof', 'ci'],
  ['ci-run-store-integrity-audit', 'ci-run-store-integrity-audit.yml', 'CI / Run Store Integrity Audit', 'ci-run-store-integrity-audit.yml', 'CI / Run Store Integrity Audit', 'ci'],
  ['ci-run-store-anchor', 'ci-run-store-anchor.yml', 'CI / Run Store Signed Checkpoint', 'ci-run-store-anchor.yml', 'CI / Run Store Signed Checkpoint', 'ci'],
  ['ci-knowledge-ledger-audit', 'ci-knowledge-ledger-audit.yml', 'CI / Knowledge Ledger Audit', 'ci-knowledge-ledger-audit.yml', 'CI / Knowledge Ledger Audit', 'ci'],
  ['ci-run-store-fixture-evidence', 'ci-run-store-fixture-evidence.yml', 'CI / Run Store Fixture Evidence', 'ci-run-store-fixture-evidence.yml', 'CI / Run Store Fixture Evidence', 'ci'],
  ['ci-pages', 'ci-pages.yml', 'CI / Pages', 'ci-pages.yml', 'CI / Pages', 'ci'],
  ['deploy-pages', 'deploy-pages.yml', 'Deploy / Public Pages', 'deploy-pages.yml', 'Deploy / Public Pages', 'delivery'],
  ['metrics-agent-telemetry', 'metrics-ingest.yml', 'Metrics Ingest', 'metrics-agent-telemetry.yml', 'Metrics / Agent Telemetry Ingest', 'metrics'],
  ['metrics-replay-request', 'metrics-replay-request.yml', 'Metrics / Replay Request', 'metrics-replay-request.yml', 'Metrics / Replay Request', 'metrics'],
  ['metrics-repository', 'repo-metrics.yml', 'Repository Metrics', 'metrics-repository.yml', 'Metrics / Repository Health', 'metrics'],
  ['release-staging', 'staging.yml', 'Staging', 'release-staging.yml', 'Release / Staging Artifacts', 'delivery'],
  ['release-staging-convergence', 'release-staging-convergence.yml', 'Release / Staging Convergence', 'release-staging-convergence.yml', 'Release / Staging Convergence', 'delivery'],
  ['release-production', 'release.yml', 'Release', 'release-production.yml', 'Release / Production', 'delivery'],
  ['release-toolchains', 'release-toolchains.yml', 'Release / Toolchains', 'release-toolchains.yml', 'Release / Toolchains', 'delivery'],
  ['release-toolchain-single', 'release-toolchain-one.yml', 'Release / Toolchain Single', 'release-toolchain-one.yml', 'Release / Toolchain Single', 'delivery'],
  ['deploy-manual', 'deploy.yml', 'Deploy', 'deploy-manual.yml', 'Deploy / Manual', 'delivery'],
  ['deploy-configure-site', 'deploy-configure-site.yml', 'Deploy / Configure Site', 'deploy-configure-site.yml', 'Deploy / Configure Site', 'delivery'],
  ['deploy-seal-gitops-secret', 'deploy-seal-gitops-secret.yml', 'Deploy / Seal GitOps Secret', 'deploy-seal-gitops-secret.yml', 'Deploy / Seal GitOps Secret', 'delivery'],
  ['deploy-identity', 'deploy-identity.yml', 'Deploy / Identity', 'deploy-identity.yml', 'Deploy / Identity', 'delivery'],
  ['deploy-staging-acr', 'deploy-staging-acr.yml', 'Deploy / Staging ACR', 'deploy-staging-acr.yml', 'Deploy / Staging ACR', 'delivery'],
  ['deploy-staging-ghcr', 'deploy-staging-ghcr.yml', 'Deploy / Staging GHCR', 'deploy-staging-ghcr.yml', 'Deploy / Staging GHCR', 'delivery'],
  ['deploy-acr-macos-mirror', 'deploy-acr-macos-mirror.yml', 'Deploy / ACR Mirror (hs-mac)', 'deploy-acr-macos-mirror.yml', 'Deploy / ACR Mirror (hs-mac)', 'delivery'],
  ['deploy-erofs-ghcr-smoke', 'deploy-erofs-ghcr-smoke.yml', 'Deploy / EROFS GHCR Smoke', 'deploy-erofs-ghcr-smoke.yml', 'Deploy / EROFS GHCR Smoke', 'delivery'],
  ['deploy-oci-pull-readback', 'deploy-oci-pull-readback.yml', 'Deploy / OCI Pull Readback', 'deploy-oci-pull-readback.yml', 'Deploy / OCI Pull Readback', 'delivery'],
  ['deploy-staging-rollout-readback', 'deploy-staging-rollout-readback.yml', 'Deploy / Staging Rollout Readback', 'deploy-staging-rollout-readback.yml', 'Deploy / Staging Rollout Readback', 'delivery'],
  ['deploy-mcp-secret-preflight', 'deploy-mcp-secret-preflight.yml', 'Deploy / MCP Secret Preflight', 'deploy-mcp-secret-preflight.yml', 'Deploy / MCP Secret Preflight', 'delivery'],
  ['deploy-identity-ingest', 'deploy-identity-ingest.yml', 'Deploy / Identity Ingest', 'deploy-identity-ingest.yml', 'Deploy / Identity Ingest', 'delivery'],
  ['task-runner', 'task-runner.yml', 'Ephemeral Task Runner', 'task-runner.yml', 'Task / Ephemeral Runner', 'task'],
  ['task-result-ingest', 'task-result-ingest.yml', 'Task Result Ingest', 'task-result-ingest.yml', 'Task / Result Ingest', 'task'],
  ['store-governance-audit', 'store-governance-audit.yml', 'Store / Governance Audit', 'store-governance-audit.yml', 'Store / Governance Audit', 'store'],
  ['store-five-mode-readback', 'store-five-mode-readback.yml', 'Store / Five-Mode Readback', 'store-five-mode-readback.yml', 'Store / Five-Mode Readback', 'store'],
  ['store-app-writer-smoke', 'store-app-writer-smoke.yml', 'Store / App Writer Smoke', 'store-app-writer-smoke.yml', 'Store / App Writer Smoke', 'store'],
  ['store-agent-bootstrap', 'store-agent-bootstrap.yml', 'Store / Agent Bootstrap', 'store-agent-bootstrap.yml', 'Store / Agent Bootstrap', 'store'],
  ['store-receipt-readback', 'store-receipt-readback.yml', 'Store / Receipt Readback', 'store-receipt-readback.yml', 'Store / Receipt Readback', 'store'],
 ];

// #4342: the Workflow Catalog owns source workflow identity and telemetry
// admission policy. These keys refer to CATALOG rows; they are not a second
// hand-edited path/name registry. Metrics group IDs are deliberately separate
// and may be shared by different sources (Acceptance).
export const TELEMETRY_SOURCE_POLICY = Object.freeze({
  'agent-develop': {group_id:'agent-develop',events:['workflow_dispatch'],main_only:true},
  'agent-staging-developer-canary': {group_id:'agent-staging-developer-canary',events:['workflow_run'],workflow_run_branches:['main']},
  'agent-review': {group_id:'agent-review',events:['workflow_dispatch'],main_only:true},
  'acceptance-verified-stage': {group_id:'requirement-acceptance',events:['issue_comment']},
  'agent-sc-acceptance': {group_id:'requirement-acceptance',events:['workflow_dispatch'],main_only:true},
  'acceptance-orchestrator': {group_id:'requirement-acceptance',events:['pull_request_target','issues','push'],push_branches:['staging','main'],branches:['main','staging']},
  'agent-issue-audit': {group_id:'issue-audit',events:['issues','workflow_dispatch'],main_only:true},
  'agent-e2e-failure-analysis': {group_id:'agent-e2e-failure-analysis',events:['workflow_dispatch'],main_only:true},
  'agent-staging-convergence-review': {group_id:'agent-staging-convergence-review',events:['workflow_dispatch','push'],push_branches:['main'],main_only:true},
  'agent-provider-smoke': {group_id:'agent-provider-smoke',events:['push','workflow_dispatch'],main_only:true},
  'agent-cursor-resume-seed': {group_id:'agent-cursor-resume-seed',events:['push','workflow_dispatch'],main_only:true},
  'agent-cursor-resume-verify': {group_id:'agent-cursor-resume-verify',events:['workflow_run'],workflow_run_branches:['main']},
  'agent-claude-resume-seed': {group_id:'agent-claude-resume-seed',events:['push','workflow_dispatch'],main_only:true},
  'agent-claude-resume-verify': {group_id:'agent-claude-resume-verify',events:['workflow_run'],workflow_run_branches:['main']},
});

// A verified, read-only projection: no inferred aliases, no display-name
// authentication, no implicit fallback if a Catalog owner is ambiguous.
export function telemetryWorkflowSources(catalog=CATALOG, policy=TELEMETRY_SOURCE_POLICY) {
  const seenPaths=new Set();
  return Object.entries(policy).map(([key, config]) => {
    const matches=catalog.filter(row => row[0]===key);
    if(matches.length!==1)throw Error('telemetry source has missing/ambiguous Catalog key: '+key);
    const [, , , filename, displayName] = matches[0];
    const path='.github/workflows/'+filename;
    if(seenPaths.has(path))throw Error('duplicate telemetry source path: '+path);
    seenPaths.add(path);
    if(!/^[a-z0-9][a-z0-9._-]*$/.test(config.group_id ?? ''))
      throw Error('invalid telemetry group for '+key);
    if(!Array.isArray(config.events)||!config.events.length||
      config.events.some(event=>!['push','issues','issue_comment','pull_request_target','workflow_dispatch','workflow_run'].includes(event))||
      new Set(config.events).size!==config.events.length)
      throw Error('invalid telemetry source events: '+key);
    for(const [field,values] of Object.entries(config)){
      if(!['branches','push_branches','workflow_run_branches'].includes(field))continue;
      if(!Array.isArray(values)||!values.length||
         values.some(v=>!['main','staging'].includes(v))||new Set(values).size!==values.length)
        throw Error('invalid telemetry source branch policy: '+key);
    }
    return Object.freeze({
      key,path,file:filename,name:displayName,group_id:config.group_id,
      events:Object.freeze([...config.events]),
      branches:Object.freeze([...(config.branches??['main'])]),
      main_only:config.main_only===true,
      push_branches:Object.freeze([...(config.push_branches??[])]),
      workflow_run_branches:Object.freeze([...(config.workflow_run_branches??[])]),
    });
  });
}

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
  automation: 'Automation /',
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
// Only two orphan-branch signals are authorized, never executed in main.
// The Knowledge signal source bytes are pinned by knowledge-ledger-contract.mjs.
export const EXTERNAL_WORKFLOW_RUN_SOURCES = Object.freeze([
  Object.freeze({consumerFile:'deploy-pages.yml',displayName:'Prototype / Change Signal',branch:'prototype',producerFile:'.github/workflows/prototype-changed.yml'}),
  Object.freeze({consumerFile:'deploy-pages.yml',displayName:'Knowledge / Change Signal',branch:'knowledge',producerFile:'.github/workflows/knowledge-changed.yml'}),
]);
export const EXTERNAL_WORKFLOW_RUN_SOURCE = EXTERNAL_WORKFLOW_RUN_SOURCES[0];
// Exact one-owner routing guard: disallow spoofed name/branch combinations,
// permissive OR clauses, unrelated consumers, or altered event conditions.
const EXTERNAL_PAGES_RUN_GUARD = ["${{","  github.event_name != 'workflow_run' || (","    github.event.workflow_run.event == 'push' &&","    github.event.workflow_run.conclusion == 'success' &&","    github.event.workflow_run.head_repository.full_name == github.repository &&","    (","      (github.event.workflow_run.name == 'Prototype / Change Signal' &&","       github.event.workflow_run.head_branch == 'prototype') ||","      (github.event.workflow_run.name == 'Knowledge / Change Signal' &&","       github.event.workflow_run.head_branch == 'knowledge')","    )","  )","}}"].join(' ').replace(/\s+/g, ' ').trim();
export function approvedExternalWorkflowRunSource(consumerFile, content, displayName) {
  // #4160: this third independent orphan signal is permitted ONLY for Toolchain
  // Release, bound to the owned source, successful push and exact branch.
  if (consumerFile === 'release-toolchains.yml' && displayName === 'Toolchains / Catalog Change') {
    const exactHeader = /^  workflow_run:\s*$/m.test(content) &&
      /^    workflows: \['Toolchains \/ Catalog Change'\]\s*$/m.test(content) &&
      /^    types: \[completed\]\s*$/m.test(content) &&
      /^    branches: \[toolchains\]\s*$/m.test(content);
    const required = [
      "github.repository == 'BestNathan/nession' &&",
      "github.event_name == 'workflow_run' &&",
      "github.event.workflow_run.conclusion == 'success' &&",
      "github.event.workflow_run.event == 'push' &&",
      "github.event.workflow_run.head_branch == 'toolchains' &&",
      "github.event.workflow_run.name == 'Toolchains / Catalog Change' &&",
      "github.event.workflow_run.head_repository.full_name == 'BestNathan/nession'",
    ];
    return exactHeader && required.every(item => content.includes(item));
  }
  if (consumerFile !== 'deploy-pages.yml' ||
      !EXTERNAL_WORKFLOW_RUN_SOURCES.some(source => source.displayName === displayName)) return false;
  if (!/^  workflow_run:\s*$/m.test(content) ||
      !/^    workflows: \['Prototype \/ Change Signal', 'Knowledge \/ Change Signal'\]\s*$/m.test(content) ||
      !/^    types: \[completed\]\s*$/m.test(content) ||
      !/^    branches: \[prototype, knowledge\]\s*$/m.test(content)) return false;
  const found = content.match(/^    if: >-\n((?: {6}.*\n)+)    name: Build independent Pages\s*$/m);
  return Boolean(found) && found[1].replace(/\s+/g,' ').trim() === EXTERNAL_PAGES_RUN_GUARD;
}

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

export function auditWorkflows(files, catalog = CATALOG, { complete = true, telemetryPolicy = null, ownerDocs = '', requireTargetNames = false, documents = null } = {}) {
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
      if (!names.has(name) && !approvedExternalWorkflowRunSource(file, content, name)) errors.push(file + ': dangling workflow_run upstream display name: ' + name);
    }
    for (const reference of reusableReferences(content)) {
      if (!files.has(reference)) errors.push(file + ': missing reusable workflow path: ' + reference);
    }
    // A `trusted/` path exists only when trusted main is checked out under
    // that path. A narrower copy of the prefix dies at runtime on the first
    // missing module, and a non-required workflow can stay broken unnoticed.
    if (/(^|[\s"'])trusted\//m.test(content) && !/^\s*path:\s*trusted\s*$/m.test(content)) {
      errors.push(file + ': references trusted/ without a path: trusted checkout');
    }
  }
  // The same Catalog projection drives source trust and scheduled recovery.
  if (telemetryPolicy) {
    let projected = [];
    try { projected = telemetryWorkflowSources(catalog,telemetryPolicy); }
    catch(error) { errors.push(String(error.message)); }
    for (const source of projected) {
      if (!files.has(source.file)) errors.push('telemetry allowlist references absent workflow: '+source.file);
      else if (workflowName(files.get(source.file))!==source.name)
        errors.push('telemetry source Catalog display-name drift: '+source.file);
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
  if (files.has('automation-comment-router.yml')) {
    for (const file of ['agent-issue-audit.yml', 'acceptance-manual-request.yml']) {
      if (/^  issue_comment:\s*$/m.test(files.get(file) ?? ''))
        errors.push(file + ': duplicate public command listener; use Automation / Comment Router');
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
  // A trusted/ path only resolves when the workflow checks main out there.
  const trustedPath = new Map(old);
  trustedPath.set('task.yml', old.get('task.yml') +
    '\n      - run: node trusted/scripts/run-store-integrity.mjs staged agent-store "$store"');
  assert.match(auditWorkflows(trustedPath, catalog).errors.join('\n'),
    /task\.yml: references trusted\/ without a path: trusted checkout/);
  trustedPath.set('task.yml', old.get('task.yml') +
    '\n      - uses: actions/checkout@v4\n        with:\n          path: trusted\n' +
    '      - run: node trusted/scripts/run-store-integrity.mjs staged agent-store "$store"');
  assert.deepEqual(auditWorkflows(trustedPath, catalog).errors, []);
  assert.match(auditWorkflows(old,catalog,{
    telemetryPolicy:{'missing-agent':{group_id:'any',events:['push']}}
  }).errors.join('\n'),/missing\/ambiguous Catalog key/);
  assert.throws(()=>telemetryWorkflowSources(catalog,{
    'agent-job':{group_id:'bad group',events:['workflow_dispatch']}
  }),/invalid telemetry group/);

  assert.deepEqual(upstreamWorkflowNames('on:\n  workflow_run:\n    workflows:\n      - Model\n      - Task\n').names, ['Model', 'Task']);
  assert.match(auditWorkflows(old, catalog, { ownerDocs: '## 3. Current workflow owners\n- \x60.github/workflows/missing.yml\x60\n## 4. Other' }).errors.join('\n'), /CI\/CD Skill references absent workflow/);
  // The two unprivileged orphan producers cannot create a generic bypass.
  const signalConsumer = [
    'name: Deploy / Public Pages',
    'on:',
    '  workflow_run:',
    "    workflows: ['Prototype / Change Signal', 'Knowledge / Change Signal']",
    '    types: [completed]',
    '    branches: [prototype, knowledge]',
    'jobs:',
    '  build:',
    '    if: >-',
    ...["${{","  github.event_name != 'workflow_run' || (","    github.event.workflow_run.event == 'push' &&","    github.event.workflow_run.conclusion == 'success' &&","    github.event.workflow_run.head_repository.full_name == github.repository &&","    (","      (github.event.workflow_run.name == 'Prototype / Change Signal' &&","       github.event.workflow_run.head_branch == 'prototype') ||","      (github.event.workflow_run.name == 'Knowledge / Change Signal' &&","       github.event.workflow_run.head_branch == 'knowledge')","    )","  )","}}"].map(line => '      '+line),
    '    name: Build independent Pages',
  ].join('\n')+'\n';
  for (const source of EXTERNAL_WORKFLOW_RUN_SOURCES) {
    assert.equal(approvedExternalWorkflowRunSource('deploy-pages.yml',signalConsumer,source.displayName),true);
    assert.equal(approvedExternalWorkflowRunSource('ci-quality.yml',signalConsumer,source.displayName),false);
  }
  assert.equal(approvedExternalWorkflowRunSource('deploy-pages.yml',signalConsumer,'Fake / Signal'),false);
  const toolchainSignal = [
    'name: Release / Toolchains',
    'on:',
    '  workflow_run:',
    "    workflows: ['Toolchains / Catalog Change']",
    '    types: [completed]',
    '    branches: [toolchains]',
    'jobs:',
    '  plan:',
    '    if: >-',
    "      github.repository == 'BestNathan/nession' &&",
    "      (github.event_name == 'workflow_dispatch' ||",
    "       (github.event_name == 'workflow_run' &&",
    "        github.event.workflow_run.conclusion == 'success' &&",
    "        github.event.workflow_run.event == 'push' &&",
    "        github.event.workflow_run.head_branch == 'toolchains' &&",
    "        github.event.workflow_run.name == 'Toolchains / Catalog Change' &&",
    "        github.event.workflow_run.head_repository.full_name == 'BestNathan/nession'))",
  ].join('\n')+'\n';
  assert.equal(approvedExternalWorkflowRunSource('release-toolchains.yml',toolchainSignal,'Toolchains / Catalog Change'),true);
  for(const [from,to] of [
    ['branches: [toolchains]','branches: [main]'],
    ["head_branch == 'toolchains'","head_branch == 'main'"],
    ["head_repository.full_name == 'BestNathan/nession'","head_repository.full_name == 'other/repo'"],
    ["conclusion == 'success'","conclusion == 'failure'"],
    ["event == 'push'","event == 'workflow_dispatch'"],
    ["'Toolchains / Catalog Change'","'Fake / Change'"],
  ]) assert.equal(approvedExternalWorkflowRunSource('release-toolchains.yml',toolchainSignal.replace(from,to),'Toolchains / Catalog Change'),false);
  assert.equal(approvedExternalWorkflowRunSource('deploy-pages.yml',toolchainSignal,'Toolchains / Catalog Change'),false);

  for (const [from,to] of [
    ['branches: [prototype, knowledge]','branches: [main]'],
    ["'Knowledge / Change Signal']","'Other / Signal']"],
    ["event == 'push'","event == 'workflow_dispatch'"],
    ["conclusion == 'success'","conclusion == 'failure'"],
    ["head_repository.full_name == github.repository","head_repository.full_name == unknown"],
    ["head_branch == 'knowledge'","head_branch == 'prototype'"],
    ["github.event_name != 'workflow_run'","true"],
    ["name == 'Knowledge / Change Signal' &&","name == 'Knowledge / Change Signal' ||"],
  ])assert.equal(approvedExternalWorkflowRunSource('deploy-pages.yml',signalConsumer.replace(from,to),'Knowledge / Change Signal'),false);
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
  for (const script of ['github-comment-command.mjs', 'github-comment-source.mjs', 'github-comment-router.mjs']) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', script), 'self-test'], {
      stdio: 'inherit',
    });
  }
  const live = new Map([
    ['agent-sc-acceptance.yml', 'options:\\n  - pr\\n  - staging\\n'],
    ['acceptance-orchestrator.yml', 'stage: pr\\n'],
    ['acceptance-case-smoke.yml', './e2e/run acceptance-batch --stage pr\\n'],
    ['acceptance-cases.yml', 'options: [staging, post-merge, deployed]\\n'],
  ]);
  assert.deepEqual(auditCanonicalPrWorkflowTiming(live), []);
  const stale = new Map(live);
  stale.set('acceptance-case-smoke.yml', 'run with pre-merge');
  assert.match(auditCanonicalPrWorkflowTiming(stale).join('\\n'), /deprecated PR timing/);
  assert.match(auditCanonicalPrWorkflowTiming(new Map()).join('\\n'), /workflow missing/);
  console.log('workflow-conventions: standard and dual-orphan positive/negative scenarios passed');
}

// #3388: never reintroduce the retired PR timing spelling into live workflow
// dispatch. Historical immutable Run/Issue readers are owned outside YAML.
export function auditCanonicalPrWorkflowTiming(files) {
  const required = [
    'agent-sc-acceptance.yml',
    'acceptance-orchestrator.yml',
    'acceptance-case-smoke.yml',
    'acceptance-cases.yml',
  ];
  const errors = [];
  for (const file of required) {
    const content = files.get(file);
    if (content == null) errors.push(file + ': canonical PR Acceptance workflow missing');
    else if (/pre-merge/i.test(content))
      errors.push(file + ': deprecated PR timing alias in live workflow; use pr');
  }
  if (!/\bstage: pr\b/.test(files.get('acceptance-orchestrator.yml') ?? ''))
    errors.push('Acceptance Orchestrator must dispatch stage: pr');
  if (!/--stage pr\b/.test(files.get('acceptance-case-smoke.yml') ?? ''))
    errors.push('PR Case Smoke must use --stage pr');
  if (!/- pr\b/.test(files.get('agent-sc-acceptance.yml') ?? ''))
    errors.push('Agent Acceptance workflow must expose pr stage');
  if (!/options: \[staging, post-merge, deployed\]/.test(files.get('acceptance-cases.yml') ?? ''))
    errors.push('Formal Cases must not expose a PR stage selection');
  return errors;
}

function check() {
  const files = new Map(fs.readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8')]));
  const ownerDocs = fs.readFileSync(path.join(ROOT, '.claude/skills/nession-cicd/SKILL.md'), 'utf8');
  const documents = new Map([...DOCUMENTED_WORKFLOW_IDS.keys()].map(docPath => [
    docPath, fs.readFileSync(path.join(ROOT, docPath), 'utf8'),
  ]));
  const audit = auditWorkflows(files, CATALOG, {
    telemetryPolicy: TELEMETRY_SOURCE_POLICY, ownerDocs, requireTargetNames: true, documents,
  });
  const errors = [...audit.errors, ...auditCanonicalPrWorkflowTiming(files)];
  if (errors.length) {
    for (const error of errors) console.error('✗ ' + error);
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
