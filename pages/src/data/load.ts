// Independent public snapshot loads. Each source settles on its own and a
// failure never blocks another route or source.
import type {SiteSnapshot} from './types.ts';
import {
  validSiteSnapshot,
  validKnowledgeSnapshot,
  validDocumentsSnapshot,
  validMcpSnapshot,
  validPrototypeCatalog,
  type KnowledgeSnapshot,
  type DocumentsSnapshot,
  type McpSnapshot,
  type PrototypeCatalog,
} from './validation.ts';

export type ResourceStatus = 'loading' | 'available' | 'unavailable';
export interface Resource<T> {
  status: ResourceStatus;
  data: T | null;
}

export interface PagesResources {
  site: Resource<SiteSnapshot>;
  knowledge: Resource<KnowledgeSnapshot>;
  documents: Resource<DocumentsSnapshot>;
  mcp: Resource<McpSnapshot>;
  prototypes: Resource<PrototypeCatalog>;
}

const loading = <T,>(): Resource<T> => ({status: 'loading', data: null});

export function initialResources(): PagesResources {
  return {
    site: loading(),
    knowledge: loading(),
    documents: loading(),
    mcp: loading(),
    prototypes: loading(),
  };
}

export interface LoadOptions {
  baseURI: string;
  fetchImpl?: typeof fetch;
}

async function fetchJson(url: URL, timeoutMs: number | null, cache: RequestCache, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    cache,
    signal: timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('snapshot unavailable');
  return response.json();
}

export async function loadSiteResource({baseURI, fetchImpl = fetch}: LoadOptions): Promise<Resource<SiteSnapshot>> {
  const result = await fetchJson(new URL('data/site.json', baseURI), 15000, 'no-cache', fetchImpl);
  if (!validSiteSnapshot(result)) throw new Error('invalid schema');
  return {status: 'available', data: result};
}

export async function loadKnowledgeResource({baseURI, fetchImpl = fetch}: LoadOptions): Promise<Resource<KnowledgeSnapshot>> {
  const result = await fetchJson(new URL('data/knowledge.json', baseURI), 15000, 'no-cache', fetchImpl);
  if (!validKnowledgeSnapshot(result)) throw new Error('Invalid public Knowledge snapshot');
  return {status: result.status === 'available' ? 'available' : 'unavailable', data: result};
}

export async function loadDocumentsResource({baseURI, fetchImpl = fetch}: LoadOptions): Promise<Resource<DocumentsSnapshot>> {
  const result = await fetchJson(new URL('data/documents.json', baseURI), 15000, 'no-cache', fetchImpl);
  if (!validDocumentsSnapshot(result)) throw new Error('Invalid public Documents snapshot');
  return {status: result.status === 'available' ? 'available' : 'unavailable', data: result};
}

export async function loadMcpResource({baseURI, fetchImpl = fetch}: LoadOptions): Promise<Resource<McpSnapshot>> {
  const result = await fetchJson(new URL('data/mcp.json', baseURI), 15000, 'no-cache', fetchImpl);
  if (!validMcpSnapshot(result)) throw new Error('Invalid public MCP catalog');
  return {status: 'available', data: result};
}

export async function loadPrototypeResource({baseURI, fetchImpl = fetch}: LoadOptions): Promise<Resource<PrototypeCatalog>> {
  const result = await fetchJson(new URL('prototypes/manifest.json', baseURI), null, 'no-cache', fetchImpl);
  if (!validPrototypeCatalog(result)) throw new Error('Prototype manifest validation failed');
  return {status: 'available', data: result};
}
