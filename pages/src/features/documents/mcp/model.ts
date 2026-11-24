// Public source-generated MCP Documents contract. No runtime MCP calls,
// credentials, dynamic HTML or copied Tool definitions.
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
export const MCP_NAME = /^[a-z][a-z0-9_]{1,127}$/;

export interface JsonSchema {
  [key: string]: unknown;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  $ref?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

export interface McpStableRelease {
  version: string;
  sha: string;
  changelog_blob_sha: string;
  changelog_sha256: string;
  release_url: string;
  source_url: string;
  previous_version?: string | null;
  highlights: string[];
}

export interface McpSnapshot {
  schema_version: number;
  status: 'available';
  semantic_sha256: string;
  protocol_versions: string[];
  source: {repository: string; branch: string; sha: string};
  upstream: {stable: McpStableRelease};
  tools: McpTool[];
}

export interface McpField {
  path: string;
  type: string;
  required: boolean;
  description: string;
  values: string;
}

export interface McpToolRoute {
  name: string | null;
  invalid: boolean;
}

export const MCP_UPSTREAM = 'https://github.com/modelcontextprotocol/modelcontextprotocol';

export function validMcpSnapshot(data: unknown): data is McpSnapshot {
  const snapshot = data as Partial<McpSnapshot> | null;
  const stable = snapshot?.upstream?.stable;
  return (
    snapshot?.schema_version === 2 &&
    snapshot?.status === 'available' &&
    DIGEST.test(snapshot.semantic_sha256 || '') &&
    snapshot.source?.repository === 'BestNathan/nession' &&
    snapshot.source?.branch === 'main' &&
    SHA.test(snapshot.source?.sha || '') &&
    Array.isArray(snapshot.protocol_versions) &&
    snapshot.protocol_versions.length > 0 &&
    snapshot.protocol_versions.every((version) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(version)) &&
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(stable?.version || '') &&
    SHA.test(stable?.sha || '') &&
    DIGEST.test(stable?.changelog_sha256 || '') &&
    stable?.release_url === MCP_UPSTREAM + '/releases/tag/' + stable?.version &&
    stable?.source_url ===
      MCP_UPSTREAM + '/blob/' + stable?.sha + '/docs/specification/' + stable?.version + '/changelog.mdx' &&
    Array.isArray(stable?.highlights) &&
    stable.highlights.length <= 6 &&
    stable.highlights.every((highlight) => typeof highlight === 'string' && highlight.length <= 300) &&
    Array.isArray(snapshot.tools) &&
    snapshot.tools.length > 0 &&
    snapshot.tools.length <= 256 &&
    new Set(snapshot.tools.map((tool) => tool.name)).size === snapshot.tools.length &&
    snapshot.tools.every(
      (tool) =>
        MCP_NAME.test(tool?.name || '') &&
        typeof tool.description === 'string' &&
        tool.description.length <= 4000 &&
        tool.inputSchema?.type === 'object' &&
        JSON.stringify(tool.inputSchema).length <= 50000 &&
        tool.outputSchema?.type === 'object' &&
        !Array.isArray(tool.outputSchema) &&
        tool.outputSchema.properties &&
        typeof tool.outputSchema.properties === 'object' &&
        !Array.isArray(tool.outputSchema.properties) &&
        Object.keys(tool.outputSchema.properties).length > 0 &&
        JSON.stringify(tool.outputSchema).length <= 50000,
    )
  );
}

// A bounded, read-only renderer for public JSON Schema. Only local refs
// resolve; ambiguous unions remain explicit rather than invented contracts.
const MAX_FIELDS = 160;
const MAX_DEPTH = 9;
const has = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

function localSchemaRef(root: JsonSchema, ref: unknown): JsonSchema | null {
  if (typeof ref !== 'string' || !/^#\/(?:\$defs|definitions)\//.test(ref)) return null;
  let value: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || typeof value !== 'object' || Array.isArray(value) || !has(value, key)) return null;
    value = (value as Record<string, unknown>)[key];
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonSchema) : null;
}

