import { WIRE as FILE_CREATE_DIR_WIRE } from '@/generated/protocol/core/agent-file-create-dir/v1';
import { WIRE as FILE_CWD_WIRE } from '@/generated/protocol/core/agent-file-cwd/v1';
import { WIRE as FILE_DELETE_WIRE } from '@/generated/protocol/core/agent-file-delete/v1';
import { WIRE as FILE_LIST_WIRE } from '@/generated/protocol/core/agent-file-list/v1';
import { WIRE as FILE_READ_WIRE } from '@/generated/protocol/core/agent-file-read/v1';
import { WIRE as FILE_RENAME_WIRE } from '@/generated/protocol/core/agent-file-rename/v1';
import { WIRE as FILE_WRITE_WIRE } from '@/generated/protocol/core/agent-file-write/v1';
import type { TransportPlugin, PluginSurface } from '@/platform/socket/types';
import type {
  ChunkedReadResult,
  CreateDirOptions,
  FileData,
  FileEntry,
  FileOps,
  RenameFileOptions,
  WriteFileOptions,
} from './types';

/**
 * Typed file capability — the 7 `file.*` requests. Ported from
 * `runtime/FileCapability.ts` without the per-request `waitForConnection`
 * pre-step (connection gating became a surface/runtime concern in the
 * plugin-model refactor; the wire and the request semantics are unchanged).
 */
export interface FileApi {
  listDir(path: string): Promise<{ entries: FileEntry[] }>;
  readFile(path: string, options?: { offset?: number; limit?: number }): Promise<FileData>;
  /** Base64-encoded content — passed to the wire as-is. */
  writeFile(
    path: string,
    contentB64: string,
    options?: WriteFileOptions,
  ): Promise<{ path: string; written: number; revision?: string }>;
  deleteFile(path: string, recursive?: boolean): Promise<{ path: string; success: boolean }>;
  createDir(
    path: string,
    options?: CreateDirOptions,
  ): Promise<{ path: string; success: boolean }>;
  renameFile(
    from: string,
    to: string,
    options?: RenameFileOptions,
  ): Promise<{ from: string; to: string; success: boolean }>;
  getCwd(sessionId: string): Promise<{ path: string }>;
}

// --- Helpers (feature-owned copies of the legacy `services/fileOps.ts` helpers) ---

