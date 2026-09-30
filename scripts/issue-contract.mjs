#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const KIND_LABELS = new Set(['bug', 'requirement']);
export const AREA_LABELS = new Set([
  'terminal', 'web', 'ui', 'ux', 'backend', 'server', 'agent', 'cli',
  'protocol', 'infra', 'ci', 'test', 'documentation',
]);

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean);
}

function normalizeBody(body) {
  return String(body ?? '').replace(/\r\n?/g, '\n');
}

function sections(body) {
  const map = new Map();
  const lines = normalizeBody(body).split('\n');
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^(#{2,6})\s+(.+?)\s*$/);
    if (heading) {
      current = heading[2].trim().toLowerCase();
      if (!map.has(current)) map.set(current, []);
      continue;
    }
    if (current) map.get(current).push(line);
  }
  return new Map([...map].map(([key, value]) => [key, value.join('\n').trim()]));
}

function findSection(sectionMap, names) {
  for (const name of names) {
    const key = name.toLowerCase();
    if (sectionMap.has(key)) return sectionMap.get(key);
  }
  return null;
}

function parseSuccessCriteria(body) {
  const sectionMap = sections(body);
  const section = findSection(sectionMap, ['success criteria']);
  const errors = [];
  const ids = [];
  if (section == null) return { ids, errors: ['missing Success Criteria section'] };

  const checkboxLines = section.split('\n').filter((line) => /^\s*-\s+\[[ xX]\]\s+/.test(line));
  for (const line of checkboxLines) {
    const match = line.match(/^\s*-\s+\[[ xX]\]\s+(SC-\d{2,})\b/i);
    if (!match) {
      errors.push(`criterion is missing stable SC-xx id: ${line.trim()}`);
      continue;
    }
    const id = match[1].toUpperCase();
    if (ids.includes(id)) errors.push(`duplicate Success Criterion id ${id}`);
    else ids.push(id);
  }
  if (ids.length === 0) errors.push('Success Criteria must contain at least one SC-xx checklist item');
  return { ids, errors };
}

function splitMarkdownRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const cells = [];
  let current = '';
  let escaped = false;
  for (let i = 1; i < trimmed.length - 1; i += 1) {
    const ch = trimmed[i];
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
      current += ch;
    } else if (ch === '|') {
      cells.push(current.trim().replace(/\\\|/g, '|'));
      current = '';
    } else current += ch;
  }
  cells.push(current.trim().replace(/\\\|/g, '|'));
  return cells;
}

