import type { MessageRouter } from '@/services/socket/types';

// --- Types ---

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
  content: string; // base64
  mime_type: string;
  /** Byte offset of the returned chunk within the file (chunked reads only). */
  offset?: number;
  /** Total size of the file in bytes (chunked reads only). */
  total_size?: number;
  /** True when the file has more data past this chunk (chunked reads only). */
  has_more?: boolean;
}

// --- Helpers ---

export function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {binary += String.fromCharCode(bytes[i]);}
  return btoa(binary);
}

export function base64Decode(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {bytes[i] = binary.charCodeAt(i);}
  return new TextDecoder().decode(bytes);
}

// --- Public API ---

export function createFileOpsFromRouter(
  router: MessageRouter & { waitForConnection(timeoutMs?: number): Promise<void> },
): FileOps {
  const capability = {
    listDir: (path: string) => router.request<{ entries: FileEntry[] }>('file.list', { path }),
    readFile: (path: string, options?: { offset?: number; limit?: number }) =>
      router.request<FileData>('file.read', { path, ...options }),
    writeFile: (path: string, content: string) =>
      router.request<{ path: string; written: number }>('file.write', { path, content: base64Encode(content) }),
    deleteFile: (path: string, recursive = false) =>
      router.request<{ path: string; success: boolean }>('file.delete', { path, recursive }),
    createDir: (path: string) =>
      router.request<{ path: string; success: boolean }>('file.create_dir', { path }),
    renameFile: (from: string, to: string) =>
      router.request<{ from: string; to: string; success: boolean }>('file.rename', { from, to }),
    getCwd: (sessionId: string) =>
      router.request<{ path: string }>('file.cwd', { session_id: sessionId }),
    uploadFile: (path: string, file: File) => {
      return new Promise<{ path: string; written: number }>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const content = reader.result as string;
          const b64 = content.split(',')[1];
          router.request<{ path: string; written: number }>('file.write', { path, content: b64 })
            .then(resolve)
            .catch(reject);
        };
        reader.onerror = () => reject(new Error('Failed to read file for upload'));
        reader.readAsDataURL(file);
      });
    },
    base64Decode,
    base64Encode,
  };
  return capability;
}

export interface FileOps {
  listDir(path: string): Promise<{ entries: FileEntry[] }>;
  readFile(path: string, options?: { offset?: number; limit?: number }): Promise<FileData>;
  writeFile(path: string, content: string): Promise<{ path: string; written: number }>;
  deleteFile(path: string, recursive?: boolean): Promise<{ path: string; success: boolean }>;
  createDir(path: string): Promise<{ path: string; success: boolean }>;
  renameFile(from: string, to: string): Promise<{ from: string; to: string; success: boolean }>;
  getCwd(sessionId: string): Promise<{ path: string }>;
  uploadFile(path: string, file: File): Promise<{ path: string; written: number }>;
  base64Decode(b64: string): string;
  base64Encode(s: string): string;
}

// --- Chunked read helper ---

export interface ChunkedReadResult {
  cancel: () => void;
  promise: Promise<string>;
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

  return { cancel: () => { cancelled = true; }, promise };
}
