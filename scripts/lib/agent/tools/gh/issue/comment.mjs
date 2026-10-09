import { execFileSync } from 'node:child_process';
import { fetchGitHubIssue } from './read.mjs';

export function createIssueCommentTool(issue, repository = process.env.GITHUB_REPOSITORY) {
  return {
    description: 'Add one concise audit/investigation comment to the fixed target Issue.',
    inputSchema: {
      type: 'object',
      properties: { body: { type: 'string', minLength: 1, maxLength: 8000 } },
      required: ['body'],
      additionalProperties: false,
    },
    async execute(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some((key) => key !== 'body')) throw new Error('Unauthorized Issue comment tool arguments');
      const { body } = input;
      if (typeof body !== 'string' || !body.trim() || body.length > 8000) {
        throw new Error('Comment must be non-empty and at most 8000 characters');
      }
      const current = fetchGitHubIssue(issue.number, repository);
      if (String(current.state).toUpperCase() !== 'OPEN') throw new Error('Target Issue is no longer open');
      execFileSync('gh', ['issue', 'comment', String(issue.number), '--repo', repository, '--body-file', '-'], {
        input: body, encoding: 'utf8', env: process.env,
      });
      return 'commented on issue #' + issue.number;
    },
  };
}