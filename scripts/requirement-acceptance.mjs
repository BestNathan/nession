#!/usr/bin/env node

import fs from 'node:fs';
import assert from 'node:assert/strict';

const ACCEPTED_RESULTS = new Set(['pass', 'n/a']);
const ALL_RESULTS = new Set(['pass', 'pending', 'fail', 'n/a']);
const PLACEHOLDER_EVIDENCE = new Set([
  '', '-', 'none', 'n/a', 'na', 'pending', 'tbd', 'todo', 'implementation pending',
]);

function extractSection(body, heading) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const wanted = heading.trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^##\s+(.+?)\s*$/);
    if (match && match[1].trim().toLowerCase() === wanted) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
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

function parseSuccessCriteria(section) {
  const errors = [];
  const criteria = new Map();
  if (section == null) {
    return { criteria, errors: ['missing `## Success Criteria` section'] };
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

function parseAcceptanceReport(section) {
  const errors = [];
  const rows = new Map();
  if (section == null) {
    return { rows, errors: ['missing `## Acceptance Report` section'] };
  }

  const tableLines = section.split('\n').map(splitMarkdownRow).filter(Boolean);
  let headerIndex = -1;
  for (let i = 0; i < tableLines.length; i += 1) {
    const cells = tableLines[i].map((cell) => cell.toLowerCase());
    if (cells[0] === 'criterion' && cells[1] === 'result' && cells[2] === 'evidence') {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) {
    errors.push('Acceptance Report must contain a `| Criterion | Result | Evidence |` table');
    return { rows, errors };
  }

  for (let i = headerIndex + 1; i < tableLines.length; i += 1) {
    const cells = tableLines[i];
    if (cells.length < 3) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const id = cells[0].trim().toUpperCase();
    if (!/^SC-\d{2,}$/.test(id)) continue;
    if (rows.has(id)) {
      errors.push(`duplicate Acceptance Report row for ${id}`);
      continue;
    }
    const result = cells[1].trim();
    const evidence = cells.slice(2).join(' | ').trim();
    rows.set(id, { id, result, evidence });
  }
  return { rows, errors };
}

export function validateRequirementBody(body) {
  const success = parseSuccessCriteria(extractSection(body, 'Success Criteria'));
  const report = parseAcceptanceReport(extractSection(body, 'Acceptance Report'));
  const errors = [...success.errors, ...report.errors];

  for (const criterion of success.criteria.values()) {
    const row = report.rows.get(criterion.id);
    if (!criterion.checked) {
      errors.push(`${criterion.id} is not checked`);
    }
    if (!row) {
      errors.push(`${criterion.id} has no Acceptance Report row`);
      continue;
    }
    const normalizedResult = row.result.trim().toLowerCase();
    if (!ALL_RESULTS.has(normalizedResult)) {
      errors.push(`${criterion.id} has unsupported result \`${row.result || '(empty)'}\``);
    } else if (!ACCEPTED_RESULTS.has(normalizedResult)) {
      errors.push(`${criterion.id} result is ${row.result}; expected Pass or N/A before closure`);
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
  };
}

function formatErrors(issueNumber, errors) {
  return [
    `Requirement #${issueNumber} acceptance is incomplete:`,
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

async function closingRequirementIssues({ owner, name, number, token }) {
  const query = `
    query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          id
          isDraft
          closingIssuesReferences(first: 100, after: $cursor) {
            nodes {
              number
              body
              stateReason
              labels(first: 100) { nodes { name } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const issues = [];
  let cursor = null;
  let prId = null;
  let isDraft = false;
  do {
    const data = await graphql(query, { owner, name, number, cursor }, token);
    const pr = data.repository?.pullRequest;
    const refs = pr?.closingIssuesReferences;
    if (!refs) throw new Error(`Unable to resolve closing issues for PR #${number}`);
    prId = pr.id;
    isDraft = pr.isDraft;
    for (const issue of refs.nodes) {
      const labels = new Set(issue.labels.nodes.map((label) => label.name));
      if (labels.has('requirement')) issues.push(issue);
    }
    cursor = refs.pageInfo.hasNextPage ? refs.pageInfo.endCursor : null;
  } while (cursor);
  return { issues, prId, isDraft };
}

async function convertPrToDraft(prId, token) {
  const mutation = `
    mutation($id: ID!) {
      convertPullRequestToDraft(input: { pullRequestId: $id }) {
        pullRequest { number isDraft }
      }
    }
  `;
  await graphql(mutation, { id: prId }, token);
}

async function runPrGate() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const [owner, name] = process.env.GITHUB_REPOSITORY.split('/');
  const number = event.pull_request?.number ?? event.number;
  if (!owner || !name || !number) throw new Error('pull_request event context is required');
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const { issues: requirements, prId, isDraft } = await closingRequirementIssues({ owner, name, number, token });
  const failures = [];
  for (const issue of requirements) {
    const result = validateRequirementBody(issue.body);
    if (!result.ok) failures.push(formatErrors(issue.number, result.errors));
    else console.log(`Requirement #${issue.number}: ${result.criteriaCount} criteria accepted.`);
  }
  if (failures.length) {
    if (prId && !isDraft) {
      await convertPrToDraft(prId, token);
      console.error(`PR #${number} was converted to draft because requirement acceptance is incomplete.`);
    }
    throw new Error(`Requirement acceptance gate failed:\n\n${failures.join('\n\n')}`);
  }
  console.log(`Requirement acceptance gate passed for PR #${number} (${requirements.length} requirement issue(s)).`);
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

  const result = validateRequirementBody(issue.body);
  if (result.ok) {
    console.log(`Requirement #${issue.number}: ${result.criteriaCount} criteria accepted; closure stands.`);
    return;
  }

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
      body: `<!-- requirement-acceptance-guard -->\n## Requirement acceptance guard\n\nThis requirement was reopened because completed requirements must pass every Success Criterion before closure.\n\n${diagnostic}\n\nUpdate the Acceptance Report with concrete evidence, check the accepted criteria, then close it again. Use **Close as not planned** only when the requirement is intentionally cancelled rather than completed.`,
    },
  });
  console.log(`Requirement #${issue.number} reopened because acceptance is incomplete.`);
}

function validBody() {
  return `## Success Criteria\n\n- [x] SC-01 works\n- [x] SC-02 behaves\n\n## Acceptance Report\n\n| Criterion | Result | Evidence |\n|---|---|---|\n| SC-01 | Pass | unit test: scripts/foo.test |\n| SC-02 | N/A | superseded by #88 after requirement amendment |`;
}

function runSelfTest() {
  const cases = [
    ['valid accepted requirement', validBody(), true, null],
    ['missing success criteria', '## Accceptance Report\n\n| Criterion | Result | Evidence |\n|---|---|---|', false, 'missing `"7V66W727&—FW&–uÒÀ¢²v7&—FW&–öâv—F†÷WB–BrÂr227V66W727&—FW&–Æà¢Ò·…Òv÷&·5ÆåÆâ2266WFæ6R&W÷'EÆåÆçÂ7&—FW&–öâÂ&W7VÇBÂWf–FVæ6RÅÆçÂÒÒ×ÂÒÒ×ÂÒÒ×ÂrÂfÇ6RÂvÖ—76–ær7F&ÆR42×‡‚–BuÒÀ¢²wVæ6†V6¶VB7&—FW&–öârÂfÆ–D&öG’‚’ç&WÆ6R‚rÒ·…Ò42ÓrÂrÒ²Ò42Ór’ÂfÇ6RÂu42Ó—2æ÷B6†V6¶VBuÒÀ¢²vÖ—76–ær&W÷'B&÷rrÂfÆ–D&öG’‚’ç&WÆ6R‚wÂ42Ó"ÂâôÂ7WW'6VFVB'’3ƒ‚gFW"&WV—&VÖVçBÖVæFÖVçBÂrÂrr’ÂfÇ6RÂu42Ó"†2æò66WFæ6R&W÷'B&÷ruÒÀ¢²wVæF–ær&W7VÇBrÂfÆ–D&öG’‚’ç&WÆ6R‚wÂ42ÓÂ72ÂVæ—BFW7C¢67&—G2öföòçFW7BÂrÂwÂ42ÓÂVæF–ærÂ7Fv–ærfW&–f–6F–öâÂr’ÂfÇ6RÂu42Ó&W7VÇB—2VæF–æruÒÀ¢²vf–Â&W7VÇBrÂfÆ–D&öG’‚’ç&WÆ6R‚wÂ42ÓÂ72ÂVæ—BFW7C¢67&—G2öföòçFW7BÂrÂwÂ42ÓÂf–ÂÂ'&÷w6W"&Vw&W76–öâÂr’ÂfÇ6RÂu42Ó&W7VÇB—2f–ÂuÒÀ¢²vÖ—76–ærWf–FVæ6RrÂfÆ–D&öG’‚’ç&WÆ6R‚wÂ42ÓÂ72ÂVæ—BFW7C¢67&—G2öföòçFW7BÂrÂwÂ42ÓÂ72ÂÒÂr’ÂfÇ6RÂu42Ó×W7B–æ6ÇVFR6öæ7&WFR66WFæ6RWf–FVæ6RuÒÀ¢²wVæ¶æ÷vâ&W÷'B7&—FW&–öârÂG·fÆ–D&öG’‚—ÕÆçÂ42Ó“’Â72Âv†÷7BÆÂfÇ6RÂwVæ¶æ÷vâ7&—FW&–öâ42Ó“’uÒÀ¢²vGWÆ–6FR7V66W72–BrÂfÆ–D&öG’‚’ç&WÆ6R‚rÒ·…Ò42Ó"&V†fW2rÂrÒ·…Ò42ÓGWÆ–6FRr’ÂfÇ6RÂvGWÆ–6FR7V66W727&—FW&–öâ–B42ÓuÒÀ¢²vGWÆ–6FR&W÷'B–BrÂfÆ–D&öG’‚’ç&WÆ6R‚wÂ42Ó"ÂâôÂ7WW'6VFVB'’3ƒ‚gFW"&WV—&VÖVçBÖVæFÖVçBÂrÂwÂ42ÓÂ72Â6V6öæBÂr’ÂfÇ6RÂvGWÆ–6FR66WFæ6R&W÷'B&÷rf÷"42ÓuÒÀ¢Ó° ¢f÷"†6öç7B¶æÖRÂ&öG’ÂW‡V7FVDö²ÂW‡V7FVDW'&÷%Òöb66W2’°¢6öç7B&W7VÇBÒfÆ–FFU&WV—&VÖVçD&öG’†&öG’“°¢76W'BæWVÂ‡&W7VÇBæö²ÂW‡V7FVDö²ÂG¶æÖWÓ¢W‡V7FVBö³ÒG¶W‡V7FVDö·ÒÂv÷BG´¥4ôâç7G&–æv–g’‡&W7VÇB—Ö“°¢–b†W‡V7FVDW'&÷"’°¢76W'Bæö²‡&W7VÇBæW'&÷'2ç6öÖR‚†W'&÷"’ÓâW'&÷"æ–æ6ÇVFW2†W‡V7FVDW'&÷"’’ÂG¶æÖWÓ¢Ö—76–ærG¶W‡V7FVDW'&÷'Ó²v÷BG·&W7VÇBæW'&÷'2æ¦ö–â‚s²r—Ö“°¢Ğ¢Ğ¢6öç6öÆRæÆör†&WV—&VÖVçBÖ66WFæ6R6VÆb×FW7C¢G¶66W2æÆVæwF‡Ò66W276VF“°§Ğ ¦7–æ2gVæ7F–öâÖ–â‚’°¢6öç7B6öÖÖæBÒ&ö6W72æ&we³%Ó°¢–b†6öÖÖæBÓÓÒw6VÆb×FW7Br’&WGW&â'Vå6VÆeFW7B‚“°¢–b†6öÖÖæBÓÓÒw"ÖvFRr’&WGW&â'Vå$vFR‚“°¢–b†6öÖÖæBÓÓÒv—77VRÖ6Æ÷6RÖwV&Br’&WGW&â'Vä—77VT6Æ÷6TwV&B‚“°¢F‡&÷ræWrW'&÷"‚wW6vS¢æöFR67&—G2÷&WV—&VÖVçBÖ66WFæ6RæÖ§2Ç6VÆb×FW7GÇ"ÖvFWÆ—77VRÖ6Æ÷6RÖwV&Câr“°§Ğ ¦–b†–×÷'BæÖWFçW&ÂÓÓÒf–ÆS¢òòG·&ö6W72æ&we³×Ö’°¢Ö–â‚’æ6F6‚‚†W'&÷"’Óâ°¢6öç6öÆRæW'&÷"†W'&÷"–ç7Fæ6VöbW'&÷"òW'&÷"æÖW76vR¢W'&÷"“°¢&ö6W72æW†—D6öFRÒ°¢Ò“°§Ğ 