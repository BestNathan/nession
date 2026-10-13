import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIssueUpdateTool, enforceE2EReadOnly } from './update.mjs';
import { createIssueReadTool } from './read.mjs';
import { createIssueCommentTool } from './comment.mjs';

const tmp = mkdtempSync(path.join(tmpdir(), 'nession-agent-gh-'));
const filename = path.join(tmp, 'issue.json');
const oldPath = process.env.PATH;
const oldFile = process.env.FAKE_GH_ISSUE_FILE;
const issue = {
  number: 17, state: 'OPEN', title: 'Requirement: old',
  labels: [{ name: 'requirement' }, { name: 'ci' }, { name: 'in-progress' }],
  body: '## Requirements: old\n\n### Success Criteria\n- [ ] SC-01 works\n\n## Acceptance Report\n| Criterion | Stage | Result | Evidence |\n|---|---|---|---|\n| SC-01 | pre-merge | Pending | implementation pending |\n\n## Product alignment\n- [x] aligned\n\n**Status:** Approved',
};
const fake = [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  'const args = process.argv.slice(2);',
  'const file = process.env.FAKE_GH_ISSUE_FILE;',
  "const issue = JSON.parse(fs.readFileSync(file, 'utf8'));",
  "if (args[0] !== 'issue' || args[2] !== String(issue.number)) process.exit(2);",
  "if (args[1] === 'view') { console.log(JSON.stringify(issue)); process.exit(0); }",
  "if (args[1] === 'edit') {",
  "  const field = (name) => args[args.indexOf(name) + 1];",
  "  issue.title = field('--title');",
  "  issue.body = fs.readFileSync(0, 'utf8');",
  "  const labels = new Set(issue.labels.map((x) => x.name));",
  "  if (args.includes('--add-label')) for (const label of field('--add-label').split(',')) labels.add(label);",
  "  if (args.includes('--remove-label')) for (const label of field('--remove-label').split(',')) labels.delete(label);",
  "  issue.labels = [...labels].map((name) => ({ name }));",
  "  fs.writeFileSync(file, JSON.stringify(issue));",
  "  process.exit(0);",
  '}',
  "if (args[1] === 'comment') { fs.writeFileSync(file + '.comment', fs.readFileSync(0, 'utf8')); process.exit(0); }",
  'process.exit(2);',
].join('\n');
try {
  writeFileSync(filename, JSON.stringify(issue));
  writeFileSync(path.join(tmp, 'gh'), fake);
  chmodSync(path.join(tmp, 'gh'), 0o755);
  process.env.PATH = tmp + path.delimiter + oldPath;
  process.env.FAKE_GH_ISSUE_FILE = filename;

  const read = createIssueReadTool(issue, 'example/repo');
  const update = createIssueUpdateTool(issue, 'example/repo');
  const comment = createIssueCommentTool(issue, 'example/repo');
  assert.equal(JSON.parse(await read.execute({})).number, 17);
  await assert.rejects(read.execute({ number: 18 }), /Unauthorized/);
  await assert.rejects(update.execute({ title: 'Requirement: fail', body: issue.body, labels: ['requirement', 'ci'], issue_number: 18 }), /Unauthorized/);
  await assert.rejects(update.execute({ title: 'unformatted', body: issue.body, labels: ['requirement', 'ci'] }), /Contract validation failed/);
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).title, 'Requirement: old');
  await update.execute({ title: 'Requirement: fixed', body: issue.body, labels: ['requirement', 'backend'] });
  const after = JSON.parse(readFileSync(filename, 'utf8'));
  assert.equal(after.title, 'Requirement: fixed');
  assert.deepEqual(after.labels.map((item) => item.name).sort(), ['backend', 'in-progress', 'requirement']);
  await assert.rejects(comment.execute({ body: 'ok', issue_number: 18 }), /Unauthorized/);
  await comment.execute({ body: 'investigation trail' });
  assert.equal(readFileSync(filename + '.comment', 'utf8'), 'investigation trail');
  const e2eContract = [
    '## E2E Verification', '### New', '- none: no new E2E tests',
    '### Regression', '- terminal-attach',
    '## E2E Report', '| ID | Type | Result | Evidence |',
    '|---|---|---|---|', '| terminal-attach | Regression | Pending | - |',
  ].join('\n');
  enforceE2EReadOnly(e2eContract,e2eContract);
  assert.throws(() => enforceE2EReadOnly(e2eContract,
    e2eContract.replace('| Pending | - |','| Pass | forged |')),/Unauthorized E2E/);
  assert.throws(() => enforceE2EReadOnly(e2eContract,
    e2eContract.replace('- terminal-attach','- terminal-replay')
      .replace('| terminal-attach | Regression','| terminal-replay | Regression')),/Unauthorized E2E/);
  assert.throws(() => enforceE2EReadOnly(issue.body,issue.body+'\n'+e2eContract),/Unauthorized E2E/);
  console.log('gh issue tools self-test: 14 assertions passed');
} finally {
  process.env.PATH = oldPath;
  if (oldFile == null) delete process.env.FAKE_GH_ISSUE_FILE;
  else process.env.FAKE_GH_ISSUE_FILE = oldFile;
  rmSync(tmp, { recursive: true, force: true });
}