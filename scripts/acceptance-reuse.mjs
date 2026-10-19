#!/usr/bin/env node
// Trusted-main Acceptance optimization: reuse only *authenticated* prior Agent Pass.
// An Issue checkbox or report row is a lookup hint, never trusted proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSuccessCriteria, extractSection } from './requirement-acceptance.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const TRUSTED_WORKFLOWS = new Set([
  '.github/workflows/acceptance-orchestrator.yml',
  '.github/workflows/acceptance-postrun-waker.yml',
  '.github/workflows/agent-sc-acceptance.yml',
]);
const SOURCE = /^agent-(cursor|deepseek)$/;
const MAX_CANDIDATE_RUNS = 8;

export function candidateFor(context, criterion, checked) {
  if (criterion.current_result !== 'Pass' || !checked || !SHA.test(context.target_ref)) return null;
  const text = String(criterion.current_evidence ?? '');
  // The display row is used only to locate an independently authenticated artifact.
  const match = text.match(/(?:^|\s)run ([1-9][0-9]*); ref ([a-f0-9]{40}); source (agent-(?:cursor|deepseek))(?=;|$)/i);
  if (!match || match[2].toLowerCase() !== context.target_ref.toLowerCase()) return null;
  const runId = Number(match[1]);
  if (!Number.isSafeInteger(runId)) return null;
  return { runId, source: match[3].toLowerCase() };
}

export function proofCovers(proof, context, criterion, candidate) {
  if (!proof || typeof proof !== 'object' || !SOURCE.test(candidate.source)) return false;
  const run = proof.run;
  const result = proof.result;
  if (!run || !result || run.id !== candidate.runId || run.status !== 'completed' ||
      run.conclusion !== 'success' || run.repository?.full_name !== 'BestNathan/nession' ||
      run.head_repository?.full_name !== 'BestNathan/nession' ||
      !TRUSTED_WORKFLOWS.has(run.path)) return false;
  if (result.run_id !== candidate.runId || result.issue !== context.issue.number ||
      result.stage !== context.stage || result.target_ref !== context.target_ref ||
      result.contract_sha256 !== context.contract_sha256 ||
      result.source !== candidate.source ||
      !Array.isArray(result.selected_criteria) || !Array.isArray(result.criteria) ||
      !result.selected_criteria.includes(criterion.criterion)) return false;
  const accepted = result.criteria.find(item => item.criterion === criterion.criterion);
  return Boolean(accepted && accepted.result === 'Pass');
}

export function selectOutstanding(context, getPriorProof) {
  const parsed = parseSuccessCriteria(extractSection(context.requirement_body, 'Success Criteria'));
  if (parsed.errors.length) return { criteria: context.criteria, reused: [], errors: parsed.errors };
  const candidates = new Map();
  const reused = [];
  const outstanding = [];
  for (const criterion of context.criteria) {
    const checked = parsed.criteria.get(criterion.criterion)?.checked === true;
    const candidate = candidateFor(context, criterion, checked);
    if (!candidate || (!candidates.has(candidate.runId) && candidates.size >= MAX_CANDIDATE_RUNS)) {
      outstanding.push(criterion);
      continue;
    }
    if (!candidates.has(candidate.runId)) {
      try { candidates.set(candidate.runId, getPriorProof(candidate.runId)); }
      catch { candidates.set(candidate.runId, null); }
    }
    if (proofCovers(candidates.get(candidate.runId), context, criterion, candidate)) {
      reused.push(criterion.criterion);
    } else {
      outstanding.push(criterion);
    }
  }
  return { criteria: outstanding, reused, errors: [] };
}

