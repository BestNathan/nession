#!/usr/bin/env node

import fs from 'node:fs';
import assert from 'node:assert/strict';

const ACCEPTED_RESULTS = new Set(['pass', 'n/a']);
const ALL_RESULTS = new Set(['pass', 'pending', 'fail', 'n/a']);
const ACCEPTANCE_STAGES = new Set(['pre-merge', 'staging', 'post-merge']);
const PLACEHOLDER_EVIDENCE = new Set([
  '', '-', 'none', 'n/a', 'na', 'pending', 'tbd', 'todo', 'implementation pending',
]);

export function extractSection(body, heading) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const wanted = heading.trim().toLowerCase();
  let start = -1;
  let level = null;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{2,6})\s+(.+?)\s*$/);
    if (match && match[2].trim().toLowerCase() === wanted) {
      start = i + 1;
      level = match[1].length;
      break;
    }
  }
  if (start < 0 || level == null) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{2,6})\s+/);
    if (match && match[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
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
    } else {
      current += ch;
    }
  }
  cells.push(current.trim().replace(/\\\|/g, '|'));
  return cells;
}

export function parseSuccessCriteria(section) {
  const errors = [];
  const criteria = new Map();
  if (section == null) {
    return { criteria, errors: ['missing Success Criteria section'] };
  }

  const checkboxLines = section.split('\n').filter((line) => /^\s*-\s+\[[ xX]\]\s+/.test(line));
  for (const line of checkboxLines) {
    const match = line.match(/^\s*-\s+\[([ xX])\]\s+(SC-\d{2,})\b\s*(.*)$/i);
    if (!match) {
      errors.push(`criterion is missing a stable SC-xx id: ${line.trim()}`);
      continue;
    }
    const id = match[2].toUpperCase();
    if (criteria.has(id)) {
      errors.push(`duplicate Success Criterion id ${id}`);
      continue;
    }
    criteria.set(id, {
      id,
      checked: match[1].toLowerCase() === 'x',
      text: match[3].trim(),
    });
  }

  if (criteria.size === 0) {
    errors.push('`## Success Criteria` must contain at least one `- [ ] SC-xx ...` criterion');
  }
  return { criteria, errors };
}