function deref(
  root: JsonSchema,
  node: JsonSchema,
  refs: Set<string>,
): {node: JsonSchema; refs: Set<string>; unresolved: boolean} {
  let item = node;
  const trail = new Set(refs);
  let depth = 0;
  while (item && typeof item === 'object' && typeof item.$ref === 'string' && depth++ < MAX_DEPTH) {
    const ref = item.$ref;
    if (trail.has(ref)) return {node: item, refs: trail, unresolved: true};
    const resolved = localSchemaRef(root, ref);
    if (!resolved) return {node: item, refs: trail, unresolved: true};
    trail.add(ref);
    const overlay: JsonSchema = {...item};
    delete overlay.$ref;
    item = {...resolved, ...overlay};
  }
  return {node: item, refs: trail, unresolved: false};
}

function fieldType(root: JsonSchema, node: JsonSchema, refs = new Set<string>(), depth = 0): string {
  if (!node || typeof node !== 'object') return 'unknown';
  if (depth > MAX_DEPTH) return 'recursive';
  const resolved = deref(root, node, refs);
  if (resolved.unresolved) return 'unresolved reference';
  const item = resolved.node;
  const explicit = Array.isArray(item.type) ? item.type.join(' | ') : item.type;
  if (typeof explicit === 'string') return explicit;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const union = item[key];
    if (Array.isArray(union)) {
      const types = [...new Set(union.slice(0, 20).map((value) => fieldType(root, value, resolved.refs, depth + 1)))];
      return types.join(' | ') || 'union';
    }
  }
  if (Array.isArray(item.enum)) return 'enum';
  if (item.properties && typeof item.properties === 'object') return 'object';
  return 'unknown';
}

export function mcpSchemaFields(schema: JsonSchema | null | undefined): McpField[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const root = schema;
  const fields: McpField[] = [];
  function walk(node: JsonSchema, prefix = '', depth = 0, refs = new Set<string>()): void {
    if (depth > MAX_DEPTH || fields.length >= MAX_FIELDS) return;
    const parsed = deref(root, node, refs);
    if (parsed.unresolved) return;
    const item = parsed.node;
    const props = item.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      const required = new Set(Array.isArray(item.required) ? item.required : []);
      for (const [name, property] of Object.entries(props)) {
        if (fields.length >= MAX_FIELDS) break;
        if (!property || typeof property !== 'object' || name.length > 128) continue;
        const path = prefix ? prefix + '.' + name : name;
        if (path.length > 240) continue;
        const resolvedProperty = deref(root, property, parsed.refs);
        const resolved = resolvedProperty.node;
        const description = (
          typeof property.description === 'string'
            ? property.description
            : typeof resolved?.description === 'string'
              ? resolved.description
              : ''
        ).slice(0, 2500);
        const type = fieldType(root, property, parsed.refs);
        const values =
          Array.isArray(resolved?.enum) && resolved.enum.length <= 16
            ? resolved.enum.map((value) => JSON.stringify(value)).join(', ').slice(0, 500)
            : '';
        fields.push({path, type, required: required.has(name), description, values});
        if (!resolvedProperty.unresolved) {
          walk(resolved, path, depth + 1, resolvedProperty.refs);
          if (resolved?.items && typeof resolved.items === 'object') {
            walk(resolved.items, path + '[]', depth + 1, resolvedProperty.refs);
          }
        }
      }
    } else if (!prefix && item?.items && typeof item.items === 'object') {
      walk(item.items, '[]', depth + 1, parsed.refs);
    }
  }
  walk(schema);
  return fields;
}

export function mcpToolRoute(hash: string): McpToolRoute | null {
  const raw = String(hash || '').replace(/^#/, '');
  if (!/^\/documents\/mcp(?:\?|$)/.test(raw)) return null;
  const params = new URLSearchParams(raw.split('?')[1] || '');
  if ([...params.keys()].some((key) => key !== 'tool') || params.getAll('tool').length > 1) {
    return {name: null, invalid: true};
  }
  const name = params.get('tool');
  return {name, invalid: name !== null && !MCP_NAME.test(name)};
}
