#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  extractSection,
  parseAcceptanceReport,
  parseSuccessCriteria,
  validateRequirementBody,
} from './requirement-acceptance.mjs';

const STAGES = new Set(['pre-merge', 'staging', 'post-merge']);
const RESULTS = new Map([
  ['pass', 'Pass'],
  ['pending', 'Pending'],
  ['fail', 'Fail'],
  ['n/a', 'N/A'],
  ['na', 'N/A'],
]);
const PLACEHOLDERS = new Set(['', '-', 'none', 'n/a', 'na', 'pending', 'tbd', 'todo', 'implementation pending']);

function stageOf(value) {
  const stage = String(value ?? '').trim().toLowerCase();
  if (!STAGES.has(stage)) throw new Error('unsupported acceptance stage: ' + (value || '(empty)'));
  return stage;
}

function runIdOf(value) {
  const runId = Number(value);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('acceptance run id must be a positive integer');
  return runId;
}

function parseContract(body) {
  const success = parseSuccessCriteria(extractSection(body, 'Success Criteria'));
  const report = parseAcceptanceReport(extractSection(body, 'Acceptance Report'));
  const errors = [...success.errors, ...report.errors];
  for (const criterion of success.criteria.values()) {
    const row = report.rows.get(criterion.id);
    if (!row) errors.push(criterion.id + ' has no Acceptance Report row');
    else if (!STAGES.has(row.stage)) errors.push(criterion.id + ' has unsupported acceptance stage ' + row.stage);
  }
  for (const row of report.rows.values()) {
    if (!success.criteria.has(row.id)) errors.push('Acceptance Report contains unknown criterion ' + row.id);
  }
  if (errors.length) throw new Error('invalid acceptance contract:\n- ' + errors.join('\n- '));
  return { criteria: success.criteria, rows: report.rows };
}

function contractDigest(contract) {
  const canonical = [...contract.criteria.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      stage: contract.rows.get(criterion.id).stage,
    }));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function buildAcceptanceContext(issue, stage, options = {}) {
  const normalizedStage = stageOf(stage);
  const runId = runIdOf(options.runId);
  const contract = parseContract(issue.body);
  const criteria = [...contract.criteria.values()]
    .filter((criterion) => contract.rows.get(criterion.id).stage === normalizedStage)
    .map((criterion) => {
      const row = contract.rows.get(criterion.id);
      return {
        criterion: criterion.id,
        text: criterion.text,
        stage: row.stage,
        current_result: row.result,
        current_evidence: row.evidence,
      };
    });
  return {
    schema_version: 1,
    issue: { number: Number(issue.number), title: issue.title ?? '', url: issue.url ?? '' },
    stage: normalizedStage,
    contract_sha256: contractDigest(contract),
    run_id: runId,
    target_ref: (() => {
      const ref = String(options.targetRef ?? '').trim();
      if (!ref) throw new Error('target_ref is required');
      return ref;
    })(),
    deployment: options.deployment ? String(options.deployment).trim() : null,
    criteria,
    requirement_body: String(issue.body ?? ''),
  };
}

function evidenceArray(value) {
  if (typeof value === 'string') {
    const v = value.trim();
    return v ? [{ type: 'text', value: v }] : [];
  }
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('evidence must be a string or array');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error('evidence[' + index + '] must be an object');
    const type = String(item.type ?? '').trim();
    const evidence = String(item.value ?? '').trim();
    if (!type || !evidence) throw new Error('evidence[' + index + '] requires type and value');
    if (/[\r\n]/.test(type) || /[\r\n]/.test(evidence)) throw new Error('evidence must be single-line');
    return { type, value: evidence };
  });
}

function normalizeCriterion(item) {
  if (!item || typeof item !== 'object') throw new Error('criterion result must be an object');
  const criterion = String(item.criterion ?? '').trim().toUpperCase();
  if (!/^SC-\d{2,}$/.test(criterion)) throw new Error('invalid criterion id: ' + (criterion || '(empty)'));
  const result = RESULTS.get(String(item.result ?? '').trim().toLowerCase());
  if (!result) throw new Error(criterion + ' has unsupported result ' + (item.result ?? '(empty)'));
  const summary = String(item.summary ?? '').trim();
  if (/[\r\n]/.test(summary)) throw new Error(criterion + ' summary must be single-line');
  const evidence = evidenceArray(item.evidence);
  const concrete = evidence.some((entry) => !PLACEHOLDERS.has(entry.value.toLowerCase()));
  if ((result === 'Pass' || result === 'N/A') && !concrete) throw new Error(criterion + ' ' + result + ' requires concrete evidence');
  if (result === 'N/A' && !summary) throw new Error(criterion + ' N/A requires a justification summary');
  if ((result === 'Fail' || result === 'Pending') && !summary && evidence.length === 0) {
    throw new Error(criterion + ' ' + result + ' requires evidence or an explanatory summary');
  }
  return { criterion, result, evidence, summary };
}

