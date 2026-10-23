// Shared trusted read-only GitHub API access for main-owned workflows.
// The caller supplies a short-lived token; this module never writes, retries
// or follows redirects, and every response is unprivileged input to a
// canonical verifier.
const DEFAULT_REPOSITORY = 'BestNathan/nession';

export function githubFetcher(token, { repository = DEFAULT_REPOSITORY, timeoutMs = 20000 } = {}) {
  if (typeof token !== 'string' || token.length < 8) throw new Error('trusted read-only token required');
  if (typeof repository !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository))
    throw new Error('invalid GitHub repository');
  return async (endpoint) => {
    if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 2048 ||
        endpoint.startsWith('/') || endpoint.includes('..'))
      throw new Error('invalid GitHub read endpoint');
    const response = await fetch('https://api.github.com/repos/' + repository + '/' + endpoint, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error('GitHub read failed: ' + endpoint + ' (' + response.status + ')');
    return response.json();
  };
}
