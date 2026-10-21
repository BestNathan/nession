import { execFileSync } from 'node:child_process';
import { readVerificationTier, VERIFICATION_TIERS } from '../../../../../verification-tier-policy.mjs';
import { fetchGitHubIssue } from './read.mjs';

// Single-target, upgrade-only label tool. A model cannot remove an established
// higher verification obligation by editing Issue prose or ordinary labels.
export function createVerificationTierTool(issue, repository = process.env.GITHUB_REPOSITORY) {
  return {
    description: 'Assign a risk-based verification tier (scoped, integration or full) to the fixed Issue. Never downgrade an existing tier. The label does not grant AI Worker authorization or Full-E2E Pass.',
    inputSchema: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: VERIFICATION_TIERS },
        reason: { type: 'string', minLength: 20, maxLength: 2000 },
      },
      required: ['tier', 'reason'],
      additionalProperties: false,
    },
    async execute(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(k => !['tier', 'reason'].includes(k)) ||
          !VERIFICATION_TIERS.includes(input.tier) ||
          typeof input.reason !== 'string' || input.reason.trim().length < 20 ||
          input.reason.length > 2000) {
        throw new Error('invalid Issue verification-tier proposal');
      }
      const current = fetchGitHubIssue(issue.number, repository);
      if (String(current.state).toUpperCase() !== 'OPEN') throw new Error('target Issue is no longer open');
      const before = readVerificationTier(current);
      const oldRank = VERIFICATION_TIERS.indexOf(before.tier);
      const newRank = VERIFICATION_TIERS.indexOf(input.tier);
      if (before.explicit && newRank < oldRank)
        throw new Error('verification-tier downgrade requires separate trusted approval');
      if (before.tier === input.tier && before.explicit) return 'tier already assigned (no mutation)';
      const args = ['issue', 'edit', String(issue.number), '--repo', repository,
        '--add-label', input.tier];
      if (before.explicit && before.tier !== input.tier)
        args.push('--remove-label', before.tier);
      execFileSync('gh', args, { encoding:'utf8', env:process.env });
      const after = fetchGitHubIssue(issue.number, repository);
      if (readVerificationTier(after).tier !== input.tier)
        throw new Error('verification-tier update was not persisted');
      return 'assigned ' + input.tier + ' to Issue #' + issue.number +
        '; assessment: ' + input.reason.trim();
    },
  };
}
