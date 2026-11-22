import type { McpTool } from './types';

/**
 * Pure helpers for the MCP UI kit (#3772).
 *
 * They encode the contract's honesty rules — complete raw JSON, readable
 * fields only where a schema actually says so, no invented output schema, no
 * credential plaintext, bounded rendering — so every component resolves them
 * the same way.
 */

/** A top-level schema property, as the readable view presents it. */
export interface McpSchemaField {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  choices?: readonly string[];
  itemsType?: string;
  defaultValue?: unknown;
}

export interface McpReadableSchema {
  /** `object` when the schema can be read as top-level properties. */
  form: 'object' | 'unsupported';
  fields: readonly McpSchemaField[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Schemas may arrive as an object or as a JSON string (the wire carries a
 * bounded string). Parsing a string is reading, not repairing: a string that
 * does not parse is reported as unreadable instead of guessed.
 */
export function schemaRecord(schema: unknown): Record<string, unknown> | null {
  const direct = asRecord(schema);
  if (direct) {
    return direct;
  }
  if (typeof schema !== 'string' || schema.trim() === '') {
    return null;
  }
  try {
    return asRecord(JSON.parse(schema));
  } catch {
    return null;
  }
}

function typeLabel(property: Record<string, unknown>): string {
  const ref = property.$ref;
  if (typeof ref === 'string' && ref.length > 0) {
    return `$ref ${ref}`;
  }
  const type = property.type;
  if (Array.isArray(type)) {
    return type.map((item) => String(item)).join(' | ') || 'unknown';
  }
  if (typeof type === 'string' && type.length > 0) {
    return type;
  }
  if (asRecord(property.properties)) {
    return 'object';
  }
  if (property.items !== undefined) {
    return 'array';
  }
  return 'unknown';
}

/**
 * The readable projection of a JSON Schema: top-level properties, their types,
 * required marks and simple constraints. Unknown keywords stay in Raw; they
 * are never dropped from the schema the user can inspect.
 */
export function readSchema(schema: unknown): McpReadableSchema {
  const record = schemaRecord(schema);
  if (!record) {
    return { form: 'unsupported', fields: [] };
  }
  const properties = asRecord(record.properties);
  if (!properties) {
    return { form: 'unsupported', fields: [] };
  }
  const required = new Set(
    Array.isArray(record.required)
      ? record.required.filter((name): name is string => typeof name === 'string')
      : [],
  );
  const fields: McpSchemaField[] = Object.entries(properties).map(([name, raw]) => {
    const property = asRecord(raw) ?? {};
    const items = asRecord(property.items);
    return {
      name,
      type: typeLabel(property),
      ...(typeof property.description === 'string'
        ? { description: property.description }
        : {}),
      required: required.has(name),
      ...(Array.isArray(property.enum)
        ? { choices: property.enum.map((value) => String(value)) }
        : {}),
      ...(items && typeof items.type === 'string' ? { itemsType: items.type } : {}),
      ...(property.default !== undefined ? { defaultValue: property.default } : {}),
    };
  });
  return { form: 'object', fields };
}

/** Whether the Tool advertises an output schema at all. */
export function hasOutputSchema(tool: McpTool): boolean {
  return tool.outputSchema !== undefined && tool.outputSchema !== null;
}

/** One property's declared constraint, checked at the field that owns it. */
function propertyError(
  name: string,
  property: Record<string, unknown>,
  value: unknown,
): string | null {
  const type = property.type;
  if (type === 'integer' && !Number.isInteger(value)) {
    return `${name} must be an integer`;
  }
  if (type === 'number' && typeof value !== 'number') {
    return `${name} must be a number`;
  }
  if (type === 'string' && typeof value !== 'string') {
    return `${name} must be a string`;
  }
  if (type === 'boolean' && typeof value !== 'boolean') {
    return `${name} must be true or false`;
  }
  if (Array.isArray(property.enum) && !property.enum.includes(value)) {
    return `${name} has an unsupported value`;
  }
  if (
    typeof property.minimum === 'number' &&
    typeof value === 'number' &&
    value < property.minimum
  ) {
    return `${name} must be at least ${property.minimum}`;
  }
  return null;
}

/**
 * Validate a draft against the Tool's readable input schema.
 *
 * Only the constraints the readable view states are enforced. Unknown
 * arguments are preserved by the JSON draft and are not rejected here; the
 * provider owns the authoritative check.
 */
export function validateArguments(
  tool: McpTool,
  args: Record<string, unknown>,
): string | null {
  const schema = schemaRecord(tool.inputSchema);
  if (!schema) {
    return null;
  }
  const properties = asRecord(schema.properties) ?? {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : [];
  for (const name of required) {
    const value = args[name];
    if (value === undefined || value === null || value === '') {
      return `Required: ${name}`;
    }
  }
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    const property = asRecord(properties[name]);
    if (!property) {
      continue;
    }
    const error = propertyError(name, property, value);
    if (error) {
      return error;
    }
  }
  return null;
}

/** Parse the JSON draft into the arguments object a call would receive. */
export function parseArgumentsDraft(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON: ${error instanceof Error ? error.message : 'could not parse'}`,
    };
  }
  const record = asRecord(parsed);
  if (!record) {
    return { ok: false, error: 'Arguments must be a JSON object' };
  }
  return { ok: true, value: record };
}

const SECRET_KEY =
  /^(?:authorization|bearer|auth|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd|credentials?|api[-_]?key|x-api-key|private[-_]?key)$/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

export interface RedactionResult {
  value: unknown;
  redacted: boolean;
}

/**
 * Remove credential values from a structured payload before it is rendered or
 * kept in local history. Keys stay (their presence is a fact); values become a
 * marker. This is a display guard, not the owner of credential handling — the
 * provider still must not send secrets.
 */
export function redactSecrets(value: unknown): RedactionResult {
  let redacted = false;
  const walk = (item: unknown, key?: string): unknown => {
    if (key !== undefined && isSecretKey(key)) {
      redacted = true;
      return '[redacted]';
    }
    if (Array.isArray(item)) {
      return item.map((entry) => walk(entry));
    }
    const record = asRecord(item);
    if (record) {
      return Object.fromEntries(
        Object.entries(record).map(([entryKey, entry]) => [entryKey, walk(entry, entryKey)]),
      );
    }
    return item;
  };
  return { value: walk(value), redacted };
}

/**
 * Redact obvious bearer tokens and `"token": "…"` shapes from free text (a
 * content block is text, so it has no key to inspect).
 */
export function redactText(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  // Key/value shapes first, including a Bearer prefix so one replacement
  // covers `Authorization: Bearer <token>` without redacting the prefix twice.
  const next = text
    .replace(
      /("?[A-Za-z_-]*(?:token|secret|password|authorization|api[-_]?key)"?\s*[:=]\s*"?(?:Bearer\s+)?)[^"\s,}[]{6,}/gi,
      (_match: string, prefix: string) => {
        redacted = true;
        return `${prefix}[redacted]`;
      },
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, (_match: string, prefix: string) => {
      redacted = true;
      return `${prefix}[redacted]`;
    });
  return { text: next, redacted };
}

export interface BoundedText {
  text: string;
  truncated: boolean;
}

/** Pretty JSON, bounded to a readable size. Absence prints as `null`. */
export function boundedJson(value: unknown, limit = 20_000): BoundedText {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    text = String(value);
  }
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, limit)}\n… truncated (${text.length - limit} characters not shown)`,
    truncated: true,
  };
}

/** A Tool's contract is honest about a missing output schema. */
export function outputSchemaNote(tool: McpTool): string {
  return hasOutputSchema(tool)
    ? ''
    : 'Output schema not advertised by this external Tool. A runtime result is not a schema.';
}

/** The argument defaults a form mode may prefill. */
export function defaultArguments(tool: McpTool): Record<string, unknown> {
  const schema = schemaRecord(tool.inputSchema);
  const properties = schema ? asRecord(schema.properties) : null;
  if (!properties) {
    return {};
  }
  const values: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(properties)) {
    const property = asRecord(raw);
    if (property?.default !== undefined) {
      values[name] = property.default;
    }
  }
  return values;
}

/** Human copy for the adapter's scope list; never a second source of scopes. */
export function scopeLabel(scope: string): string {
  switch (scope) {
    case 'user':
      return 'User';
    case 'local':
      return 'Local';
    case 'project':
      return 'Project';
    default:
      return scope;
  }
}

export function transportLabel(transport: string): string {
  switch (transport) {
    case 'http':
      return 'Streamable HTTP';
    case 'stdio':
      return 'stdio';
    case 'sse':
      return 'SSE (legacy)';
    default:
      return transport;
  }
}

export function credentialLabel(credential: string): string {
  switch (credential) {
    case 'bound':
      return 'Credential reference bound';
    case 'missing':
      return 'Credential unavailable';
    case 'not_required':
      return 'No credential required';
    default:
      return 'Credential state unknown';
  }
}
