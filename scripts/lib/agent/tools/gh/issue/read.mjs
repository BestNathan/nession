import { execFileSync } from 'node:child_process';

export function fetchGitHubIssue(number, repository = process.env.GITHUB_REPOSITORY) {
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  if (!Number.isSafeInteger(Number(number)) || Number(number) <= 0) {
    throw new Error('A positive Issue number is required');
  }
  return JSON.parse(execFileSync('gh', [
    'issue', 'view', String(number), '--repo', repository,
    '--json', 'number,title,body,labels,state,url,author',
  ], { encoding: 'utf8', env: process.env }));
}

export function createIssueReadTool(issue, repository = process.env.GITHUB_REPOSITORY) {
  return {
    description: 'Read the current fixed target Issue; this tool cannot select another Issue.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) {
        throw new Error('Unauthorized Issue read tool arguments');
      }
      const current = fetchGitHubIssue(issue.number, repository);
      return JSON.stringify(current);
    },
  };
}