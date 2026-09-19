/**
 * Markdown filename signals: extensions, MIME types, and well-known basenames.
 *
 * These are the *trustworthy* markdown signals. Anything decided here is
 * metadata, not a guess about content, so callers may act on it directly.
 */

/** Extensions that mean markdown, without a leading dot, lowercase. */
export const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'markdown',
  'mkd',
  'mdown',
  'mkdn',
  'mdx',
]);

/**
 * Basenames that are markdown by convention, even without an extension.
 *
 * Compared case-insensitively and with any extension stripped, so `README`,
 * `readme.md` and `Readme.txt` all match. Deliberately excludes `LICENSE` and
 * `AUTHORS`: those are conventionally plain text, and treating them as markdown
 * is one of the misdetections this module exists to stop.
 */
export const MARKDOWN_BASENAMES: ReadonlySet<string> = new Set([
  'readme',
  'changelog',
  'changes',
  'contributing',
  'code_of_conduct',
  'security',
  'history',
  'news',
]);

/** MIME types that mean markdown. */
export const MARKDOWN_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/markdown',
  'text/x-markdown',
]);

/** Return true if the extension (no leading dot) indicates a markdown file. */
export function isMarkdownExt(ext: string): boolean {
  return MARKDOWN_EXTENSIONS.has(ext.toLowerCase());
}

/** Return true if the MIME type indicates markdown, ignoring parameters. */
export function isMarkdownMimeType(mimeType: string): boolean {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return MARKDOWN_MIME_TYPES.has(base);
}

/** Strip directories from a path, returning the final segment. */
export function basenameOf(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

/**
 * Return true if the basename is a conventional markdown filename.
 *
 * Strips one trailing extension before comparing, so `CHANGELOG.md` and bare
 * `CHANGELOG` both match.
 */
export function isMarkdownBasename(path: string): boolean {
  const basename = basenameOf(path).toLowerCase();
  if (MARKDOWN_BASENAMES.has(basename)) {
    return true;
  }
  const lastDot = basename.lastIndexOf('.');
  if (lastDot <= 0) {
    return false;
  }
  return MARKDOWN_BASENAMES.has(basename.slice(0, lastDot));
}
