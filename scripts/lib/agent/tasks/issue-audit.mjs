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
        ? 'This is one Issue Audit Agent session using the existing runner (no Actions dispatch or sub-Agents). Complete the following tool-driven depth-first traversal, NOT merely a narrative report. (1) read_related_issue(root) and review_related_issue(root) once; the root is part of the observed/reviewed total. (2) find_related_issues(root); (3) repeatedly call tree_audit_progress and for EACH number in unexplored call find_related_issues(number), including leaf nodes. Newly discovered open children MUST be read_related_issue then review_related_issue once each. Continue until BOTH remaining and unexplored are empty; do not stop after P1/P2/P3. (4) Closed historic children are skipped and reported, NEVER assigned a tier; do not call review_related_issue on closed children. Explicit cross-area/cross-parent candidates rejected by the relation tool stay skipped. Owner-authored web-only Issues with a verified explicit Parent chain are legitimate cross-component descendants and MUST be reviewed even without a terminal label. (5) Publish the final root summary once, using publish_tree_audit, after observing these counters. Max 40 open nodes/5 levels. If budget is exhausted, publish truthful Partial/needs-review and the session MUST fail rather than silently claim Complete.'
        : 'Review only this fixed target Issue. Limit repository inspection to six focused read/search calls; By turn 8, stop investigating and repair if the contract needs it. Only this Issue may be mutated.',
      riskInstructions: mode==='tree'
        ? 'Classify ROOT and each OPEN descendant individually (verification:scoped, verification:integration or verification:full), using observable behavior/risks and real Issue SCs. Parent full NEVER propagates automatically. For every open Issue, even with an existing tier, use read_related_issue then review_related_issue with a concrete reason; the tool enforces upgrade-only changes and immutable SC/E2E evidence. Explicitly EXPAND EVERY visited open node with find_related_issues, even when you think it is a leaf. Closed historic P0 children must be skipped, not reviewed or treated as failures. Before publishing call tree_audit_progress; only say Complete if observed==reviewed, remaining==[], unexplored==[] and failed==[]. The summary must distinguish the parent and child levels. Do not use comment_target_issue as a substitute for publish_tree_audit.'
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
