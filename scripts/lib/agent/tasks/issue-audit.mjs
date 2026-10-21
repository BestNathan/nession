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
        ? [
            'Run ONE existing Issue Audit Agent session with the same tools; no recursive Actions, no new Agent, no background dispatch.',
            'Algorithm (mandatory, do not stop after reviewing the first layer):',
            '1. Immediately call read_related_issue(root_number) and review_related_issue(root_number, tier, reason) for the root itself. Root must count as reviewed.',
            '2. Call find_related_issues(parent_number) for the root. For EVERY returned open child: read_related_issue then review_related_issue, then find_related_issues on that child even if its tier was already correct.',
            '3. Continue breadth/depth traversal yourself via these tools until tree_audit_progress reports BOTH remaining=[] and unexplored=[]. An already-reviewed node can still have unexplored children.',
            '4. Never try to edit a closed Issue; closed/foreign references are skipped with explicit reasons by trusted tools. Do not let a closed child block reviews of open descendants.',
            '5. Only then call publish_tree_audit with a truthful final summary. If you cannot exhaust the tree within 40 Issues or the available session budget, publish Partial / needs review, listing exactly what remains; do NOT write that the audit is complete.',
            'Use only relation-checked Issue tools for children, and the original target-bound tools for the root. Do not rewrite SC/E2E/Acceptance evidence.'
          ].join('\\n')
        : 'Review only this fixed target Issue. Limit repository inspection to six focused read/search calls; By turn 8, stop investigating and repair if the contract needs it. Only this Issue may be mutated.',
      riskInstructions: mode==='tree'
        ? 'Classify each Issue individually as scoped, integration or full based on its own behavior and risk; parent full does NOT propagate to its children. Use verified related-Issue tools for children, which retain upgrade-only tier and SC/E2E evidence protections. Read before reviewing, and enumerate the entire explicit tree even for already classified Issues. At completion call publish_tree_audit exactly once, giving a concise factual coverage summary. The tool writes the root Issue report with verified reviewed/updated/unchanged/pending IDs. If your work is partial, publish a Partial report, not a fictitious completion.'
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
