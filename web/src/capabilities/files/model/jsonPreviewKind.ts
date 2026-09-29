export type JsonPreviewKind = 'json' | 'jsonl';

const JSONL_EXTENSIONS = new Set(['jsonl', 'ndjson']);

/** Extension-driven structured preview dispatch for Files (#1199). */
export function getJsonPreviewKind(ext: string): JsonPreviewKind | null {
  const key = ext.toLowerCase();
  if (key === 'json') {
    return 'json';
  }
  if (JSONL_EXTENSIONS.has(key)) {
    return 'jsonl';
  }
  return null;
}

export function isJsonPreviewExt(ext: string): boolean {
  return getJsonPreviewKind(ext) === 'json';
}

export function isJsonlPreviewExt(ext: string): boolean {
  return getJsonPreviewKind(ext) === 'jsonl';
}
