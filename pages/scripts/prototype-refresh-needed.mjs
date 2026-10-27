import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = 'BestNathan/nession';
const PROTOTYPE_REF = 'https://api.github.com/repos/' + REPOSITORY + '/git/ref/heads/prototype';
const PUBLIC_MANIFEST = 'https://bestnathan.github.io/nession/prototypes/manifest.json';

/** A public manifest is authoritative only for its pinned source SHA. */
export function prototypeNeedsRefresh(headSha, manifest) {
  return !(
    SHA.test(headSha ?? '') &&
    manifest?.schema_version === 1 &&
    manifest?.source?.branch === 'prototype' &&
    manifest?.source?.sha === headSha &&
    Array.isArray(manifest.entries) &&
    manifest.entries.every(e =>
      typeof e.slug === 'string' &&
      e.source?.startsWith('https://github.com/' + REPOSITORY + '/blob/' + headSha + '/')
    )
  );
}

async function readJson(fetchImpl, url, headers = {}) {
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' fetching ' + new URL(url).pathname);
  return response.json();
}

/**
 * Read source identity from GitHub; compare to independently published HTTPS
 * manifest. Fail open into the existing trusted deploy, NEVER into a skip.
 * No prototype code, scripts, artifacts, or user-controlled GitHub inputs run.
 */
export async function probePrototypeRefresh({ fetchImpl = fetch, token = '' } = {}) {
  try {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const git = await readJson(fetchImpl, PROTOTYPE_REF, headers);
    const sha = git?.object?.sha;
    if (!SHA.test(sha ?? '')) throw new Error('Invalid prototype source SHA');
    const published = await readJson(fetchImpl, PUBLIC_MANIFEST + '?expected=' + sha, {
      'Cache-Control': 'no-cache',
    });
    const changed = prototypeNeedsRefresh(sha, published);
    return { changed, sourceSha: sha, publishedSha: published?.source?.sha ?? null };
  } catch (error) {
    return { changed: true, sourceSha: null, publishedSha: null, reason: String(error) };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await probePrototypeRefresh({ token: process.env.GITHUB_TOKEN ?? '' });
  console.log(JSON.stringify({
    refresh_needed: result.changed,
    source_sha: result.sourceSha,
    published_sha: result.publishedSha,
    ...(result.reason ? { probe_error: result.reason } : {}),
  }));
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, 'changed=' + result.changed + '\n');
  }
}
