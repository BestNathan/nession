// Public snapshot runtime validation surface. Feature models own their typed
// contracts and route helpers; this module is the single validation entrypoint
// consumed by the independent loaders and tests.
export {
  validKnowledgeSnapshot,
  type KnowledgeSnapshot,
} from '../features/knowledge/model.ts';
export {
  validDocumentsSnapshot,
  type DocumentsSnapshot,
} from '../features/documents/protocol/model.ts';
export {validMcpSnapshot, type McpSnapshot} from '../features/documents/mcp/model.ts';
export {validPrototypeCatalog, type PrototypeCatalog} from '../features/prototypes/model.ts';
import type {SiteSnapshot} from './types.ts';

export function validSiteSnapshot(data: unknown): data is SiteSnapshot {
  const snapshot = data as Partial<SiteSnapshot> | null;
  return snapshot?.schema_version === 1 && Boolean(snapshot.source);
}
