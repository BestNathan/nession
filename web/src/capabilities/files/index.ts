export { FilesPlugin } from './FilesPlugin';
export { createFilesApi } from './FilesPlugin';
export { DEFAULT_CHUNK_SIZE } from './FilesPlugin';
export { base64Decode } from './FilesPlugin';
export { base64Encode } from './FilesPlugin';
export { readFileChunked } from './FilesPlugin';
export type { FileApi } from './FilesPlugin';
export type { ChunkedReadResult } from './types';
export type { FileData } from './types';
export type { FileEntry } from './types';
export type { FileOps } from './types';

// The presentation half of the capability, for the experiences that compose it.
// A capability owns how it draws itself; the Experience decides *where* — so
// these are part of its public API, not internals a consumer may reach past.
// Imports go through this file rather than `./components/FileViewer` so the
// capability stays free to move its own files (#801 acceptance criterion:
// capability cross-import goes through an explicit public API, not a deep path).
export { FileBrowser } from './components/FileBrowser';
export { FileList } from './components/FileList';
export { FileViewer } from './components/FileViewer';