export function normalizeAcceptanceResult(context, raw, source = 'agent') {
  const input = Array.isArray(raw) ? { criteria: raw } : raw;
  if (!input || typeof input !== 'object' || !Array.isArray(input.criteria)) {
    throw new Error('acceptance result must contain a criteria array');
  }
  const expected = new Set(context.criteria.map((item) => item.criterion));
  const seen = new Set();
  const criteria = input.criteria.map((item) => {
    const normalized = normalizeCriterion(item);
    if (!expected.has(normalized.criterion)) throw new Error('unknown or wrong-stage criterion ' + normalized.criterion);
    if (seen.has(normalized.criterion)) throw new Error('duplicate criterion ' + normalized.criterion);
    seen.add(normalized.criterion);
    return normalized;
  });
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) throw new Error('acceptance result is missing criteria: ' + missing.join(', '));
  return {
    schema_version: 1,
    issue: context.issue.number,
    stage: context.stage,
    contract_sha256: context.contract_sha256,
    run_id: context.run_id,
    target_ref: context.target_ref,
    deployment: context.deployment,
    source: String(source || 'unknown'),
    criteria,
  };
}

function replaceSection(body, heading, transform) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const wanted = heading.toLowerCase();
  let header = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{2,6})\s+(.+?)\s*$/);
    if (match && match[2].trim().toLowerCase() === wanted) {
      header = i;
      level = match[1].length;
      break;
    }
  }
  if (header < 0) throw new Error('missing ' + heading + ' section');
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{2,6})\s+/);
    if (match && match[1].length <= level) {
      end = i;
      break;
    }
  }
  const changed = transform(lines.slice(header + 1, end));
  return [...lines.slice(0, header + 1), ...changed, ...lines.slice(end)].join('\n');
}

function escapeCell(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function evidenceText(result, meta) {
  const pieces = result.evidence.map((entry) => entry.type + ': ' + entry.value);
  if (result.summary) pieces.push('summary: ' + result.summary);
  const deployment = meta.deployment ? '; deployment ' + meta.deployment : '';
  return escapeCell(
    'run ' + meta.run_id +
    '; ref ' + (meta.target_ref || '(unspecified)') +
    '; source ' + meta.source +
    deployment +
    '; ' + (pieces.join('; ') || 'no additional evidence')
  );
}

function automatedRunId(evidence) {
  const match = String(evidence ?? '').match(/^run\s+(\d+)\s*;/i);
  return match ? Number(match[1]) : null;
}

function updateCheckboxes(body, resultMap) {
  return replaceSection(body, 'Success Criteria', (lines) => lines.map((line) => {
    const match = line.match(/^(\s*-\s+\[)[ xX](\]\s+(SC-\d{2,})\b.*)$/i);
    if (!match) return line;
    const result = resultMap.get(match[3].toUpperCase());
    if (!result) return line;
    const checked = result.result === 'Pass' || result.result === 'N/A' ? 'x' : ' ';
    return match[1] + checked + match[2];
  }));
}

function updateReport(body, contract, resultMap, meta) {
  return replaceSection(body, 'Acceptance Report', (lines) => lines.map((line) => {
    const match = line.match(/^\s*\|\s*(SC-\d{2,})\s*\|/i);
    if (!match) return line;
    const id = match[1].toUpperCase();
    const result = resultMap.get(id);
    if (!result) return line;
    const row = contract.rows.get(id);
    const evidence = evidenceText(result, meta);
    return row.explicitStage
      ? '| ' + id + ' | ' + row.stage + ' | ' + result.result + ' | ' + evidence + ' |'
      : '| ' + id + ' | ' + result.result + ' | ' + evidence + ' |';
  }));
}

export function applyAcceptanceResultToBody(body, normalized) {
  const contract = parseContract(body);
  if (contractDigest(contract) !== normalized.contract_sha256) {
    throw new Error('requirement contract changed after acceptance started; refusing stale result');
  }
  const stage = stageOf(normalized.stage);
  const runId = runIdOf(normalized.run_id);
  if (!Array.isArray(normalized.criteria)) throw new Error('acceptance result criteria must be an array');

  const expected = [...contract.criteria.values()]
    .filter((criterion) => contract.rows.get(criterion.id).stage === stage)
    .map((criterion) => criterion.id);
  const resultMap = new Map();
  for (const raw of normalized.criteria) {
    const result = normalizeCriterion(raw);
    if (resultMap.has(result.criterion)) throw new Error('duplicate criterion ' + result.criterion);
    const row = contract.rows.get(result.criterion);
    if (!row) throw new Error('unknown criterion ' + result.criterion);
    if (row.stage !== stage) throw new Error(result.criterion + ' belongs to ' + row.stage + ', not requested stage ' + stage);
    resultMap.set(result.criterion, result);
  }
  const missing = expected.filter((id) => !resultMap.has(id));
  if (missing.length) throw new Error('acceptance result is missing criteria: ' + missing.join(', '));

  for (const [id] of resultMap) {
    const previous = automatedRunId(contract.rows.get(id).evidence);
    if (previous != null && previous > runId) {
      throw new Error(id + ' has newer acceptance run ' + previous + '; refusing stale run ' + runId);
    }
  }

  let updated = updateCheckboxes(body, resultMap);
  updated = updateReport(updated, contract, resultMap, { ...normalized, run_id: runId });
  return updated;
}

function labelNames(issue) {
  return (issue.labels ?? []).map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean);
}

