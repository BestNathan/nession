import { renderAgentPrompt } from '../prompt/index.mjs';
import { createIssueReadTool } from '../tools/gh/issue/read.mjs';
import { createIssueUpdateTool } from '../tools/gh/issue/update.mjs';
import { createIssueCommentTool } from '../tools/gh/issue/comment.mjs';

export function renderIssueAuditPrompt(issue, audit, provider, repository = process.env.GITHUB_REPOSITORY) {
  if (!['cursor', 'deepseek'].includes(provider)) throw new Error('Unsupported Issue Audit provider: ' + provider);
  if (!repository || !Number.isSafeInteger(issue.number) || issue.number <= 0) {
    throw new Error('Issue Audit requires a repository and a positive Issue number');
  }
  const labels = (issue.labels ?? []).map((item) => typeof item === 'string' ? item : item?.name).filter(Boolean);
  return renderAgentPrompt({
    id: 'issue-audit',
    version: 'v1',
    variant: provider,
    context: {
      issueUrl: String(issue.url ?? ''),
      repository,
      issueNumber: issue.number,
      labels: labels.join(', ') || '(none)',
      findings: (audit.errors ?? []).map((e) => '- ' + e).join('\n') || '(none)',
      issueBodyJson: JSON.stringify(issue.body ?? ''),
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


export function issueAuditTools(issue, repository = process.env.GITHUB_REPOSITORY) {
  return {
    read_target_issue: createIssueReadTool(issue, repository),
    update_target_issue: createIssueUpdateTool(issue, repository),
    comment_target_issue: createIssueCommentTool(issue, repository),
  };
}
