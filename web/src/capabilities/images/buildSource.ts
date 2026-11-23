import type {
  ImageComposeRepresentation,
  ImageSource,
} from '@/generated/protocol/core/server-image-build-submit/v1';

/**
 * The Build editor's source adapters (#3795).
 *
 * Only adapters the Server's canonical Build Source contract actually serves
 * are offered. Archive and external OCI conversion exist in the lower EROFS
 * infrastructure but are not part of the Server Build Source DTO, so the editor
 * does not present them as selectable — a disabled decorative choice is still
 * a claim about supported behavior.
 */
export type BuildSourceKind = 'github' | 'local_directory' | 'compose';

export const BUILD_SOURCE_KINDS: readonly BuildSourceKind[] = [
  'github',
  'local_directory',
  'compose',
];

export const BUILD_SOURCE_LABEL: Record<BuildSourceKind, string> = {
  github: 'GitHub',
  local_directory: 'Directory',
  compose: 'Compose',
};

export interface ComposeSourceDraft {
  repository: string;
  reference: string;
  destination: string;
}

/** One in-progress New Image form. It is not yet a wire source. */
export interface BuildSourceDraft {
  kind: BuildSourceKind;
  repositoryUrl: string;
  reference: string;
  path: string;
  representation: ImageComposeRepresentation;
  sources: ComposeSourceDraft[];
}

/** A field-local error. `compose.<index>.<field>` addresses one Compose row. */
export type BuildSourceErrors = Record<string, string>;

export interface BuildSourceValidation {
  source?: ImageSource;
  errors: BuildSourceErrors;
}

export function emptyBuildSourceDraft(): BuildSourceDraft {
  return {
    kind: 'github',
    repositoryUrl: '',
    reference: 'main',
    path: '',
    representation: 'flattened',
    sources: [{ repository: '', reference: '', destination: '' }],
  };
}

export function emptyComposeSourceDraft(): ComposeSourceDraft {
  return { repository: '', reference: '', destination: '' };
}

const IMAGE_REF_MAX_CHARS = 255;
const IMAGE_REPOSITORY_URL_MAX_CHARS = 2048;
const IMAGE_LOCAL_PATH_MAX_CHARS = 4096;
const IMAGE_ALIAS_MAX_CHARS = 128;
const IMAGE_COMPOSE_MAX_SOURCES = 16;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * The public GitHub repository URL the Server accepts: one
 * `https://github.com/<owner>/<repo>` pair, one optional trailing `.git` or
 * `/`. Credentials, queries, fragments and extra segments are refused here so
 * the editor never submits a request the Server must reject.
 */
export function normalizeGithubRepositoryUrl(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > IMAGE_REPOSITORY_URL_MAX_CHARS) {
    return null;
  }
  if (value.includes('@') || value.includes('?') || value.includes('#')) {
    return null;
  }
  if (hasControlCharacters(value) || !value.startsWith('https://github.com/')) {
    return null;
  }
  const path = value
    .slice('https://github.com/'.length)
    .replace(/\/$/, '')
    .replace(/\.git$/, '');
  const parts = path.split('/');
  if (parts.length !== 2) {
    return null;
  }
  const [owner, repo] = parts;
  const valid = (part: string) =>
    part.length > 0
    && part !== '.'
    && part !== '..'
    && /^[A-Za-z0-9._-]+$/.test(part);
  if (!owner || !repo || !valid(owner) || !valid(repo)) {
    return null;
  }
  return `https://github.com/${owner}/${repo}`;
}

/** Git check-ref-format ambiguities a branch name must not carry. */
function sourceRefHasInvalidShape(value: string): boolean {
  return (
    hasControlCharacters(value)
    || value.startsWith('-')
    || value.startsWith('/')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.includes('..')
    || value.includes('//')
    || value.includes('@{')
    || value.includes('\\')
    || value.includes('~')
    || value.includes('^')
    || value.includes(':')
    || value.includes('?')
    || value.includes('*')
    || value.includes('[')
    || value.toLowerCase() === 'head'
  );
}

