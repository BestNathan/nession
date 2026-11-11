#!/usr/bin/env node

// Admission owns when an Issue edit warrants model-backed semantic review.
// Deterministic Issue Contract checks still run for every subscribed edit,
// including report-only updates; they are not contingent on this decision.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const PROJECTION_HEADINGS = new Set(['acceptance report', 'e2e report']);

// The trusted Acceptance/E2E projectors own verdict rows and SC checkbox
// progress; changing that projection alone must not re-run the Auditor.
// Leave Acceptance Plan, SC descriptions, E2E Verification and every other
// section intact: their edits may change the requested risk assessment.
export function semanticIssueBody(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const meaningful = [];
  let projection = false;
  for (const line of lines) {
    const heading = line.match(/^##[ \t]+(.+?)[ \t]*$/);
    if (heading) {
      projection = PROJECTION_HEADINGS.has(heading[1].trim().toLowerCase());
      if (projection) continue;
    }
    if (projection) continue;
    meaningful.push(
      line.replace(/^(\s*-\s+\[)[ xX](\]\s+SC-\d{2,}\b)/, '$1 $2'),
    );
  }
  return meaningful.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function issueAuditAdmission(eventName, event) {
  if (eventName === 'workflow_dispatch') return { semantic: true, reason: 'explicit-request' };
  if (eventName !== 'issues') return { semantic: false, reason: 'unrelated-event' };
  if (event?.action === 'opened') return { semantic: true, reason: 'new-issue' };
  if (event?.action !== 'edited') return { semantic: false, reason: 'metadata-or-lifecycle' };

  const changes = event.changes ?? {};
  if (Object.hasOwn(changes, 'title')) {
    // Unknown/partial original values fail closed into semantic review.
    if (!changes.title || !Object.hasOwn(changes.title, 'from') ||
        changes.title.from !== event.issue?.title) {
      return { semantic: true, reason: 'title-changed' };
    }
  }
  if (Object.hasOwn(changes, 'body')) {
    if (!changes.body || !Object.hasOwn(changes.body, 'from')) {
      return { semantic: true, reason: 'unknown-body-diff' };
    }
    if (semanticIssueBody(changes.body.from) !== semanticIssueBody(event.issue?.body)) {
      return { semantic: true, reason: 'specification-changed' };
    }
  }
  return { semantic: false, reason: 'projection-or-metadata-only' };
}

function selfTest() {
  const original = [
    '## Requirements: Audit routing',
    'Description of the desired behavior.',
    '### Success Criteria',
    '- [ ] SC-01 deterministic gate',
    '- [ ] SC-02 authenticated Agent path',
    '## Acceptance Plan',
    'acceptance: recorded',
    '## Acceptance Report',
    '| Criterion | Result | Evidence |',
    '| SC-01 | Pending | awaiting evidence |',
    '## E2E Report',
    '| ID | Result | Evidence |',
    '| E2E-1 | Pending | waiting |',
    '## Product alignment',
    '- [x] VISION.md',
  ].join('\n');
  const edited = (before, after, title = 'Requirement: audit routing') =>
    ({ action: 'edited', issue: { body: after, title }, changes: { body: { from: before } } });
  const statusUpdate = original.replace('SC-01 | Pending | awaiting evidence',
    'SC-01 | Pass | exact source run 42');
  const reportUpdate = statusUpdate.replace('E2E-1 | Pending | waiting', 'E2E-1 | Pass | run 42')
    .replace('- [ ] SC-01', '- [x] SC-01');
  assert.equal(issueAuditAdmission('issues', { action: 'opened' }).semantic, true);
  assert.equal(issueAuditAdmission('issues', { action: 'reopened' }).semantic, false);
  assert.equal(issueAuditAdmission('issues', { action: 'labeled', label: { name: 'status:blocked' } }).semantic, false);
  assert.equal(issueAuditAdmission('issues', { action: 'unlabeled', label: { name: 'verification:scoped' } }).semantic, false);
  assert.equal(issueAuditAdmission('issues', edited(original, statusUpdate)).semantic, false);
  assert.equal(issueAuditAdmission('issues', edited(original, reportUpdate)).semantic, false);
  assert.equal(issueAuditAdmission('issues', edited(original, original.replace('SC-01 deterministic gate', 'SC-01 other gate'))).semantic, true);
  assert.equal(issueAuditAdmission('issues', edited(original, original.replace('acceptance: recorded', 'acceptance: changed'))).semantic, true);
  assert.equal(issueAuditAdmission('issues', edited(original, original.replace('Description of the desired', 'New meaning of the desired'))).semantic, true);
  assert.equal(issueAuditAdmission('issues', { action: 'edited', issue: { title: 'Requirement: new title' },
    changes: { title: { from: 'Requirement: old title' } } }).semantic, true);
  assert.equal(issueAuditAdmission('issues', { action: 'edited', issue: { body: original },
    changes: { body: {} } }).semantic, true);
  assert.equal(issueAuditAdmission('issues', { action: 'edited', changes: { labels: { from: [] } } }).semantic, false);
  assert.equal(issueAuditAdmission('workflow_dispatch', {}).semantic, true);
  assert.equal(issueAuditAdmission('other', {}).semantic, false);
  console.log('issue-audit-admission self-test: substantive/metadata/projection/explicit/unknown fixtures passed');
}

function main() {
  if (process.argv[2] === 'self-test') return selfTest();
  if (process.argv[2] !== 'classify' || !process.argv[3] || !process.argv[4]) {
    throw new Error('usage: issue-audit-admission.mjs <self-test|classify EVENT_JSON GITHUB_OUTPUT>');
  }
  const event = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const selection = issueAuditAdmission(process.env.ISSUE_AUDIT_EVENT_NAME, event);
  fs.appendFileSync(process.argv[4],
    `semantic=${selection.semantic}\nreason=${selection.reason}\n`);
  console.log(`Issue Audit change admission: ${selection.reason}, semantic=${selection.semantic}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  }
}