export function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64Decode(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/** Default chunk size — 256 KB keeps each request snappy on slow P2P links. */
export const DEFAULT_CHUNK_SIZE = 256 * 1024;

/** Decode base64 to raw bytes, without interpreting them as text. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Read a text file in chunks via repeated `file.read` requests with offset/limit.
 * Returns a handle with a `promise` that resolves to the full decoded text, plus
 * a `cancel` callback that aborts further reads. Progress is reported via the
 * optional callback with (loadedBytes, totalBytes).
 *
 * The offset advances by the raw byte count of each chunk, never by the length
 * of the decoded JavaScript string: a multi-byte UTF-8 sequence is one byte
 * count but one or two UTF-16 code units. A streaming `TextDecoder` carries a
 * sequence split across a chunk boundary into the next chunk instead of emitting
 * a replacement character for each half.
 */
export function readFileChunked(
  fileOps: FileOps,
  path: string,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): ChunkedReadResult {
  let cancelled = false;

  const promise = (async () => {
    const chunks: string[] = [];
    const decoder = new TextDecoder('utf-8');
    let offset = 0;
    let totalSize = 0;
    let hasMore = true;

    while (hasMore) {
      if (cancelled) {
        throw new DOMException('Read cancelled', 'AbortError');
      }

      const data = await fileOps.readFile(path, { offset, limit: DEFAULT_CHUNK_SIZE });
      totalSize = data.total_size ?? 0;
      const bytes = base64ToBytes(data.content);
      // An empty non-final chunk would spin this loop forever. Refuse it
      // rather than silently returning a truncated document.
      if (bytes.length === 0 && data.has_more) {
        throw new Error('File read returned an empty chunk while more data remained');
      }
      chunks.push(decoder.decode(bytes, { stream: true }));
      offset += bytes.length;

      onProgress?.(offset, totalSize);
      hasMore = Boolean(data.has_more);
    }

    chunks.push(decoder.decode());
    return chunks.join('');
  })();

  return {
    cancel: () => {
      cancelled = true;
    },
    promise,
  };
}

/**
 * Files transport plugin — speaks the `file.*` request family. No
 * install-time subscriptions: every method is a plain request, so a binding
 * is exactly "the surface used for requests".
 */
export class FilesPlugin implements TransportPlugin, FileApi {
  readonly name = 'files';

  private connection: PluginSurface | null = null;
  private generation = 0;

  install(connection: PluginSurface): () => void {
    const generation = ++this.generation;
    this.connection = connection;
    return () => {
      if (this.generation === generation && this.connection === connection) {
        this.connection = null;
      }
    };
  }

  listDir(path: string): Promise<{ entries: FileEntry[] }> {
    return this.request(FILE_LIST_WIRE, { path });
  }

  readFile(path: string, options?: { offset?: number; limit?: number }): Promise<FileData> {
    return this.request(FILE_READ_WIRE, { path, ...options });
  }

  writeFile(
    path: string,
    contentB64: string,
    options?: WriteFileOptions,
  ): Promise<{ path: string; written: number; revision?: string }> {
    return this.request(FILE_WRITE_WIRE, {
      path,
      content: contentB64,
      expected_revision: options?.expectedRevision,
      create_only: options?.createOnly ?? false,
    });
  }

  deleteFile(path: string, recursive = false): Promise<{ path: string; success: boolean }> {
    return this.request(FILE_DELETE_WIRE, { path, recursive });
  }

  createDir(
    path: string,
    options?: CreateDirOptions,
  ): Promise<{ path: string; success: boolean }> {
    return this.request(FILE_CREATE_DIR_WIRE, {
      path,
      create_only: options?.createOnly ?? false,
    });
  }

  renameFile(
    from: string,
    to: string,
    options?: RenameFileOptions,
  ): Promise<{ from: string; to: string; success: boolean }> {
    return this.request(FILE_RENAME_WIRE, {
      from,
      to,
      no_replace: options?.noReplace ?? false,
    });
  }

  getCwd(sessionId: string): Promise<{ path: string }> {
    return this.request(FILE_CWD_WIRE, { session_id: sessionId });
  }

  /**
   * Read a local file and upload its base64 content as `file.write`.
   *
   * Uploads default to `createOnly`, so a file picked for upload cannot
   * silently replace an existing Workspace file with the same name.
   */
  uploadFile(
    path: string,
    file: File,
    options?: { createOnly?: boolean },
  ): Promise<{ path: string; written: number; revision?: string }> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const content = reader.result as string;
        const b64 = content.split(',')[1];
        this.writeFile(path, b64, { createOnly: options?.createOnly ?? true })
          .then(resolve)
          .catch(reject);
      };
      reader.onerror = () => reject(new Error('Failed to read file for upload'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Legacy FileOps adapter — encodes plaintext writes (the old shape's
   * contract) so callers of the pre-refactor `services/fileOps.ts` API can
   * keep their call sites while the transport migrates.
   */
  toFileOps(): FileOps {
    return {
      listDir: (path) => this.listDir(path),
      readFile: (path, options) => this.readFile(path, options),
      writeFile: (path, content, options) =>
        this.writeFile(path, base64Encode(content), options),
      deleteFile: (path, recursive) => this.deleteFile(path, recursive),
      createDir: (path, options) => this.createDir(path, options),
      renameFile: (from, to, options) => this.renameFile(from, to, options),
      getCwd: (sessionId) => this.getCwd(sessionId),
      uploadFile: (path, file, options) => this.uploadFile(path, file, options),
      base64Decode,
      base64Encode,
    };
  }

  private async request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
    const connection = this.connection;
    if (!connection) {
      throw new Error('files feature is not connected');
    }
    // not-protocol: the pass-through. Every caller names a wire, and those
    // are the sites the protocol gate reads.
    return connection.request<T>(type, payload);
  }
}

/** A fresh files binding — the capability is per-consumer, so no singleton. */
export function createFilesApi(): FilesPlugin {
  return new FilesPlugin();
}
