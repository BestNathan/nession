import { renderAgentPrompt } from '../prompt/index.mjs';

const ACTIONS = {
  cursor: [
    'Use only permitted read-only repository tools and target-bound Issue tools.',
    'Call update_target_issue exactly once when the normalized title, body and contract labels are ready.',
    'The tools are bound to issue #{number}; a different issue cannot be modified.',
  ].join('\n'),
  deepseek: [
    'Use only permitted tools. You may edit/comment only issue #{number}.',
    'Use gh issue edit {number} to normalize its title/body and kind/area labels.',
    'Do not invoke gh against any other Issue.',
  ].join('\n'),
};

export function renderIssueAuditPrompt(issue, audit, provider, repository = process.env.GITHUB_REPOSITORY) {
  if (!(provider in ACTIONS)) throw new Error('Unsupported Issue Audit provider: ' + provider);
  if (!repository || !Number.isSafeInteger(issue.number) || issue.number <= 0) {
    throw new Error('Issue Audit requires a repository and a positive Issue number');
  }
  const labels = (issue.labels ?? []).map((item) => typeof item === 'string' ? item : item?.name).filter(Boolean);
  return renderAgentPrompt({
    id: 'issue-audit',
    version: 'v1',
    context: {
      issueUrl: String(issue.url ?? ''),
      repository,
      issueNumber: issue.number,
      labels: labels.join(', ') || '(none)',
      findings: (audit.errors ?? []).map((e) => '- ' + e).join('\n') || '(none)',
      issueBodyJson: JSON.stringify(issue.body ?? ''),
      actionInstructions: ACTIONS[provider].replaceAll('{number}', String(issue.number)),
    },
  });
}