function sourceRefSegmentsAreInvalid(value: string): boolean {
  return value
    .split('/')
    .some((part) => part.length === 0 || part.startsWith('.') || part.endsWith('.lock'));
}

/** A branch name or a full 40-character commit, matching the Server rule. */
export function normalizeSourceRef(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > IMAGE_REF_MAX_CHARS) {
    return null;
  }
  if (isFullCommitSha(value)) {
    return value;
  }
  if (sourceRefHasInvalidShape(value) || sourceRefSegmentsAreInvalid(value)) {
    return null;
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) {
    return null;
  }
  return value;
}

/** An absolute, `..`-free host path. The Server also authorizes its root. */
export function normalizeLocalPath(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > IMAGE_LOCAL_PATH_MAX_CHARS) {
    return null;
  }
  if (hasControlCharacters(value) || !value.startsWith('/')) {
    return null;
  }
  if (value.split('/').includes('..')) {
    return null;
  }
  return value;
}

/** The optional mutable alias rule; empty means "no alias". */
export function normalizeBuildAlias(raw: string): string | null | undefined {
  const value = raw.trim();
  if (value.length === 0) {
    return undefined;
  }
  if (value.length > IMAGE_ALIAS_MAX_CHARS) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value) || value.startsWith('sha256:')) {
    return null;
  }
  return value;
}

function validComposeRepository(value: string): boolean {
  if (value.length === 0 || value.length > 255) {
    return false;
  }
  return value.split('/').every((segment) => {
    if (
      segment.length === 0
      || segment.length > 63
      || segment === '.'
      || segment === '..'
    ) {
      return false;
    }
    if (!/^[a-z0-9]$/.test(segment.charAt(0))) {
      return false;
    }
    const last = segment.charAt(segment.length - 1);
    if (!/^[a-z0-9]$/.test(last)) {
      return false;
    }
    return /^[a-z0-9._-]+$/.test(segment);
  });
}

function validComposeReference(value: string): boolean {
  if (/^sha256:[0-9a-f]{64}$/.test(value)) {
    return true;
  }
  return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
}