export function parseAcceptanceReport(section) {
  const errors = [];
  const rows = new Map();
  if (section == null) {
    return { rows, errors: ['missing Acceptance Report section'] };
  }

  const tableLines = section.split('\n').map(splitMarkdownRow).filter(Boolean);
  let headerIndex = -1;
  let staged = false;
  for (let i = 0; i < tableLines.length; i += 1) {
    const cells = tableLines[i].map((cell) => cell.toLowerCase());
    if (cells[0] === 'criterion' && cells[1] === 'stage' && cells[2] === 'result' && cells[3] === 'evidence') {
      headerIndex = i;
      staged = true;
      break;
    }
    if (cells[0] === 'criterion' && cells[1] === 'result' && cells[2] === 'evidence') {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) {
    errors.push('Acceptance Report must contain a `| Criterion | Stage | Result | Evidence |` table (legacy three-column reports remain supported)');
    return { rows, errors };
  }

  for (let i = headerIndex + 1; i < tableLines.length; i += 1) {
    const cells = tableLines[i];
    if (cells.length < (staged ? 4 : 3)) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const id = cells[0].trim().toUpperCase();
    if (!/^SC-\d{2,}$/.test(id)) continue;
    if (rows.has(id)) {
      errors.push(`duplicate Acceptance Report row for ${id}`);
      continue;
    }

    const stage = staged ? cells[1].trim().toLowerCase() : 'staging';
    const result = (staged ? cells[2] : cells[1]).trim();
    const evidence = cells.slice(staged ? 3 : 2).join(' | ').trim();
    rows.set(id, { id, stage, explicitStage: staged, result, evidence });
  }
  return { rows, errors };
}

export function validateRequirementBody(body, { mode = 'closure' } = {}) {
  if (!new Set(['pre-merge', 'merge', 'closure']).has(mode)) {
    throw new Error(`unsupported acceptance validation mode: ${mode}`);
  }

  const success = parseSuccessCriteria(extractSection(body, 'Success Criteria'));
  const report = parseAcceptanceReport(extractSection(body, 'Acceptance Report'));
  const errors = [...success.errors, ...report.errors];
  let deferredPostMergeCount = 0;

  for (const criterion of success.criteria.values()) {
    const row = report.rows.get(criterion.id);
    if (!row) {
      errors.push(`${criterion.id} has no Acceptance Report row`);
      continue;
    }

    if (!ACCEPTANCE_STAGES.has(row.stage)) {
      errors.push(`${criterion.id} has unsupported acceptance stage \`${row.stage || '(empty)'}\``);
    }

    const normalizedResult = row.result.trim().toLowerCase();
    if (!ALL_RESULTS.has(normalizedResult)) {
      errors.push(`${criterion.id} has unsupported result \`${row.result || '(empty)'}\``);
      continue;
    }

    if (mode === 'pre-merge' && row.stage !== 'pre-merge') {
      continue;
    }

    const deferredPostMerge =
      mode === 'merge'
      && row.stage === 'post-merge'
      && normalizedResult === 'pending';

    if (deferredPostMerge) {
      deferredPostMergeCount += 1;
      if (criterion.checked) {
        errors.push(`${criterion.id} is checked but post-merge acceptance is still Pending`);
      }
      if (PLACEHOLDER_EVIDENCE.has(row.evidence.trim().toLowerCase())) {
        errors.push(`${criterion.id} post-merge Pending must describe the blocking merge/deployment/observation condition and planned verification`);
      }
      continue;
    }

    if (!criterion.checked) {
      errors.push(`${criterion.id} is not checked`);
    }
    if (!ACCEPTED_RESULTS.has(normalizedResult)) {
      const expectation = mode === 'merge'
        ? 'expected Pass or N/A before merge unless this is an explicit post-merge Pending criterion'
        : mode === 'pre-merge'
          ? 'expected Pass or N/A before the pre-merge gate'
          : 'expected Pass or N/A before closure';
      errors.push(`${criterion.id} result is ${row.result}; ${expectation}`);
    }
    if (PLACEHOLDER_EVIDENCE.has(row.evidence.trim().toLowerCase())) {
      errors.push(`${criterion.id} must include concrete acceptance evidence`);
    }
  }

  for (const row of report.rows.values()) {
    if (!success.criteria.has(row.id)) {
      errors.push(`Acceptance Report contains unknown criterion ${row.id}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    criteriaCount: success.criteria.size,
    deferredPostMergeCount,
  };
}

function formatErrors(issueNumber, errors, context = 'acceptance') {
  const label =
    context === 'merge'
      ? 'is not merge-ready'
      : context === 'pre-merge'
        ? 'has incomplete pre-merge acceptance'
        : 'acceptance is incomplete';
  return [
    `Requirement #${issueNumber} ${label}:`,
    ...errors.map((error) => `- ${error}`),
  ].join('\n');
}

async function githubRequest(path, { token, method = 'GET', body } = {}) {
  if (!token) throw new Error('GITHUB_TOKEN/GH_TOKEN is required');
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nession-requirement-acceptance',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${text}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function graphql(query, variables, token) {
  const payload = await githubRequest('/graphql', { token, method: 'POST', body: { query, variables } });
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL failed: ${payload.errors.map((e) => e.message).join('; ')}`);
  }
  return payload.data;
}

function parseClosingIssueNumbers(body, owner, name) {
  const text = String(body ?? '').replace(/<!--[^]*?-->/g, '');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const numbers = new Set();
  let fence = null;
  const escapedOwner = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reference = `(?:#(\\d+)|${escapedOwner}\\/${escapedName}#(\\d+)|https:\\/\\/github\\.com\\/${escapedOwner}\\/${escapedName}\\/issues\\/(\\d+))`;
  const closing = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+${reference}\\b`, 'gi');

  for (const rawLine of lines) {
    const fenceMatch = rawLine.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === marker) fence = null;
      else if (fence == null) fence = marker;
      continue;
    }
    if (fence || /^\s*>/.test(rawLine)) continue;
    const line = rawLine.replace(/`[^`]*`/g, '');
    for (const match of line.matchAll(closing)) {
      const value = match[1] ?? match[2] ?? match[3];
      if (value) numbers.add(Number(value));
    }
  }
  return [...numbers];
}

function issueReferencePattern(owner, name) {
  const escapedOwner = owner.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const escapedName = name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  return '(?:#(\\d+)|' + escapedOwner + '\\/' + escapedName + '#(\\d+)|https:\\/\\/github\\.com\\/' + escapedOwner + '\\/' + escapedName + '\\/issues\\/(\\d+))';
}

function collectIssueReferences(text, owner, name) {
  const numbers = new Set();
  const reference = new RegExp(issueReferencePattern(owner, name), 'gi');
  for (const match of String(text ?? '').matchAll(reference)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) numbers.add(Number(value));
  }
  return numbers;
}

function parseAssociatedIssueNumbers(body, owner, name) {
  const text = String(body ?? '').replace(/<!--[^]*?-->/g, '');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const numbers = new Set();
  let fence = null;

  // Explicit implementation/association language seen in historical PRs.
  // Dependency-only language (Depends on / Blocked by) is intentionally excluded:
  // a dependency is not evidence that this PR implements that requirement.
  const actionAssociation = /\b(?:implement(?:s|ed|ing)?|address(?:es|ed|ing)?)\b/i;
  const leadingAssociation = /^\s*(?:[-*+]\s+)?(?:\x60+\s*)?(?:refs?|references?|related\s+to|relates\s+to|part\s+of|follow[- ]up\s+(?:to|from)|issues?)\b\s*:?[^\S\r\n]*/i;

  for (const rawLine of lines) {
    const fenceMatch = rawLine.match(/^\s*(\x60{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === marker) fence = null;
      else if (fence == null) fence = marker;
      continue;
    }
    if (fence || /^\s*>/.test(rawLine)) continue;

    const leading = rawLine.match(leadingAssociation);
    const action = rawLine.match(actionAssociation);
    const associationStart = leading
      ? (leading.index ?? 0) + leading[0].length
      : action
        ? (action.index ?? 0) + action[0].length
        : -1;
    if (associationStart < 0) continue;

    for (const number of collectIssueReferences(rawLine.slice(associationStart), owner, name)) {
      numbers.add(number);
    }
  }
  return [...numbers];
}

function parseTitleIssueNumbers(title, owner, name) {
  const numbers = new Set();
  const text = String(title ?? '');

  // Historical PR titles commonly carry their issue as "(#123)" or
  // "(#123 SC-04)"; treat those as explicit implementation associations.
  for (const match of text.matchAll(/\(([^)]*#\d+[^)]*)\)/g)) {
    for (const number of collectIssueReferences(match[1], owner, name)) numbers.add(number);
  }

  // Also honor explicit action/association language in a title, e.g. "close #1455".
  for (const number of parseClosingIssueNumbers(text, owner, name)) numbers.add(number);
  for (const number of parseAssociatedIssueNumbers(text, owner, name)) numbers.add(number);

  return [...numbers];
}

function parsePreMergeIssueNumbers(body, owner, name, title = '') {
  const numbers = new Set(parseClosingIssueNumbers(body, owner, name));
  for (const number of parseAssociatedIssueNumbers(body, owner, name)) numbers.add(number);
  for (const number of parseTitleIssueNumbers(title, owner, name)) numbers.add(number);
  return [...numbers].sort((a, b) => a - b);
}

async function closingRequirementIssues({ owner, name, body, token }) {
  const issues = [];
  const numbers = parseClosingIssueNumbers(body, owner, name);
  for (const number of numbers) {
    const issue = await githubRequest(`/repos/${owner}/${name}/issues/${number}`, { token });
    const labels = new Set((issue.labels ?? []).map((label) => typeof label === 'string' ? label : label.name));
    if (labels.has('requirement')) issues.push(issue);
  }
  return issues;
}
async function preMergeRequirementIssues({ owner, name, title = '', body, token }) {
  const issues = [];
  const numbers = parsePreMergeIssueNumbers(body, owner, name, title);
  for (const number of numbers) {
    const issue = await githubRequest(`/repos/${owner}/${name}/issues/${number}`, { token });
    const labels = new Set((issue.labels ?? []).map((label) => typeof label === 'string' ? label : label.name));
    if (labels.has('requirement') && String(issue.state).toLowerCase() === 'open') issues.push(issue);
  }
  return issues;
}

async function closePullRequest(owner, name, number, token) {
  await githubRequest(`/repos/${owner}/${name}/pulls/${number}`, {
    token,
    method: 'PATCH',
    body: { state: 'closed' },
  });
}

async function discoverPreMergeRequirements() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const [owner, name] = process.env.GITHUB_REPOSITORY.split('/');
  const pr = event.pull_request;
  if (!owner || !name || !pr) throw new Error('pull_request event context is required');
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const requirements = await preMergeRequirementIssues({ owner, name, title: pr.title, body: pr.body, token });
  process.stdout.write(JSON.stringify(requirements.map((issue) => String(issue.number)).sort((a, b) => Number(a) - Number(b))) + '\n');
}

async function runPrGate({ mode = 'merge', discovery = 'closing' } = {}) {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const [owner, name] = process.env.GITHUB_REPOSITORY.split('/');
  const pr = event.pull_request;
  const number = pr?.number ?? event.number;
  if (!owner || !name || !number || !pr) throw new Error('pull_request event context is required');
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const requirements = discovery === 'pre-merge'
    ? await preMergeRequirementIssues({ owner, name, title: pr.title, body: pr.body, token })
    : await closingRequirementIssues({ owner, name, body: pr.body, token });
  const failures = [];
  for (const issue of requirements) {
    const result = validateRequirementBody(issue.body, { mode });
    if (!result.ok) failures.push(formatErrors(issue.number, result.errors, mode));
    else if (mode === 'merge' && result.deferredPostMergeCount > 0) {
      console.log(`Requirement #${issue.number}: merge-ready with ${result.deferredPostMergeCount} deferred post-merge criterion/criteria.`);
    } else {
      console.log(
        mode === 'pre-merge'
          ? `Requirement #${issue.number}: pre-merge criteria accepted.`
          : `Requirement #${issue.number}: ${result.criteriaCount} criteria accepted before merge.`,
      );
    }
  }
  if (failures.length) {
    if (pr.state !== 'closed') {
      await closePullRequest(owner, name, number, token);
      console.error(
        mode === 'pre-merge'
          ? `PR #${number} was closed because pre-merge requirement acceptance is incomplete. Fix acceptance, then reopen the PR.`
          : `PR #${number} was closed because requirement acceptance is incomplete. Fix acceptance, then reopen the PR.`,
      );
    }
    throw new Error(
      mode === 'pre-merge'
        ? `Pre-merge requirement acceptance gate failed:\n\n${failures.join('\n\n')}`
        : `Requirement acceptance gate failed:\n\n${failures.join('\n\n')}`,
    );
  }
  console.log(
    mode === 'pre-merge'
      ? `Pre-merge requirement acceptance gate passed for PR #${number} (${requirements.length} requirement issue(s)).`
      : `Requirement acceptance gate passed for PR #${number} (${requirements.length} requirement issue(s)).`,
  );
}
async function runIssueCloseGuard() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const issue = event.issue;
  if (!issue) throw new Error('issues event context is required');
  const labels = new Set((issue.labels ?? []).map((label) => typeof label === 'string' ? label : label.name));
  if (!labels.has('requirement')) {
    console.log(`Issue #${issue.number} is not a requirement; nothing to guard.`);
    return;
  }
  if (issue.state_reason === 'not_planned') {
    console.log(`Requirement #${issue.number} closed as not_planned; acceptance is not required.`);
    return;
  }

  const result = validateRequirementBody(issue.body, { mode: 'closure' });
  if (result.ok) {
    console.log(`Requirement #${issue.number}: ${result.criteriaCount} criteria accepted; closure stands.`);
    return;
  }

  const mergeReadiness = validateRequirementBody(issue.body, { mode: 'merge' });
  const deferredOnly =
    mergeReadiness.ok
    && mergeReadiness.deferredPostMergeCount > 0;

  const [owner, name] = process.env.GITHUB_REPOSITORY.split('/');
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const diagnostic = formatErrors(issue.number, result.errors);
  await githubRequest(`/repos/${owner}/${name}/issues/${issue.number}`, {
    token,
    method: 'PATCH',
    body: { state: 'open' },
  });
  await githubRequest(`/repos/${owner}/${name}/issues/${issue.number}/comments`, {
    token,
    method: 'POST',
    body: {
      body: deferredOnly
        ? `<!-- requirement-acceptance-guard -->\n## Post-merge acceptance pending\n\nThis requirement was reopened intentionally: the release was merge-ready, but ${mergeReadiness.deferredPostMergeCount} Success Criterion/Criteria are explicitly staged as **post-merge** and still Pending. Merge/release is not considered a failed acceptance; the requirement remains open until those criteria can run and are accepted.\n\n${diagnostic}\n\nRun the post-merge verification described in each pending row, record concrete evidence, check the accepted criteria, then close the requirement.`
        : `<!-- requirement-acceptance-guard -->\n## Requirement acceptance guard\n\nThis requirement was reopened because completed requirements must pass every Success Criterion before closure.\n\n${diagnostic}\n\nUpdate the Acceptance Report with concrete evidence, check the accepted criteria, then close it again. Use **Close as not planned** only when the requirement is intentionally cancelled rather than completed.`,
    },
  });
  console.log(
    deferredOnly
      ? `Requirement #${issue.number} reopened for deferred post-merge acceptance.`
      : `Requirement #${issue.number} reopened because acceptance is incomplete.`,
  );
}

function validBody() {
  return `### Success Criteria\n\n- [x] SC-01 works\n- [x] SC-02 behaves\n\n## Acceptance Report\n\n| Criterion | Stage | Result | Evidence |\n|---|---|---|---|\n| SC-01 | pre-merge | Pass | unit test: scripts/foo.test |\n| SC-02 | staging | N/A | superseded by #88 after requirement amendment |`;
}

function validLegacyBody() {
  return `### Success Criteria\n\n- [x] SC-01 works\n\n## Acceptance Report\n\n| Criterion | Result | Evidence |\n|---|---|---|\n| SC-01 | Pass | legacy accepted evidence |`;
}

function postMergePendingBody(evidence = 'requires production deployment; verify release smoke test after deploy') {
  return `### Success Criteria\n\n- [x] SC-01 works before merge\n- [ ] SC-02 works after merge\n\n## Acceptance Report\n\n| Criterion | Stage | Result | Evidence |\n|---|---|---|---|\n| SC-01 | staging | Pass | staging smoke test passed |\n| SC-02 | post-merge | Pending | ${evidence} |`;
}

function runSelfTest() {
  const cases = [
    ['valid accepted requirement', validBody(), 'closure', true, null],
    ['pre-merge ignores later-stage pending criteria', validBody()
      .replace('- [x] SC-02 behaves', '- [ ] SC-02 behaves')
      .replace('| SC-02 | staging | N/A | superseded by #88 after requirement amendment |', '| SC-02 | staging | Pending | verify after staging deployment |'), 'pre-merge', true, null],
    ['pre-merge still requires pre-merge criteria', validBody()
      .replace('- [x] SC-01 works', '- [ ] SC-01 works')
      .replace('| SC-01 | pre-merge | Pass | unit test: scripts/foo.test |', '| SC-01 | pre-merge | Pending | implementation not yet verified |'), 'pre-merge', false, 'SC-01 is not checked'],
    ['h2 success criteria remains supported', validBody().replace('### Success Criteria', '## Success Criteria'), 'closure', true, null],
    ['legacy three-column report remains supported', validLegacyBody(), 'closure', true, null],
    ['missing success criteria', '## Acceptance Report\n\n| Criterion | Stage | Result | Evidence |\n|---|---|---|---|', 'closure', false, 'missing Success Criteria section'],
    ['criterion without id', '## Success Criteria\n\n- [x] works\n\n## Acceptance Report\n\n| Criterion | Stage | Result | Evidence |\n|---|---|---|---|', 'closure', false, 'missing a stable SC-xx id'],
    ['unchecked criterion', validBody().replace('- [x] SC-01', '- [ ] SC-01'), 'closure', false, 'SC-01 is not checked'],
    ['missing report row', validBody().replace('| SC-02 | staging | N/A | superseded by #88 after requirement amendment |', ''), 'closure', false, 'SC-02 has no Acceptance Report row'],
    ['staging pending blocks merge', validBody().replace('| SC-01 | pre-merge | Pass | unit test: scripts/foo.test |', '| SC-01 | staging | Pending | staging verification |'), 'merge', false, 'SC-01 result is Pending'],
    ['post-merge pending is merge-ready', postMergePendingBody(), 'merge', true, null],
    ['post-merge pending blocks closure', postMergePendingBody(), 'closure', false, 'SC-02 is not checked'],
    ['post-merge pending needs actionable evidence', postMergePendingBody('implementation pending'), 'merge', false, 'post-merge Pending must describe'],
    ['post-merge fail blocks merge', postMergePendingBody().replace('| SC-02 | post-merge | Pending |', '| SC-02 | post-merge | Fail |'), 'merge', false, 'SC-02 result is Fail'],
    ['checked post-merge pending is invalid', postMergePendingBody().replace('- [ ] SC-02', '- [x] SC-02'), 'merge', false, 'checked but post-merge acceptance is still Pending'],
    ['invalid stage fails', validBody().replace('| SC-01 | pre-merge | Pass |', '| SC-01 | production | Pass |'), 'closure', false, 'unsupported acceptance stage'],
    ['missing evidence', validBody().replace('| SC-01 | pre-merge | Pass | unit test: scripts/foo.test |', '| SC-01 | pre-merge | Pass | - |'), 'closure', false, 'SC-01 must include concrete acceptance evidence'],
    ['unknown report criterion', `${validBody()}\n| SC-99 | staging | Pass | ghost |`, 'closure', false, 'unknown criterion SC-99'],
    ['duplicate success id', validBody().replace('- [x] SC-02 behaves', '- [x] SC-01 duplicate'), 'closure', false, 'duplicate Success Criterion id SC-01'],
    ['duplicate report id', validBody().replace('| SC-02 | staging | N/A | superseded by #88 after requirement amendment |', '| SC-01 | staging | Pass | second |'), 'closure', false, 'duplicate Acceptance Report row for SC-01'],
  ];

  for (const [name, body, mode, expectedOk, expectedError] of cases) {
    const result = validateRequirementBody(body, { mode });
    assert.equal(result.ok, expectedOk, `${name}: expected ok=${expectedOk}, got ${JSON.stringify(result)}`);
    if (expectedError) {
      assert.ok(result.errors.some((error) => error.includes(expectedError)), `${name}: missing ${expectedError}; got ${result.errors.join('; ')}`);
    }
  }

  assert.deepEqual(
    parseClosingIssueNumbers('Closes #12\nFixes BestNathan/nession#13\nResolves https://github.com/BestNathan/nession/issues/14', 'BestNathan', 'nession'),
    [12, 13, 14],
  );
  assert.deepEqual(
    parsePreMergeIssueNumbers(
      [
        'Implements #30',
        'Closes #31',
        'Refs #32, #33',
        'Refs: #34',
        'References BestNathan/nession#35',
        'Related to #36',
        'Relates to #37',
        'Addresses the remaining acceptance gap in #38',
        'Follow-up to the review on #39',
        'Part of #40',
        'Issue #41 — implementation slice',
        'Implements the first architecture slice of #42 / #43',
        '\x60Refs #44\x60。',
      ].join('\n'),
      'BestNathan',
      'nession',
      'fix(test): historical title linkage (#45 SC-04)',
    ),
    [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45],
  );
  assert.deepEqual(
    parsePreMergeIssueNumbers(
      'Depends on #50\nBlocked by #51\nMentions #52\n> Refs #53\n\x60\x60\x60md\nRefs #54\n\x60\x60\x60',
      'BestNathan',
      'nession',
    ),
    [],
  );
  assert.deepEqual(
    parseClosingIssueNumbers('`Closes #20`\n> Closes #21\n```md\nCloses #22\n```\n<!-- Closes #23 -->\nCloses #24', 'BestNathan', 'nession'),
    [24],
  );

  console.log(`requirement-acceptance self-test: ${cases.length + 3} cases passed`);
}

async function main() {
  const command = process.argv[2];
  if (command === 'self-test') return runSelfTest();
  if (command === 'discover-pre-merge') return discoverPreMergeRequirements();
  if (command === 'pre-merge-pr-gate') return runPrGate({ mode: 'pre-merge', discovery: 'pre-merge' });
  if (command === 'pr-gate') return runPrGate();
  if (command === 'issue-close-guard') return runIssueCloseGuard();
  throw new Error('usage: node scripts/requirement-acceptance.mjs <self-test|discover-pre-merge|pre-merge-pr-gate|pr-gate|issue-close-guard>');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
