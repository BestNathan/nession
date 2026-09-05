/**
 * File-domain data types — ported from `services/fileOps.ts`, which the
 * websocket-plugin-model refactor deletes once consumers re-point at this
 * feature (Task 8). The shapes are the wire responses of `file.*` requests,
 * unchanged.
 */

export interface FileEntry {
  name: string;
  path: string;
  /** Absolute path on the filesystem, for "copy full path". */
  full_path: string;
  is_dir: boolean;
  size: number;
  modified: number;
  /** Optional MIME type returned by the backend scan. */
  mime_type?: string;
  /** True when the backend detected the file is binary (non-text). */
  is_binary?: boolean;
}

export interface FileData {
  path: string;
  /** base64-encoded content. */
  content: string;
  mime_type: string;
  /** Byte offset of the returned chunk within the file (chunked reads only). */
  offset?: number;
  /** Total size of the file in bytes (chunked reads only). */
  total_size?: number;
  /** True when the file has more data past this chunk (chunked reads only). */
  has_more?: boolean;
}

/**
 * Legacy FileOps shape (plaintext `writeFile`, `uploadFile`, base64 helpers
 * as members) — produced by {@link FilesPlugin.toFileOps} until the
 * session-first tool UI migrates to the typed API.
 */
export interface FileOps {
  listDir(path: string): Promise<{ entries: FileEntry[] }>;
  readFile(path: string, options?: { offset?: number; limit?: number }): Promise<FileData>;
  /** Plaintext content — encoded to base64 before hitting the wire. */
  writeFile(path: string, content: string): Promise<{ path: string; written: number }>;
  deleteFile(path: string, recursive?: boolean): Promise<{ path: string; success: boolean }>;
  createDir(path: string): Promise<{ path: string; success: boolean }>;
  renameFile(from: string, to: string): Promise<{ from: string; to: string; success: boolean }>;
  getCwd(sessionId: string): Promise<{ path: string }>;
  uploadFile(path: string, file: File): Promise<{ path: string; written: number }>;
  base64Decode(b64: string): string;
  base64Encode(s: string): string;
}

/** Handle returned by {@link readFileChunked}: cancel aborts further reads. */
export interface ChunkedReadResult {
  cancel: () => void;
  promise: Promise<string>;
}