/** `''` and `/` both name the composed root. */
function normalizeComposeDestination(raw: string): string | null {
  const value = raw.trim();
  if (value.length > 1024) {
    return null;
  }
  if (value.length === 0 || value === '/') {
    return '';
  }
  if (!value.startsWith('/') || value.endsWith('/')) {
    return null;
  }
  if (
    value.includes('\\')
    || hasControlCharacters(value)
    || value
      .slice(1)
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return value;
}

function destinationIsPrefix(left: string, right: string): boolean {
  return right === left || (right.startsWith(left) && right.charAt(left.length) === '/');
}

/**
 * Validate one Build Source draft and project the canonical wire source.
 *
 * The Server remains the authority. This preflight exists so an invalid
 * source never leaves the editor as a submitted job (SC-01); a Server refusal
 * is still rendered when a rule changes or host policy (the authorized local
 * root) rejects an otherwise valid declaration.
 */
export function validateBuildSource(draft: BuildSourceDraft): BuildSourceValidation {
  switch (draft.kind) {
    case 'github':
      return validateGithubDraft(draft);
    case 'local_directory':
      return validateDirectoryDraft(draft);
    case 'compose':
      return validateComposeDraft(draft);
  }
}

function validateGithubDraft(draft: BuildSourceDraft): BuildSourceValidation {
  const errors: BuildSourceErrors = {};
  const repository = normalizeGithubRepositoryUrl(draft.repositoryUrl);
  const reference = normalizeSourceRef(draft.reference);
  if (repository === null) {
    errors.repository_url =
      'Use https://github.com/<owner>/<repo>; private, ssh and git protocols are not supported';
  }
  if (reference === null) {
    errors.ref = 'Use a branch name or a full 40-character commit SHA';
  }
  if (repository === null || reference === null) {
    return { errors };
  }
  return {
    errors,
    source: { kind: 'github', repository_url: repository, ref: reference },
  };
}

function validateDirectoryDraft(draft: BuildSourceDraft): BuildSourceValidation {
  const errors: BuildSourceErrors = {};
  const path = normalizeLocalPath(draft.path);
  if (path === null) {
    errors.path = 'Use an absolute host path without ".." under the authorized source root';
    return { errors };
  }
  return { errors, source: { kind: 'local_directory', path } };
}

interface NormalizedComposeDraft {
  repository: string;
  ref: string;
  destination: string;
}

function validateComposeRows(
  draft: BuildSourceDraft,
  errors: BuildSourceErrors,
): NormalizedComposeDraft[] {
  const normalized: NormalizedComposeDraft[] = [];
  draft.sources.forEach((row, index) => {
    const repository = row.repository.trim();
    const reference = row.reference.trim();
    const destination = normalizeComposeDestination(row.destination);
    if (!validComposeRepository(repository)) {
      errors[`compose.${index}.repository`] = 'Use a lowercase catalog repository name';
    }
    if (!validComposeReference(reference)) {
      errors[`compose.${index}.ref`] = 'Use a Tag or an immutable sha256 digest';
    }
    if (destination === null) {
      errors[`compose.${index}.destination`] =
        'Use an absolute normalized prefix such as /opt/tools, or / for the root';
    }
    if (repository && reference && destination !== null) {
      normalized.push({ repository, ref: reference, destination });
    }
  });
  return normalized;
}

function validateReferencedCompose(
  rows: NormalizedComposeDraft[],
  errors: BuildSourceErrors,
): boolean {
  if (rows.some((row) => row.destination !== '')) {
    errors.representation =
      'A referenced Compose keeps every source at the composed root; remove destination prefixes';
    return false;
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.repository}@${row.ref}`;
    if (seen.has(key)) {
      errors.compose = 'A referenced Compose cannot name the same source revision twice';
      return false;
    }
    seen.add(key);
  }
  return true;
}

function validateFlattenedCompose(
  rows: NormalizedComposeDraft[],
  errors: BuildSourceErrors,
): boolean {
  const sorted = [...rows].sort((left, right) => {
    const byDestination = left.destination.localeCompare(right.destination);
    return byDestination !== 0
      ? byDestination
      : `${left.repository}@${left.ref}`.localeCompare(`${right.repository}@${right.ref}`);
  });
  for (let index = 1; index < sorted.length; index += 1) {
    const left = sorted[index - 1];
    const right = sorted[index];
    if (!left || !right) {
      continue;
    }
    if (left.destination === '' && right.destination === '') {
      errors.compose = 'Only one source may name the composed root';
      return false;
    }
    if (left.destination !== '' && destinationIsPrefix(left.destination, right.destination)) {
      errors.compose = 'Compose destination prefixes must not overlap';
      return false;
    }
  }
  return true;
}

function validateComposeDraft(draft: BuildSourceDraft): BuildSourceValidation {
  const errors: BuildSourceErrors = {};
  if (draft.sources.length === 0) {
    errors.compose = 'Add at least one source Image';
    return { errors };
  }
  if (draft.sources.length > IMAGE_COMPOSE_MAX_SOURCES) {
    errors.compose = `A compose build accepts at most ${IMAGE_COMPOSE_MAX_SOURCES} source Images`;
    return { errors };
  }
  const normalized = validateComposeRows(draft, errors);
  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  const valid =
    draft.representation === 'referenced'
      ? validateReferencedCompose(normalized, errors)
      : validateFlattenedCompose(normalized, errors);
  if (!valid) {
    return { errors };
  }
  return {
    errors,
    source: {
      kind: 'compose',
      representation: draft.representation,
      sources: normalized.map((row) => ({
        repository: row.repository,
        ref: row.ref,
        destination: row.destination,
      })),
    },
  };
}

/** True when a source is a manifest-backed Compose declaration. */
export function isComposeSource(source: ImageSource): boolean {
  return source.kind === 'compose';
}