function parseAcceptanceReport(body) {
  const sectionMap = sections(body);
  const section = findSection(sectionMap, ['acceptance report']);
  const errors = [];
  const rows = new Map();
  if (section == null) return { rows, errors: ['missing Acceptance Report section'] };
  const table = section.split('\n').map(splitMarkdownRow).filter(Boolean);
  const header = table.findIndex((cells) => cells.slice(0, 3).map((x) => x.toLowerCase()).join('|') === 'criterion|result|evidence');
  if (header < 0) return { rows, errors: ['Acceptance Report must contain Criterion / Result / Evidence table'] };
  for (const cells of table.slice(header + 1)) {
    if (cells.length < 3 || cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const id = cells[0].trim().toUpperCase();
    if (!/^SC-\d{2,}$/.test(id)) continue;
    if (rows.has(id)) errors.push(`duplicate Acceptance Report row for ${id}`);
    else rows.set(id, { result: cells[1].trim().toLowerCase(), evidence: cells.slice(2).join(' | ').trim() });
  }
  return { rows, errors };
}

function classify(issue, labels) {
  const kinds = labels.filter((label) => KIND_LABELS.has(label));
  if (kinds.length === 1) return kinds[0];
  const title = String(issue.title ?? '').trim();
  if (/^bug\s*:/i.test(title)) return 'bug';
  if (/^requirement\s*:/i.test(title)) return 'requirement';
  return null;
}

function validateKindAndArea(issue, errors) {
  const labels = labelsOf(issue);
  const kinds = labels.filter((label) => KIND_LABELS.has(label));
  const kind = classify(issue, labels);
  if (kinds.length !== 1) errors.push(`expected exactly one kind label (bug or requirement); found ${kinds.length ? kinds.join(', ') : 'none'}`);
  if (!kind) errors.push('cannot classify issue as Bug or Requirement from kind label/title');
  const areas = labels.filter((label) => AREA_LABELS.has(label));
  if (areas.length === 0) errors.push('missing area label');
  return { labels, kind, areas };
}

function validateBug(issue, errors) {
  if (!/^bug\s*:/i.test(String(issue.title ?? ''))) errors.push('Bug title must start with `Bug:`');
  const map = sections(issue.body);
  for (const heading of ['description', 'reproduction', 'impact', 'fix direction', 'location']) {
    const value = findSection(map, [heading]);
    const display = heading.replace(/\b\w/g, (c) => c.toUpperCase());
    if (value == null) errors.push(`missing ## ${display} section`);
    else if (!value.trim()) errors.push(`empty ## ${display} section`);
  }
  const root = findSection(map, ['root cause']);
  const investigation = findSection(map, ['investigation status']);
  if (root == null && investigation == null) errors.push('missing ## Root Cause or ## Investigation Status section');
  if (root != null && investigation != null) errors.push('Bug must use either Root Cause or Investigation Status, not both');
}

function validateRequirement(issue, errors) {
  if (!/^requirement\s*:/i.test(String(issue.title ?? ''))) errors.push('Requirement title must start with `Requirement:`');
  const map = sections(issue.body);
  const requirementHeading = [...map.keys()].some((heading) => heading.startsWith('requirements:'));
  if (!requirementHeading) errors.push('missing `## Requirements: ...` heading');

  const success = parseSuccessCriteria(issue.body);
  errors.push(...success.errors);
  const report = parseAcceptanceReport(issue.body);
  errors.push(...report.errors);

  for (const id of success.ids) if (!report.rows.has(id)) errors.push(`${id} has no Acceptance Report row`);
  for (const id of report.rows.keys()) if (!success.ids.includes(id)) errors.push(`Acceptance Report contains unknown criterion ${id}`);
  for (const [id, row] of report.rows) {
    if (!new Set(['pending', 'pass', 'fail', 'n/a']).has(row.result)) errors.push(`${id} has unsupported Acceptance result ${row.result || '(empty)'}`);
    if (!row.evidence) errors.push(`${id} has empty Acceptance evidence`);
  }

  if (!map.has('product alignment')) errors.push('missing ## Product alignment section');
  if (!/^\*\*Status:\*\*\s*(Draft|In Discussion|Approved)\b/im.test(normalizeBody(issue.body))) {
    errors.push('missing specification status: `**Status:** Draft | In Discussion | Approved`');
  }
}

export function auditIssue(issue) {
  const errors = [];
  const { kind, labels, areas } = validateKindAndArea(issue, errors);
  if (kind === 'bug') validateBug(issue, errors);
  else if (kind === 'requirement') validateRequirement(issue, errors);
  return { ok: errors.length === 0, kind, labels, areas, errors };
}

function fetchIssue(number, repo = process.env.GITHUB_REPOSITORY) {
  if (!repo) throw new Error('GITHUB_REPOSITORY is required');
  const text = execFileSync('gh', ['issue', 'view', String(number), '--repo', repo, '--json', 'number,title,body,labels,state,url,author'], {
    encoding: 'utf8', env: process.env,
  });
  return JSON.parse(text);
}

function validBug() {
  return {
    number: 1,
    title: 'Bug: terminal route is stale',
    labels: [{ name: 'bug' }, { name: 'web' }, { name: 'ux' }],
    body: `## Description\nObserved mismatch.\n\n## Reproduction\n1. Open route.\n\n## Investigation Status\nVerified mismatch; mechanism remains unverified.\n\n## Impact\nWrong session may render.\n\n## Fix Direction\nStabilize repro first.\n\n## Location\n- web/src/App.tsx:10`,
  };
}

function validRequirement() {
  return {
    number: 2,
    title: 'Requirement: audit issues',
    labels: [{ name: 'requirement' }, { name: 'ci' }],
    body: `## Requirements: audit issues\n\n### Success Criteria\n\n- [ ] SC-01 validates issues\n- [ ] SC-02 reports usage\n\n## Acceptance Report\n\n| Criterion | Result | Evidence |\n|---|---|---|\n| SC-01 | Pending | implementation pending |\n| SC-02 | Pending | implementation pending |\n\n## Product alignment\n\n- [x] aligned\n\n---\n**Status:** Approved`,
  };
}

function selfTest() {
  const bug = validBug();
  assert.equal(auditIssue(bug).ok, true);
  assert.ok(auditIssue({ ...bug, labels: [] }).errors.some((x) => x.includes('kind label')));
  assert.ok(auditIssue({ ...bug, body: bug.body.replace('## Location', '## Where') }).errors.some((x) => x.includes('Location')));
  assert.ok(auditIssue({ ...bug, body: `${bug.body}\n\n## Root Cause\nAlso present` }).errors.some((x) => x.includes('either Root Cause')));

  const requirement = validRequirement();
  assert.equal(auditIssue(requirement).ok, true);
  assert.ok(auditIssue({ ...requirement, body: requirement.body.replace('SC-02 reports usage', 'reports usage') }).errors.some((x) => x.includes('stable SC-xx')));
  assert.ok(auditIssue({ ...requirement, body: requirement.body.replace('| SC-02 | Pending | implementation pending |', '') }).errors.some((x) => x.includes('SC-02 has no Acceptance')));
  assert.ok(auditIssue({ ...requirement, labels: [{ name: 'requirement' }] }).errors.some((x) => x.includes('area label')));
  console.log('issue-contract self-test: 8 cases passed');
}

function writeResult(result, outputPath) {
  const payload = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) fs.writeFileSync(outputPath, payload);
  else process.stdout.write(payload);
}

function main() {
  const command = process.argv[2];
  if (command === 'self-test') return selfTest();
  if (command === 'github') {
    const issue = fetchIssue(process.argv[3]);
    const audit = auditIssue(issue);
    writeResult({ issue: { number: issue.number, title: issue.title, state: issue.state, url: issue.url }, ...audit }, process.argv[4]);
    process.exitCode = audit.ok ? 0 : 2;
    return;
  }
  if (command === 'json') {
    const issue = JSON.parse(fs.readFileSync(process.argv[3] ?? 0, 'utf8'));
    const audit = auditIssue(issue);
    writeResult(audit, process.argv[4]);
    process.exitCode = audit.ok ? 0 : 2;
    return;
  }
  throw new Error('usage: node scripts/issue-contract.mjs <self-test|github ISSUE [OUT]|json FILE [OUT]>');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  }
}
