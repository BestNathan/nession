// Memory Markdown link resolution (#2742).
//
// A Memory document may link to another file in the same Memory snapshot. The
// rules are deliberately narrower than a browser's URL resolution: only a
// listed Markdown file inside the current snapshot is navigable, and the target
// is always re-read through the provider's bounded read (which independently
// re-checks containment). Everything else is refused here with a reason the
// reader can state without pretending the link worked.

export type MemoryLinkBlockedReason =
  | 'empty'
  | 'unsafe-scheme'
  | 'absolute-path'
  | 'traversal'
  | 'query'
  | 'malformed'
  | 'unsupported-target'
  | 'unlisted';

export type MemoryLinkResolution =
  | { kind: 'external'; href: string }
  | { kind: 'fragment'; fragment: string }
  | { kind: 'file'; path: string; fragment: string | null }
  | { kind: 'blocked'; reason: MemoryLinkBlockedReason; target: string };

interface MemoryFileLike {
  path: string;
}

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const MARKDOWN_TARGET = /\.md$/i;

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Resolve a Markdown `href` found in `sourcePath` against the snapshot's file
 * list.
 *
 * `#fragment` stays in the current document; a relative file path is joined to
 * the source file's directory, normalised, and matched against a listed file.
 * Exact paths win; otherwise NFC-normalised equality handles a decomposed
 * Unicode filename without accepting a different name.
 */
type ParsedHref =
  | { kind: 'external'; href: string }
  | { kind: 'fragment'; fragment: string }
  | { kind: 'blocked'; reason: MemoryLinkBlockedReason; target: string }
  | { kind: 'path'; path: string; fragment: string | null };

function blocked(reason: MemoryLinkBlockedReason, target: string): ParsedHref {
  return { kind: 'blocked', reason, target };
}

function parseFragment(
  rawFragment: string | null,
): { ok: true; value: string | null } | { ok: false } {
  if (rawFragment === null || rawFragment === '') {
    return { ok: true, value: null };
  }
  const value = decode(rawFragment);
  return value === null ? { ok: false } : { ok: true, value };
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:/.test(value);
}

function parseHref(href: string | undefined): ParsedHref {
  if (typeof href !== 'string' || href.trim() === '') {
    return blocked('empty', '');
  }
  const raw = href;
  const scheme = SCHEME.exec(raw);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    return name === 'http' || name === 'https'
      ? { kind: 'external', href: raw }
      : blocked('unsafe-scheme', raw);
  }
  if (raw.startsWith('//')) {
    return blocked('unsafe-scheme', raw);
  }

  const hashIndex = raw.indexOf('#');
  const pathPart = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const fragmentResult = parseFragment(
    hashIndex >= 0 ? raw.slice(hashIndex + 1) : null,
  );
  if (!fragmentResult.ok) {
    return blocked('malformed', raw);
  }
  if (pathPart === '') {
    return fragmentResult.value === null
      ? blocked('empty', raw)
      : { kind: 'fragment', fragment: fragmentResult.value };
  }
  if (isAbsolutePath(pathPart)) {
    return blocked('absolute-path', raw);
  }
  if (pathPart.includes('?')) {
    return blocked('query', raw);
  }

  const decodedPath = decode(pathPart);
  if (decodedPath === null || decodedPath.includes('\\')) {
    return blocked('malformed', raw);
  }
  if (isAbsolutePath(decodedPath)) {
    return blocked('absolute-path', raw);
  }
  return { kind: 'path', path: decodedPath, fragment: fragmentResult.value };
}

function normalizeRelativePath(
  sourcePath: string,
  decodedPath: string,
): { ok: true; path: string } | { ok: false; reason: 'traversal' | 'empty' } {
  const parts = sourcePath.split('/').slice(0, -1);
  for (const segment of decodedPath.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (parts.length === 0) {
        return { ok: false, reason: 'traversal' };
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const path = parts.join('/');
  return path === '' ? { ok: false, reason: 'empty' } : { ok: true, path };
}

function matchListedFile(
  candidate: string,
  files: readonly MemoryFileLike[],
): MemoryFileLike | undefined {
  const folded = candidate.normalize('NFC');
  return files.find(
    (file) => file.path === candidate || file.path.normalize('NFC') === folded,
  );
}

/**
 * Resolve a Markdown `href` found in `sourcePath` against the snapshot's file
 * list.
 *
 * `#fragment` stays in the current document; a relative file path is joined to
 * the source file's directory, normalised, and matched against a listed file.
 * Exact paths win; otherwise NFC-normalised equality handles a decomposed
 * Unicode filename without accepting a different name.
 */
export function resolveMemoryLink(
  href: string | undefined,
  sourcePath: string,
  files: readonly MemoryFileLike[],
): MemoryLinkResolution {
  const parsed = parseHref(href);
  if (parsed.kind !== 'path') {
    return parsed;
  }
  const normalized = normalizeRelativePath(sourcePath, parsed.path);
  if (!normalized.ok) {
    return { kind: 'blocked', reason: normalized.reason, target: href ?? '' };
  }
  if (!MARKDOWN_TARGET.test(normalized.path)) {
    return { kind: 'blocked', reason: 'unsupported-target', target: href ?? '' };
  }
  const match = matchListedFile(normalized.path, files);
  if (!match) {
    return { kind: 'blocked', reason: 'unlisted', target: href ?? '' };
  }
  return { kind: 'file', path: match.path, fragment: parsed.fragment };
}

/** GitHub-style heading slug, used only for in-document fragment matching. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

/** Whether `fragment` names `headingText`, accepting the slug and plain text. */
export function headingMatchesFragment(headingText: string, fragment: string): boolean {
  const wanted = fragment
    .trim()
    .replace(/^user-content-/i, '')
    .replace(/^#/, '')
    .toLowerCase();
  const text = headingText.trim().toLowerCase();
  return wanted === text || wanted === headingSlug(headingText);
}
