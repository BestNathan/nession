import type {
  CreateDirOptions,
  FileData,
  FileEntry,
  FileOps,
  RenameFileOptions,
  WriteFileOptions,
} from '@/capabilities/files';
import {
  FIXTURE_FILE_CONTENTS,
  FIXTURE_FILES,
  FIXTURE_MODIFIED_TS,
} from './fixtureFiles';

/**
 * Deterministic, in-memory FileOps for the workspace fixture.
 *
 * The initial tree and contents are the canonical fixture data; mutations are
 * per page load and never touch the network. The mutable half exists because
 * the Files flows under test (create, upload, save, conflict) have to observe
 * their own writes; a read-only stub cannot prove them.
 */
interface FixtureState {
  entries: Map<string, FileEntry>;
  contents: Map<string, string>;
  revisions: Map<string, string>;
  revisionCounter: number;
}

let state: FixtureState | null = null;

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirEntry(path: string): FileEntry {
  return {
    name: baseName(path),
    path,
    full_path: `/${path}`,
    is_dir: true,
    size: 0,
    modified: FIXTURE_MODIFIED_TS,
  };
}

function initialState(): FixtureState {
  const entries = new Map<string, FileEntry>();
  const contents = new Map<string, string>();
  const revisions = new Map<string, string>();
  let revisionCounter = 0;

  for (const entry of FIXTURE_FILES) {
    entries.set(entry.path, { ...entry });
    // Every path starts with a revision, so a guarded save against unchanged
    // fixture content succeeds without a special case.
    revisions.set(entry.path, `fixture-${revisionCounter++}`);
    for (let parent = parentOf(entry.path); parent !== ''; parent = parentOf(parent)) {
      if (!entries.has(parent)) {
        entries.set(parent, dirEntry(parent));
      }
    }
  }
  for (const [path, content] of Object.entries(FIXTURE_FILE_CONTENTS)) {
    contents.set(path, content);
  }
  return { entries, contents, revisions, revisionCounter };
}

function current(): FixtureState {
  if (state === null) {
    state = initialState();
  }
  return state;
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}

function nextRevision(target: FixtureState, path: string): string {
  const revision = `fixture-${target.revisionCounter++}`;
  target.revisions.set(path, revision);
  return revision;
}

function ensureParentDirs(target: FixtureState, path: string): void {
  const parent = parentOf(path);
  if (parent !== '' && !target.entries.has(parent)) {
    ensureParentDirs(target, parent);
    target.entries.set(parent, dirEntry(parent));
  }
}

function childrenOf(target: FixtureState, path: string): FileEntry[] {
  return [...target.entries.values()].filter((entry) => parentOf(entry.path) === path);
}

function knownRevision(target: FixtureState, path: string): string {
  return target.revisions.get(path) ?? 'fixture-missing';
}

function reject(message: string): Promise<never> {
  return Promise.reject(new Error(message));
}

function base64EncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64Encode(s: string): string {
  return base64EncodeBytes(new TextEncoder().encode(s));
}

function base64Bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64Decode(b64: string): string {
  return new TextDecoder().decode(base64Bytes(b64));
}

function listDir(path: string): Promise<{ entries: FileEntry[] }> {
  return Promise.resolve({ entries: childrenOf(current(), path) });
}

function mimeTypeFor(path: string): string {
  return path.endsWith('.md') ? 'text/markdown' : 'text/plain';
}

function readFile(
  path: string,
  options?: { offset?: number; limit?: number },
): Promise<FileData> {
  const target = current();
  const content = target.contents.get(path);
  if (content === undefined) {
    return reject(`fixture: unknown file: ${path}`);
  }
  // Byte slicing, not character slicing: the chunked reader advances by bytes
  // and a multi-byte UTF-8 sequence must be allowed to split across chunks.
  const bytes = new TextEncoder().encode(content);
  const offset = options?.offset ?? 0;
  const limit = options?.limit;
  const end = limit === undefined ? bytes.length : Math.min(bytes.length, offset + limit);
  const slice = bytes.slice(offset, end);
  return Promise.resolve({
    path,
    content: base64EncodeBytes(slice),
    mime_type: mimeTypeFor(path),
    offset,
    total_size: bytes.length,
    has_more: offset + slice.length < bytes.length,
    revision: knownRevision(target, path),
  });
}