function fetchIssue(issueNumber) {
  if (!Number.isSafeInteger(Number(issueNumber)) || Number(issueNumber) <= 0) throw new Error('issue number must be a positive integer');
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is required');
  const raw = execFileSync(
    'gh',
    ['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'number,title,body,state,url,labels'],
    { encoding: 'utf8', env: process.env }
  );
  return JSON.parse(raw);
}

function prepareCommand(issueNumber, stage, targetRef, outFile, deployment) {
  const issue = fetchIssue(issueNumber);
  if (String(issue.state).toUpperCase() !== 'OPEN') throw new Error('requirement #' + issueNumber + ' is not open');
  if (!labelNames(issue).includes('requirement')) throw new Error('issue #' + issueNumber + ' is not labeled requirement');
  const context = buildAcceptanceContext(issue, stage, {
    targetRef,
    deployment,
    runId: process.env.ACCEPTANCE_RUN_ID ?? process.env.GITHUB_RUN_ID,
  });
  fs.writeFileSync(outFile, JSON.stringify(context, null, 2) + '\n');
  console.log('prepared ' + context.criteria.length + ' ' + context.stage + ' criteria for requirement #' + issueNumber);
}

function normalizeCommand(contextFile, rawFile, outFile, source) {
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  const normalized = normalizeAcceptanceResult(context, raw, source);
  fs.writeFileSync(outFile, JSON.stringify(normalized, null, 2) + '\n');
}

function applyCommand(issueNumber, resultFile) {
  const issue = fetchIssue(issueNumber);
  if (!labelNames(issue).includes('requirement')) throw new Error('issue #' + issueNumber + ' is not labeled requirement');
  const normalized = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  if (Number(normalized.issue) !== Number(issueNumber)) throw new Error('result targets issue #' + normalized.issue + ', not #' + issueNumber);
  const updated = applyAcceptanceResultToBody(issue.body, normalized);
  if (updated === issue.body) {
    console.log('requirement #' + issueNumber + ' already matches acceptance run ' + normalized.run_id);
    return;
  }
  execFileSync(
    'gh',
    ['issue', 'edit', String(issueNumber), '--repo', process.env.GITHUB_REPOSITORY, '--body-file', '-'],
    { input: updated, encoding: 'utf8', env: process.env }
  );
  const counts = normalized.criteria.reduce((acc, item) => {
    acc[item.result] = (acc[item.result] ?? 0) + 1;
    return acc;
  }, {});
  console.log('updated requirement #' + issueNumber + ': ' + JSON.stringify(counts));
}

function fixtureBody() {
  return [
    '## Requirements: fixture',
    '',
    'Keep this paragraph exactly.',
    '',
    '### Success Criteria',
    '',
    '- [ ] SC-01 deterministic update works',
    '- [ ] SC-02 failing acceptance stays unchecked',
    '',
    '## Acceptance Report',
    '',
    '| Criterion | Stage | Result | Evidence |',
    '|---|---|---|---|',
    '| SC-01 | staging | Pending | implementation pending |',
    '| SC-02 | post-merge | Pending | requires production deployment; verify after release |',
    '',
    '## Product alignment',
    '',
    '- [x] aligned',
    '',
    '---',
    '**Status:** Approved',
  ].join('\n');
}

function selfTest() {
  const issue = { number: 1360, title: 'Requirement: fixture', url: 'https://example.test/1360', body: fixtureBody() };
  const staging = buildAcceptanceContext(issue, 'staging', { targetRef: 'abc123', deployment: 'staging', runId: 100 });
  assert.deepEqual(staging.criteria.map((item) => item.criterion), ['SC-01']);
  const pass = normalizeAcceptanceResult(staging, {
    criteria: [{
      criterion: 'SC-01',
      result: 'pass',
      evidence: [{ type: 'test', value: 'node scripts/acceptance-executor.mjs self-test' }],
      summary: 'fixture passed',
    }],
  }, 'deterministic');
  const passedBody = applyAcceptanceResultToBody(issue.body, pass);
  assert.match(passedBody, /- \[x\] SC-01 deterministic update works/);
  assert.match(passedBody, /\| SC-01 \| staging \| Pass \| run 100; ref abc123;/);
  assert.match(passedBody, /Keep this paragraph exactly\./);
  assert.equal(validateRequirementBody(passedBody, { mode: 'merge' }).ok, true);

  const post = buildAcceptanceContext({ ...issue, body: passedBody }, 'post-merge', {
    targetRef: 'def456', deployment: 'production', runId: 101,
  });
  const fail = normalizeAcceptanceResult(post, {
    criteria: [{
      criterion: 'SC-02',
      result: 'Fail',
      evidence: [{ type: 'smoke', value: 'production reconnect failed' }],
      summary: 'observable failure',
    }],
  }, 'agent-cursor');
  const failedBody = applyAcceptanceResultToBody(passedBody, fail);
  assert.match(failedBody, /- \[ \] SC-02 failing acceptance stays unchecked/);
  assert.match(failedBody, /\| SC-02 \| post-merge \| Fail \| run 101; ref def456;/);
  assert.equal(validateRequirementBody(failedBody, { mode: 'closure' }).ok, false);

  assert.throws(
    () => normalizeAcceptanceResult(staging, { criteria: [{ criterion: 'SC-99', result: 'Pass', evidence: 'ghost' }] }),
    /unknown or wrong-stage/
  );
  assert.throws(() => normalizeAcceptanceResult(staging, { criteria: [] }), /missing criteria: SC-01/);
  assert.throws(() => applyAcceptanceResultToBody(issue.body, { ...pass, criteria: [] }), /missing criteria: SC-01/);
  assert.throws(
    () => normalizeAcceptanceResult(staging, { criteria: [{ criterion: 'SC-01', result: 'Pass', evidence: 'implementation pending' }] }),
    /requires concrete evidence/
  );

  const newer = passedBody.replace('run 100; ref abc123;', 'run 200; ref newer;');
  assert.throws(() => applyAcceptanceResultToBody(newer, pass), /newer acceptance run 200/);
  const changed = passedBody.replace('deterministic update works', 'changed wording');
  assert.throws(() => applyAcceptanceResultToBody(changed, pass), /contract changed/);

  console.log('acceptance-executor self-test: 10 cases passed');
}

function usage() {
  return 'usage: acceptance-executor.mjs <self-test|prepare ISSUE STAGE TARGET_REF OUT [DEPLOYMENT]|normalize-result CONTEXT RAW OUT SOURCE|apply ISSUE RESULT>';
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'self-test') return selfTest();
  if (command === 'prepare') {
    if (args.length < 4) throw new Error(usage());
    return prepareCommand(Number(args[0]), args[1], args[2], args[3], args[4]);
  }
  if (command === 'normalize-result') {
    if (args.length < 4) throw new Error(usage());
    return normalizeCommand(args[0], args[1], args[2], args[3]);
  }
  if (command === 'apply') {
    if (args.length < 2) throw new Error(usage());
    return applyCommand(Number(args[0]), args[1]);
  }
  throw new Error(usage());
}

if (import.meta.url === 'file://' + process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  }
}
