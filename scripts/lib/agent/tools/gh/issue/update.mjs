import { execFileSync } from 'node:child_process';
import { auditIssue, KIND_LABELS, AREA_LABELS } from '../../../../../issue-contract.mjs';
import { fetchGitHubIssue } from './read.mjs';

const CONTRACT_LABELS = new Set([...KIND_LABELS, ...AREA_LABELS]);

export function issueLabelNames(issue) {
  return (issue.labels ?? []).map((item) => typeof item === 'string' ? item : item?.name).filter(Boolean);
}

export function candidateIssue(issue, title, body, contractLabels) {
  const preserved = issueLabelNames(issue).filter((name) => !CONTRACT_LABELS.has(name));
  const labels = [...new Set([...preserved, ...contractLabels])];
  return { ...issue, title: title.trim(), body, labels: labels.map((name) => ({ name })) };
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
    async execute({ title, body, labels }) {
      if (typeof title !== 'string' || !title.trim() || typeof body !== 'string' || !body.trim()) {
        throw new Error('Issue title and body must be non-empty strings');
      }
      if (!Array.isArray(labels) || new Set(labels).size !== labels.length ||
          labels.some((label) => typeof label !== 'string' || !CONTRACT_LABELS.has(label))) {
        throw new Error('Issue labels must be distinct canonical kind/area labels');
      }
      const current = fetchGitHubIssue(issue.number, repository);
      if (String(current.state).toUpperCase() !== 'OPEN') throw new Error('Target Issue is no longer open');
      const normalizedTitle = title.trim();
      const candidate = candidateIssue(current, normalizedTitle, body, labels);
      const before = auditIssue(candidate);
      if (!before.ok) throw new Error('Issue Contract validation failed before write: ' + before.errors.join('; '));
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