async function writeFile(
  path: string,
  content: string,
  options?: WriteFileOptions,
): Promise<{ path: string; written: number; revision: string }> {
  const target = current();
  if (options?.createOnly && target.entries.has(path)) {
    return reject(`already_exists: ${path}`);
  }
  if (options?.expectedRevision !== undefined && knownRevision(target, path) !== options.expectedRevision) {
    return reject(`conflict: ${path} changed`);
  }
  if (target.entries.get(path)?.is_dir) {
    return reject(`is_directory: ${path}`);
  }

  ensureParentDirs(target, path);
  target.entries.set(path, {
    name: baseName(path),
    path,
    full_path: `/${path}`,
    is_dir: false,
    size: byteLength(content),
    modified: Date.now(),
  });
  target.contents.set(path, content);
  const revision = nextRevision(target, path);
  return { path, written: byteLength(content), revision };
}

async function deleteFile(
  path: string,
  recursive?: boolean,
): Promise<{ path: string; success: boolean }> {
  const target = current();
  const entry = target.entries.get(path);
  if (!entry) {
    return reject(`not_found: ${path}`);
  }
  const children = childrenOf(target, path);
  if (entry.is_dir && children.length > 0 && recursive !== true) {
    return reject(`directory_not_empty: ${path}`);
  }
  for (const child of children) {
    await deleteFile(child.path, true);
  }
  target.entries.delete(path);
  target.contents.delete(path);
  target.revisions.delete(path);
  return { path, success: true };
}

async function createDir(
  path: string,
  options?: CreateDirOptions,
): Promise<{ path: string; success: boolean }> {
  const target = current();
  if (options?.createOnly && target.entries.has(path)) {
    return reject(`already_exists: ${path}`);
  }
  ensureParentDirs(target, path);
  if (!target.entries.has(path)) {
    target.entries.set(path, dirEntry(path));
  }
  return { path, success: true };
}

async function renameFile(
  from: string,
  to: string,
  options?: RenameFileOptions,
): Promise<{ from: string; to: string; success: boolean }> {
  const target = current();
  const entry = target.entries.get(from);
  if (!entry) {
    return reject(`not_found: ${from}`);
  }
  if (options?.noReplace && target.entries.has(to)) {
    return reject(`already_exists: ${to}`);
  }
  if (target.entries.has(to)) {
    await deleteFile(to, true);
  }
  ensureParentDirs(target, to);

  const moved: FileEntry[] = [];
  for (const candidate of [...target.entries.values()]) {
    if (candidate.path === from || candidate.path.startsWith(`${from}/`)) {
      moved.push(candidate);
    }
  }
  for (const candidate of moved) {
    const nextPath = `${to}${candidate.path.slice(from.length)}`;
    target.entries.delete(candidate.path);
    target.entries.set(nextPath, {
      ...candidate,
      path: nextPath,
      name: baseName(nextPath),
      full_path: `/${nextPath}`,
    });
    const content = target.contents.get(candidate.path);
    if (content !== undefined) {
      target.contents.delete(candidate.path);
      target.contents.set(nextPath, content);
    }
    const revision = target.revisions.get(candidate.path);
    target.revisions.delete(candidate.path);
    target.revisions.set(nextPath, revision ?? nextRevision(target, nextPath));
  }
  return { from, to, success: true };
}

async function uploadFile(
  path: string,
  file: File,
  options?: { createOnly?: boolean },
): Promise<{ path: string; written: number; revision: string }> {
  const content = await file.text();
  return writeFile(path, content, { createOnly: options?.createOnly ?? true });
}

function getCwd(): Promise<{ path: string }> {
  return Promise.resolve({ path: '' });
}

export function fixtureFileOps(): FileOps {
  return {
    listDir,
    readFile,
    writeFile,
    deleteFile,
    createDir,
    renameFile,
    getCwd,
    uploadFile,
    base64Decode,
    base64Encode,
  };
}

/**
 * Test-only control for the fixture's mutable filesystem.
 *
 * The E2E and Acceptance Cases need to simulate a competing writer between the
 * viewer's read and save; there is no real Agent in the fixture route, so the
 * fixture exposes the same mutation the server would perform.
 */
export interface FixtureFilesControl {
  reset: () => void;
  revisionOf: (path: string) => string;
  writeExternal: (path: string, content: string) => void;
}

export function fixtureFilesControl(): FixtureFilesControl {
  return {
    reset: () => {
      state = null;
    },
    revisionOf: (path: string) => knownRevision(current(), path),
    writeExternal: (path: string, content: string) => {
      const target = current();
      ensureParentDirs(target, path);
      target.entries.set(path, {
        name: baseName(path),
        path,
        full_path: `/${path}`,
        is_dir: false,
        size: byteLength(content),
        modified: Date.now(),
      });
      target.contents.set(path, content);
      nextRevision(target, path);
    },
  };
}

if (typeof window !== 'undefined') {
  (window as Window & { fixtureFiles?: FixtureFilesControl }).fixtureFiles =
    fixtureFilesControl();
}