function githubJson(args) {
  return JSON.parse(execFileSync('gh', ['api', ...args], {
    encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function loadPriorProof(repo, issue, stage, runId) {
  const run = githubJson(['repos/' + repo + '/actions/runs/' + runId]);
  if (run.id !== runId || run.status !== 'completed' || run.conclusion !== 'success' ||
      run.repository?.full_name !== repo || run.head_repository?.full_name !== repo ||
      !TRUSTED_WORKFLOWS.has(run.path) || !Number.isSafeInteger(run.run_attempt)) return null;
  const artifacts = githubJson(['repos/' + repo + '/actions/runs/' + runId + '/artifacts?per_page=100']).artifacts;
  if (!Array.isArray(artifacts)) return null;
  const name = 'acceptance-result-' + issue + '-' + stage + '-' + runId + '-' + run.run_attempt;
  const artifact = artifacts.find(a => a.name === name && a.expired === false);
  if (!artifact) return null;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-acceptance-proof-'));
  try {
    execFileSync('gh', ['run', 'download', String(runId), '--repo', repo,
      '--name', name, '--dir', temp], {
      encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const file = path.join(temp, 'acceptance-result.json');
    if (!fs.existsSync(file) || fs.statSync(file).size > 262144) return null;
    return { run, result: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function fixture() {
  const sha = 'a'.repeat(40);
  const context = {
    issue: { number: 42 }, target_ref: sha, stage: 'pre-merge',
    contract_sha256: 'b'.repeat(64),
    requirement_body: [
      '## Success Criteria', '- [x] SC-01 prior trusted result',
      '- [ ] SC-02 waiting', '- [x] SC-03 previously passed',
      '', '## Acceptance Report',
    ].join('\n'),
    criteria: [
      { criterion: 'SC-01', current_result: 'Pass',
        current_evidence: 'run 100; ref ' + sha + '; source agent-cursor; test: checked' },
      { criterion: 'SC-02', current_result: 'Pending', current_evidence: 'awaiting evidence' },
      { criterion: 'SC-03', current_result: 'Pass',
        current_evidence: 'run 100; ref ' + sha + '; source agent-cursor; test: checked' },
    ],
  };
  const proof = {
    run: { id: 100, status: 'completed', conclusion: 'success',
      path: '.github/workflows/acceptance-orchestrator.yml',
      repository: { full_name: 'BestNathan/nession' },
      head_repository: { full_name: 'BestNathan/nession' } },
    result: { run_id: 100, issue: 42, stage: 'pre-merge', target_ref: sha,
      contract_sha256: context.contract_sha256, source: 'agent-cursor',
      selected_criteria: ['SC-01', 'SC-03'],
      criteria: [{ criterion: 'SC-01', result: 'Pass' },
        { criterion: 'SC-03', result: 'Pass' }] },
  };
  let fetches = 0;
  const good = selectOutstanding(context, id => { fetches++; assert.equal(id, 100); return proof; });
  assert.deepEqual(good.reused, ['SC-01', 'SC-03']);
  assert.deepEqual(good.criteria.map(c => c.criterion), ['SC-02']);
  assert.equal(fetches, 1);
  // A fully satisfied stage has no model work and no Issue projection.
  const completed = selectOutstanding({ ...context,
    requirement_body: context.requirement_body.replace('- [ ] SC-02', '- [x] SC-02'),
    criteria: context.criteria.filter(c => c.criterion !== 'SC-02'),
  }, () => proof);
  assert.deepEqual(completed.criteria, []);
  assert.deepEqual(completed.reused, ['SC-01', 'SC-03']);
  assert.equal(selectOutstanding(context, () => ({
    ...proof, result: { ...proof.result, issue: 41 },
  })).reused.length, 0);
  assert.equal(selectOutstanding(context, () => ({
    ...proof, result: { ...proof.result, stage: 'post-merge' },
  })).reused.length, 0);
  assert.equal(selectOutstanding(context, () => ({
    ...proof, run: { ...proof.run, conclusion: 'failure' },
  })).reused.length, 0);
  assert.equal(selectOutstanding(context, () => null).reused.length, 0);
  assert.equal(selectOutstanding(context, () => { throw Error('403'); }).reused.length, 0);
  assert.equal(selectOutstanding({ ...context, target_ref: 'c'.repeat(40) },
    () => proof).reused.length, 0);
  assert.equal(selectOutstanding({ ...context, contract_sha256: 'c'.repeat(64) },
    () => proof).reused.length, 0);
  assert.equal(selectOutstanding(context, () => ({
    ...proof, run: { ...proof.run, path: '.github/workflows/evil.yml' },
  })).reused.length, 0);
  assert.equal(selectOutstanding(context, () => ({
    ...proof, result: { ...proof.result, source: 'deterministic-caller' },
  })).reused.length, 0);
  assert.equal(selectOutstanding(context, () => ({
    ...proof, result: { ...proof.result, criteria: [{ criterion: 'SC-01', result: 'Fail' }] },
  })).reused.length, 0);
  assert.equal(selectOutstanding({ ...context,
    requirement_body: context.requirement_body.replace('- [x] SC-01', '- [ ] SC-01') },
    () => proof).reused.includes('SC-01'), false);
  assert.equal(selectOutstanding({ ...context,
    criteria: [{ ...context.criteria[0], current_evidence:
      'run 999; ref ' + sha + '; source agent-cursor;' }] },
    () => proof).reused.length, 0);
  console.log('Acceptance proof reuse: prior artifact, mixed SCs, forged report, stale SHA/contract, trust and failures passed');
}

function main() {
  if (process.argv[2] === 'self-test') return fixture();
  if (process.argv[2] !== 'select' || process.argv.length !== 4) {
    throw Error('usage: acceptance-reuse.mjs <self-test|select CONTEXT_JSON>');
  }
  const contextPath = process.argv[3];
  const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo !== 'BestNathan/nession') throw Error('only the trusted Nession repository may reuse evidence');
  const selected = selectOutstanding(context, id => {
    try { return loadPriorProof(repo, context.issue.number, context.stage, id); }
    catch (err) {
      console.error('prior Acceptance proof cannot be authenticated for run ' + id +
        '; evaluating SC normally: ' + (err instanceof Error ? err.message.slice(0, 160) : 'unknown'));
      return null;
    }
  });
  fs.writeFileSync(contextPath, JSON.stringify({
    ...context, criteria: selected.criteria,
  }, null, 2) + '\n');
  console.log('Acceptance evidence reuse: ' + selected.reused.join(', ') +
    '; Agent still evaluates: ' + selected.criteria.map(c => c.criterion).join(', '));
}
try { main(); } catch (err) { console.error(err); process.exitCode = 1; }
