import type { CapabilityPlugin, PluginSurface } from '@/services/socket/types';
import type { ChunkedReadResult, FileData, FileEntry, FileOps } from './types';

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
  writeFile(path: string, contentB64: string): Promise<{ path: string; written: number }>;
  deleteFile(path: string, recursive?: boolean): Promise<{ path: string; success: boolean }>;
  createDir(path: string): Promise<{ path: string; success: boolean }>;
  renameFile(from: string, to: string): Promise<{ from: string; to: string; success: boolean }>;
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

/**
 * Read a text file in chunks via repeated `file.read` requests with offset/limit.
 * Returns a handle with a `promise` that resolves to the full decoded text, plus
 * a `cancel` callback that aborts further reads. Progress is reported via the
 * optional callback with (loadedBytes, totalBytes).
 *
 * The offset advances by the decoded chunk length rather than the raw base64
 * size so the backend can answer with the same byte semantics regardless of
 * transport encoding.
 */
export function readFileChunked(
  fileOps: FileOps,
  path: string,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): ChunkedReadResult {
  let cancelled = false;

  const promise = (async () => {
    const chunks: string[] = [];
    let offset = 0;
    let totalSize = 0;
    let hasMore = true;

    while (hasMore) {
      if (cancelled) {
        throw new DOMException('Read cancelled', 'AbortError');
      }

      const data = await fileOps.readFile(path, { offset, limit: DEFAULT_CHUNK_SIZE });
      totalSize = data.total_size ?? 0;
      const decoded = fileOps.base64Decode(data.content);
      chunks.push(decoded);
      offset += decoded.length;

      onProgress?.(offset, totalSize);
      hasMore = Boolean(data.has_more);
    }

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
 * Files capability plugin — speaks the `file.*` request family. No
 * install-time subscriptions: every method is a plain request, so a binding
 * is exactly "the surface used for requests".
 */
export class FilesPlugin implements CapabilityPlugin, FileApi {
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
    return this.request('file.list', { path });
  }

  readFile(path: string, options?: { offset?: number; limit?: number }): Promise<FileData> {
    return this.request('file.read', { path, ...options });
  }

  writeFile(path: string, contentB64: string): Promise<{ path: string; written: number }> {
    return this.request('file.write', { path, content: contentB64 });
  }

  deleteFile(path: string, recursive = false): Promise<{ path: string; success: boolean }> {
    return this.request('file.delete', { path, recursive });
  }

  createDir(path: string): Promise<{ path: string; success: boolean }> {
    return this.request('file.create_dir', { path });
  }

  renameFile(from: string, to: string): Promise<{ from: string; to: string; success: boolean }> {
    return this.request('file.rename', { from, to });
  }

  getCwd(sessionId: string): Promise<{ path: string }> {
    return this.request('file.cwd', { session_id: sessionId });
  }

  /** Read a local file and upload its base64 content as `file.write`. */
  uploadFile(path: string, file: File): Promise<{ path: string; written: number }> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const content = reader.result as string;
        const b64 = content.split(',')[1];
        this.writeFile(path, b64).then(resolve).catch(reject);
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
      writeFile: (path, content) => this.writeFile(path, base64Encode(content)),
      deleteFile: (path, recursive) => this.deleteFile(path, recursive),
      createDir: (path) => this.createDir(path),
      renameFile: (from, to) => this.renameFile(from, to),
      getCwd: (sessionId) => this.getCwd(sessionId),
      uploadFile: (path, file) => this.uploadFile(path, file),
      base64Decode,
      base64Encode,
    };
  }

  private async request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
    const connection = this.connection;
    if (!connection) {
      throw new Error('files feature is not connected');
    }
    return connection.request<T>(type, payload);
  }
}

/** A fresh files binding — the capability is per-consumer, so no singleton. */
export function createFilesApi(): FilesPlugin {
  return new FilesPlugin();
}
