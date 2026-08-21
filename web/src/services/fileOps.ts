import type { P2PConnection } from '../hooks/useP2PConnection';

/**
 * Minimal transport slice fileOps needs from a P2PConnection. These three
 * methods are useCallback-stable for the connection's lifetime, so memoizing
 * fileOps on them (rather than the whole connection object, whose
 * connectionState field mutates every render) keeps its identity stable.
 */
export type FileTransport = Pick<
  P2PConnection,
  'sendMessage' | 'onMessage' | 'waitForConnection'
>;

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

/**
 * Minimum response timeout floor after accounting for P2P connection setup.
 * Even when the handshake consumes most of the total budget, the server still
 * needs a reasonable window to read/transfer the file after we send the
 * request. 5s is enough for most file sizes without doubling the total wait
 * (the old 1s floor was too tight for large files over slow links). (#71 #8)
 */
const MIN_RESPONSE_TIMEOUT_MS = 5000;

let msgCounter = 0;
function generateId(): string {
  return `file-${Date.now()}-${++msgCounter}`;
}

function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {binary += String.fromCharCode(bytes[i]);}
  return btoa(binary);
}

function base64Decode(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {bytes[i] = binary.charCodeAt(i);}
  return new TextDecoder().decode(bytes);
}

function sendRequest<T>(
  p2p: FileTransport,
  msgType: string,
  payload: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    // Wait for the transport to be ready before sending. On a fresh attach the
    // P2P socket is still 'connecting', so firing immediately would either drop
    // the frame (readyState !== OPEN) and time out, or reject with
    // "Connection lost" on the initial 'disconnected' state. Queue instead.
    const startTime = Date.now();
    p2p.waitForConnection(timeoutMs).then(() => {
      const elapsed = Date.now() - startTime;
      // Adjust response timeout by elapsed connection time to prevent doubling
      const remainingTimeout = Math.max(MIN_RESPONSE_TIMEOUT_MS, timeoutMs - elapsed);

      const id = generateId();
      const timeout = setTimeout(() => {
        unsub();
        reject(new Error(`File operation timeout: ${msgType}`));
      }, remainingTimeout);

      const unsub = p2p.onMessage((msg) => {
        if (msg.id === id) {
          clearTimeout(timeout);
          unsub();
          if (msg.msg_type === 'error') {
            reject(new Error(((msg.payload as Record<string, unknown>)?.message as string) || `File operation failed: ${msgType}`));
          } else {
            resolve(msg.payload as T);
          }
        }
      });

      p2p.sendMessage({
        msg_type: msgType,
        id,
        timestamp: Math.floor(Date.now() / 1000),
        payload,
      });
    }).catch(reject);
  });
}

// --- Public API ---

export function createFileOps(p2p: FileTransport) {
  return {
    listDir: (path: string): Promise<{ entries: FileEntry[] }> =>
      sendRequest(p2p, 'file.list', { path }),

    readFile: (path: string, options?: { offset?: number; limit?: number }): Promise<FileData> =>
      sendRequest(p2p, 'file.read', { path, ...options }),

    writeFile: (path: string, content: string): Promise<{ path: string; written: number }> =>
      sendRequest(p2p, 'file.write', { path, content: base64Encode(content) }),

    /**
     * Delete a file, or a directory. Pass `recursive` for a directory that may
     * have contents — without it the agent only removes an empty one.
     */
    deleteFile: (path: string, recursive = false): Promise<{ path: string; success: boolean }> =>
      sendRequest(p2p, 'file.delete', { path, recursive }),

    createDir: (path: string): Promise<{ path: string; success: boolean }> =>
      sendRequest(p2p, 'file.create_dir', { path }),

    renameFile: (from: string, to: string): Promise<{ from: string; to: string; success: boolean }> =>
      sendRequest(p2p, 'file.rename', { from, to }),

    getCwd: (sessionId: string): Promise<{ path: string }> =>
      sendRequest(p2p, 'file.cwd', { session_id: sessionId }),

    uploadFile: (path: string, file: File): Promise<{ path: string; written: number }> => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const content = reader.result as string;
          const b64 = content.split(',')[1];
          sendRequest<{ path: string; written: number }>(p2p, 'file.write', { path, content: b64 })
            .then((result) => resolve(result))
            .catch(reject);
        };
        reader.onerror = () => reject(new Error('Failed to read file for upload'));
        reader.readAsDataURL(file);
      });
    },

    base64Decode,
    base64Encode,
  };
}

export type FileOps = ReturnType<typeof createFileOps>;

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
