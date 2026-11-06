export { FilesPlugin } from './FilesPlugin';
export { createFilesApi } from './FilesPlugin';
export { DEFAULT_CHUNK_SIZE } from './FilesPlugin';
export { base64Decode } from './FilesPlugin';
export { base64Encode } from './FilesPlugin';
export { readFileChunked } from './FilesPlugin';
export type { FileApi } from './FilesPlugin';
export type { ChunkedReadResult } from './types';
export type { CreateDirOptions } from './types';
export type { FileData } from './types';
export type { FileEntry } from './types';
export type { FileOps } from './types';
export type { RenameFileOptions } from './types';
export type { WriteFileOptions } from './types';

// File identity and operation context belong to the capability's public API:
// the Web/App layouts compose them, and a path is only meaningful together with
// the source it was resolved in.
export {
  fileRefEquals,
  fileRefKey,
  isRefInSource,
  makeFileRef,
  normalizeFilePath,
  resolveFileSource,
} from './model/fileRef';
export type { FileRef, FileSource, FileSourceInput } from './model/fileRef';
export {
  joinPath,
  parentPathOf,
  resolveCreateTarget,
  validateEntryName,
} from './model/createTarget';
export type { CreateKind, CreateTarget, CreateTargetContext } from './model/createTarget';
export { fileErrorKind, fileErrorMessage } from './model/fileErrors';
export type { FileErrorKind } from './model/fileErrors';

// The presentation half of the capability, for the experiences that compose it.
// A capability owns how it draws itself; the Experience decides *where* — so
// these are part of its public API, not internals a consumer may reach past.
// Imports go through this file rather than `./components/FileViewer` so the
// capability stays free to move its own files (#801 acceptance criterion:
// capability cross-import goes through an explicit public API, not a deep path).
export { FileBrowser } from './components/FileBrowser';
export { FileList } from './components/FileList';
export { FileViewer } from './components/FileViewer';
