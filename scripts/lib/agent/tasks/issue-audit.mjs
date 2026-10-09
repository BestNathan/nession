import { renderAgentPrompt } from '../prompt/index.mjs';
import { createIssueUpdateTool } from '../tools/gh/issue/update.mjs';
import { createIssueCommentTool } from '../tools/gh/issue/comment.mjs';

const ACTIONS = {
  cursor: [
    'Use only permitted read-only repository tools and target-bound Issue tools.',
    'Call update_target_issue exactly once when the normalized title, body and contract labels are ready.',
    'The tools are bound to issue #{number}; a different issue cannot be modified.',
  ].join('\n'),
  deepseek: [
    'Do not call shell or GitHub mutation tools. Return a JSON repair proposal only.',
    'Output JSON with title, body, labels, and an optional investigation-trail comment.',
    'The trusted harness applies it only to issue #{number} after deterministic validation.',
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

export async function applyIssueAuditProposal(issue, envelope, repository = process.env.GITHUB_REPOSITORY) {
  const raw = envelope?.result;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Issue Audit model did not return a JSON repair proposal');
  }
  let proposal;
  try { proposal = JSON.parse(raw.trim()); }
  catch { throw new Error('Issue Audit repair proposal is not valid JSON'); }
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new Error('Issue Audit repair proposal must be an object');
  }
  if (Object.keys(proposal).some((key) => !['title', 'body', 'labels', 'comment'].includes(key))) {
    throw new Error('Issue Audit proposal contains unauthorized fields');
  }
  await createIssueUpdateTool(issue, repository).execute({
    title: proposal.title, body: proposal.body, labels: proposal.labels,
  });
  if (proposal.comment != null) {
    await createIssueCommentTool(issue, repository).execute({ body: proposal.comment });
  }
}
