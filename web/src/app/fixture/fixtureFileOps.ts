import type { FileData, FileEntry, FileOps } from '@/features/files';
import {
  FIXTURE_FILE_CONTENTS,
  FIXTURE_FILES,
  FIXTURE_MODIFIED_TS,
} from './fixtureFiles';

/**
 * Deterministic FileOps for the workspace fixture: serves FIXTURE_FILES /
 * FIXTURE_FILE_CONTENTS, no network. Mutating calls (upload/delete/…)
 * resolve with a not-implemented rejection.
 */
export function fixtureFileOps(): FileOps {
  return {
    listDir,
    readFile,
    writeFile: notSupported,
    deleteFile: notSupported,
    createDir: notSupported,
    renameFile: notSupported,
    getCwd: notSupported,
    uploadFile: notSupported,
    base64Decode,
    base64Encode,
  };
}

function notSupported(): Promise<never> {
  return Promise.reject(new Error('fixture: not supported'));
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function dirEntry(path: string): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    path,
    name,
    full_path: `/${path}`,
    is_dir: true,
    size: 0,
    modified: FIXTURE_MODIFIED_TS,
  };
}

let cachedTree: Map<string, FileEntry[]> | null = null;

/**
 * Adjacency map (parent path → children) built from FIXTURE_FILES. Missing
 * intermediate dirs (e.g. `docs`, `web`) are synthesized so every level of
 * the tree is navigable from the root.
 */
function fixtureTree(): Map<string, FileEntry[]> {
  if (cachedTree) {
    return cachedTree;
  }
  const tree = new Map<string, FileEntry[]>();
  const known = new Set(FIXTURE_FILES.map((e) => e.path));
  const add = (parent: string, entry: FileEntry) => {
    const siblings = tree.get(parent) ?? [];
    siblings.push(entry);
    tree.set(parent, siblings);
  };
  for (const entry of FIXTURE_FILES) {
    add(parentOf(entry.path), entry);
    for (let parent = parentOf(entry.path); parent !== ''; parent = parentOf(parent)) {
      if (known.has(parent)) {
        continue;
      }
      add(parentOf(parent), dirEntry(parent));
      known.add(parent);
    }
  }
  cachedTree = tree;
  return tree;
}

function listDir(path: string): Promise<{ entries: FileEntry[] }> {
  return Promise.resolve({ entries: fixtureTree().get(path) ?? [] });
}

function mimeTypeFor(path: string): string {
  return path.endsWith('.md') ? 'text/markdown' : 'text/plain';
}

function readFile(
  path: string,
  options?: { offset?: number; limit?: number },
): Promise<FileData> {
  const content = FIXTURE_FILE_CONTENTS[path];
  if (content === undefined) {
    return Promise.reject(new Error(`fixture: unknown file: ${path}`));
  }
  const offset = options?.offset ?? 0;
  const slice =
    options?.limit === undefined
      ? content.slice(offset)
      : content.slice(offset, offset + options.limit);
  return Promise.resolve({
    path,
    content: base64Encode(slice),
    mime_type: mimeTypeFor(path),
    offset,
    total_size: content.length,
    has_more: offset + slice.length < content.length,
  });
}

function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64Decode(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}
