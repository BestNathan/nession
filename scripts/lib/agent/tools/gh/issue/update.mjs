import { execFileSync } from 'node:child_process';
import { auditIssue, KIND_LABELS, AREA_LABELS } from '../../../../../issue-contract.mjs';
import { parseIssueE2E } from '../../../../../issue-e2e-contract.mjs';
import { fetchGitHubIssue } from './read.mjs';

const CONTRACT_LABELS = new Set([...KIND_LABELS, ...AREA_LABELS]);

// Typed errors identify rejected, non-mutating Audit proposals. Error text
// alone must not grant a retry to an unrelated GitHub/tooling failure.
function rejectedAuditProposal(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// One contract for proposal completion and the final trusted mutation tool.
// Diagnostics expose only violation classes, never raw model output or labels.
export function validateContractLabels(labels) {
  if (!Array.isArray(labels)) {
    throw rejectedAuditProposal('ISSUE_AUDIT_LABEL_CONTRACT',
      'Issue labels must be distinct canonical kind/area labels (not_array)');
  }
  const violations = [];
  if (labels.some((label) => typeof label !== 'string')) violations.push('non_string');
  if (new Set(labels).size !== labels.length) violations.push('duplicate');
  if (labels.some((label) => typeof label === 'string' && !CONTRACT_LABELS.has(label))) {
    violations.push('noncanonical');
  }
  if (labels.filter((label) => KIND_LABELS.has(label)).length !== 1) violations.push('kind_count');
  if (!labels.some((label) => AREA_LABELS.has(label))) violations.push('missing_area');
  if (violations.length) {
    throw rejectedAuditProposal('ISSUE_AUDIT_LABEL_CONTRACT',
      'Issue labels must be distinct canonical kind/area labels (' + violations.join(', ') + ')');
  }
}

export function issueLabelNames(issue) {
  return (issue.labels ?? []).map((item) => typeof item === 'string' ? item : item?.name).filter(Boolean);
}

// A model may propose only the structural fields it needs to change, while
// the Issue mutation tool deliberately accepts a COMPLETE and validated
// snapshot. Fill omitted fields from the freshly-read fixed target here,
// never from prompt text or guessed model defaults. Noncontract labels remain
// owned/preserved by candidateIssue at the downstream tool boundary.
export function completeIssueUpdateProposal(current, proposal) {
  const labels = proposal.labels ?? issueLabelNames(current).filter(name => CONTRACT_LABELS.has(name));
  // Reject invalid explicit proposals rather than quietly stripping unsupported
  // labels or inventing labels for an Issue that has none.
  validateContractLabels(labels);
  return {
    title: proposal.title ?? current.title,
    body: proposal.body ?? current.body,
    labels,
  };
}

export function candidateIssue(issue, title, body, contractLabels) {
  const preserved = issueLabelNames(issue).filter((name) => !CONTRACT_LABELS.has(name));
  const labels = [...new Set([...preserved, ...contractLabels])];
  return { ...issue, title: title.trim(), body, labels: labels.map((name) => ({ name })) };
}

export function enforceE2EReadOnly(currentBody, candidateBody) {
  const before = parseIssueE2E(currentBody);
  const after = parseIssueE2E(candidateBody);
  if (!before && !after) return;

  const denied = () => {
    // A "none" declaration is not an actual selected test ID. Give the
    // correction model a fixed, bounded diagnosis without exposing raw Issue
    // or model-authored text; the same guard still rejects the whole proposal.
    const hasNonePlaceholder=before?.selectedIds?.length===0 &&
      before.newNone!==null && before.regressionNone!==null &&
      after?.rows?.has('none');
    const detail=hasNonePlaceholder
      ? ' (E2E Report none placeholders are not selected IDs; remove those data rows and retain the header and both - none: justifications)'
      : '';
    throw rejectedAuditProposal('ISSUE_AUDIT_E2E_PROTECTED',
      'Unauthorized E2E Verification / Report mutation by Issue Agent; submit an E2E proposal for trusted review'+detail);
  };
  // A structurally invalid source is an audit input, not proof of an
  // unauthorized write. The candidate, however, MUST be fully valid.
  // Do not let the Agent delete an invalid declaration to evade validation
  // or add an entirely new E2E plan to a legacy Issue that had none.
  if (!before || !after || after.errors.length) denied();

  if (before.errors.length === 0) {
    // Once the declaration is valid, all E2E selection and result changes
    // belong to the trusted proposal / evidence projector, not Issue Audit.
    if (before.digest !== after.digest ||
        JSON.stringify([...before.rows]) !== JSON.stringify([...after.rows])) denied();
    return;
  }

  // Allow repair of malformed declarations / Pending placeholders, but never
  // silently drop already parseable obligations or rewrite completed evidence.
  // Ill-formed IDs can be canonicalized (e.g. foo.spec.ts -> foo), whereas
  // valid existing IDs cannot be replaced to alter test scope.
  for (const id of before.newIds) if (!after.newIds.includes(id)) denied();
  for (const id of before.regressionIds) if (!after.regressionIds.includes(id)) denied();
  if (before.newNone !== null && before.newNone !== after.newNone) denied();
  if (before.regressionNone !== null && before.regressionNone !== after.regressionNone) denied();

  // Neither downgrade/delete an existing completed row nor mint a new
  // Pass/Fail/Error receipt. Canonical Pending evidence may become "-".
  for (const [id, row] of before.rows) {
    if (row.result !== 'Pending' &&
        JSON.stringify(row) !== JSON.stringify(after.rows.get(id))) denied();
  }
  for (const [id, row] of after.rows) {
    if (row.result !== 'Pending' &&
        JSON.stringify(row) !== JSON.stringify(before.rows.get(id))) denied();
  }
}

export function createIssueUpdateTool(issue, repository = process.env.GITHUB_REPOSITORY) {
  return {
    description: 'Normalize the fixed target Issue title, body and contract kind/area labels.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1 },
        body: { type: 'string', minLength: 1 },
        labels: { type: 'array', items: { type: 'string' }, minItems: 2, uniqueItems: true },
      },
      required: ['title', 'body', 'labels'],
      additionalProperties: false,
    },
    async execute(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some((key) => !['title', 'body', 'labels'].includes(key))) {
        throw new Error('Unauthorized Issue update tool arguments');
      }
      const { title, body, labels } = input;
      if (typeof title !== 'string' || !title.trim() || typeof body !== 'string' || !body.trim()) {
        throw new Error('Issue title and body must be non-empty strings');
      }
      validateContractLabels(labels);
      const current = fetchGitHubIssue(issue.number, repository);
      if (String(current.state).toUpperCase() !== 'OPEN') throw new Error('Target Issue is no longer open');
      enforceE2EReadOnly(current.body, body);
      const normalizedTitle = title.trim();
      const candidate = candidateIssue(current, normalizedTitle, body, labels);
      const before = auditIssue(candidate);
      if (!before.ok) throw rejectedAuditProposal('ISSUE_AUDIT_CONTRACT_REJECTED',
      'Issue Contract validation failed before write: ' + before.errors.join('; '));
      const currentContract = issueLabelNames(current).filter((name) => CONTRACT_LABELS.has(name));
      const add = labels.filter((name) => !currentContract.includes(name));
      const remove = currentContract.filter((name) => !labels.includes(name));
      const args = ['issue', 'edit', String(issue.number), '--repo', repository, '--title', normalizedTitle, '--body-file', '-'];
      if (add.length) args.push('--add-label', add.join(','));
      if (remove.length) args.push('--remove-label', remove.join(','));
      execFileSync('gh', args, { input: body, encoding: 'utf8', env: process.env });
      const after = fetchGitHubIssue(issue.number, repository);
      const verified = auditIssue(after);
      if (!verified.ok) throw new Error('Issue was written but post-write contract failed: ' + verified.errors.join('; '));
      return 'updated and revalidated issue #' + issue.number;
    },
  };
}