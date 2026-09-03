import type { AgentSocketClient } from '@/services/socket/AgentSocketClient';
import type { MessageRouter } from '@/services/socket/types';
import {
  base64Decode,
  base64Encode,
  type FileEntry,
  type FileData,
  type FileOps,
} from '@/services/fileOps';

const MIN_RESPONSE_TIMEOUT_MS = 5000;

function adjustedTimeout(requestedMs: number, elapsedMs: number): number {
  return Math.max(MIN_RESPONSE_TIMEOUT_MS, requestedMs - elapsedMs);
}

/**
 * File domain API on top of MessageRouter.request — no manual correlation.
 */
export class FileCapability {
  constructor(private readonly router: MessageRouter & Pick<AgentSocketClient, 'waitForConnection'>) {}

  async listDir(path: string): Promise<{ entries: FileEntry[] }> {
    return this.request('file.list', { path });
  }

  async readFile(path: string, options?: { offset?: number; limit?: number }): Promise<FileData> {
    return this.request('file.read', { path, ...options });
  }

  async writeFile(path: string, contentB64: string): Promise<{ path: string; written: number }> {
    return this.request('file.write', { path, content: contentB64 });
  }

  async deleteFile(path: string, recursive = false): Promise<{ path: string; success: boolean }> {
    return this.request('file.delete', { path, recursive });
  }

  async createDir(path: string): Promise<{ path: string; success: boolean }> {
    return this.request('file.create_dir', { path });
  }

  async renameFile(from: string, to: string): Promise<{ from: string; to: string; success: boolean }> {
    return this.request('file.rename', { from, to });
  }

  async getCwd(sessionId: string): Promise<{ path: string }> {
    return this.request('file.cwd', { session_id: sessionId });
  }

  toFileOps(): FileOps {
    return {
      listDir: (path) => this.listDir(path),
      readFile: (path, options) => this.readFile(path, options),
      writeFile: (path, content) => this.writeFile(path, base64Encode(content)).then((r) => r),
      deleteFile: (path, recursive) => this.deleteFile(path, recursive),
      createDir: (path) => this.createDir(path),
      renameFile: (from, to) => this.renameFile(from, to),
      getCwd: (sessionId) => this.getCwd(sessionId),
      uploadFile: (path, file) => {
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
      },
      base64Decode,
      base64Encode,
    };
  }

  private async request<T>(type: string, payload: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const start = Date.now();
    await this.router.waitForConnection(timeoutMs);
    const elapsed = Date.now() - start;
    return this.router.request<T>(type, payload, { timeoutMs: adjustedTimeout(timeoutMs, elapsed) });
  }
}
