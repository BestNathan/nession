import type { WebSocketService } from '@/services/websocket';
import type {
  ConfigFile,
  ClaudeCodeListRequest,
  ClaudeCodeListResponse,
  ClaudeCodeReadRequest,
  ClaudeCodeReadResponse,
} from '../types';

export function createClaudeCodeService(ws: WebSocketService) {
  return {
    async list(req: ClaudeCodeListRequest): Promise<ClaudeCodeListResponse> {
      const resp = await ws.claudeCodeList(req);
      return {
        available: resp.available,
        categories: (resp.categories || []).map((cat) => ({
          ...cat,
          files: cat.files.map((f) => ({
            path: f.path,
            size: f.size,
            content_type: f.content_type as ConfigFile['content_type'],
          })),
        })),
        error: resp.error,
      } as ClaudeCodeListResponse;
    },

    async read(req: ClaudeCodeReadRequest): Promise<ClaudeCodeReadResponse> {
      const resp = await ws.claudeCodeRead(req);
      return resp as ClaudeCodeReadResponse;
    },
  };
}

export type ClaudeCodeService = ReturnType<typeof createClaudeCodeService>;
