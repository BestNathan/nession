import { renderAgentPrompt } from '../prompt/index.mjs';
import { createIssueReadTool } from '../tools/gh/issue/read.mjs';
import { createIssueUpdateTool } from '../tools/gh/issue/update.mjs';
import { createIssueCommentTool } from '../tools/gh/issue/comment.mjs';
import { createVerificationTierTool } from '../tools/gh/issue/verification-tier.mjs';
import { createTreeAuditTools } from '../issue-audit-tree.mjs';

export function renderIssueAuditPrompt(issue, audit, provider, repository = process.env.GITHUB_REPOSITORY, mode = 'single') {
  if(!['single','tree'].includes(mode)) throw Error('Unsupported Issue Audit mode');
  if(mode==='tree' && provider!=='cursor') throw Error('Tree Audit requires Cursor custom tools (no unsafe shell fallback)');
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
      mode,
      scopeInstructions: mode==='tree'
        ? 'This is one Issue Audit Agent session: review the root and explicitly parent-linked descendants by choosing which Issue to inspect next. Do not dispatch Actions or sub-Agents. You may update only the root using target-bound tools and descendant Issues using relation-checked tools. Never update a closed or unrelated Issue. Max 40 Issues/5 levels. Traverse P1/P2/P3 and every explicit descendant before reporting completion. Use find_related_issues, read_related_issue, review_related_issue, and tree_audit_progress, avoiding duplicate visits. A partial run must be explicitly reported as partial.'
        : 'Review only this fixed target Issue. Limit repository inspection to six focused read/search calls; by turn 8 stop investigating and repair if the contract needs it. Only this Issue may be mutated.',
      riskInstructions: mode==='tree'
        ? 'Classify each Issue individually as scoped, integration or full based on its own behavior and risk; parent full does NOT propagate to its children. Use verified related-Issue tools for children, which retain upgrade-only tier and SC/E2E evidence protections. Read before reviewing, and enumerate the entire explicit tree even for already classified Issues. At completion, comment a concise factual coverage summary on the root with reviewed/updated/unchanged/pending/skipped IDs; report any incomplete traversal honestly.'
        : 'Classify only this Issue using set_verification_tier. An established higher tier may not be downgraded automatically.',
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
  if (Object.keys(proposal).some((key) => !['title', 'body', 'labels', 'comment', 'verification_tier', 'tier_reason'].includes(key))) {
    throw new Error('Issue Audit proposal contains unauthorized fields');
  }
  const repair = ['title', 'body', 'labels'].some(key => proposal[key] != null);
  if (repair) {
    await createIssueUpdateTool(issue, repository).execute({
      title: proposal.title, body: proposal.body, labels: proposal.labels,
    });
  }
  if (proposal.verification_tier != null) {
    await createVerificationTierTool(issue, repository).execute({
      tier: proposal.verification_tier, reason: proposal.tier_reason,
    });
  }
  if (proposal.comment != null) {
    await createIssueCommentTool(issue, repository).execute({ body: proposal.comment });
  }
}


export function issueAuditTools(issue, repository = process.env.GITHUB_REPOSITORY, mode = 'single') {
  if(!['single','tree'].includes(mode)) throw Error('Unsupported Issue Audit mode');
  const tree=mode==='tree' ? createTreeAuditTools(issue,repository) : null;
  const {__progress,...relatedTools}=tree??{};
  const tools={
    read_target_issue: createIssueReadTool(issue, repository),
    update_target_issue: createIssueUpdateTool(issue, repository),
    comment_target_issue: createIssueCommentTool(issue, repository),
    set_verification_tier: createVerificationTierTool(issue, repository),
    ...relatedTools,
  };
  if(__progress)Object.defineProperty(tools,'getTreeAuditProgress',{value:__progress,enumerable:false});
  return tools;
}
