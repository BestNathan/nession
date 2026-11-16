/**
 * The Claude-specific transcript record decoder (#3726).
 *
 * This is the **one frontend owner** that turns a raw Claude Code JSONL line
 * into a renderable record. The Agent transports original text and byte
 * references only; it does not say what a line means. That split is the reason
 * every physical record can be shown: an unknown type, a malformed line or a
 * line from a future Claude release is still a record, and this decoder has a
 * generic arm for each instead of dropping the line.
 *
 * ## No closed upstream union
 *
 * Claude Code's transcript schema is not a published, stable discriminated
 * union. The decoder therefore reads the fields it knows (`type`, `subtype`,
 * `message.content`, `attachment`) and treats everything else as data. A record
 * this version does not name renders through the `unknown` arm with its own
 * upstream `type`/`subtype` as the row title — not as an "unrecognized" badge.
 *
 * No third-party transcript-schema package is adopted here. The two candidate
 * references named by `#3726` are useful documentation, but pinning one would
 * import its version of a schema upstream has not promised to keep stable, and
 * a strict union is exactly the failure mode this adapter must not have. The
 * decoder is small enough that one audited owner is the lower-risk choice.
 *
 * ## One line, one row
 *
 * A line that carries several content blocks (text, thinking, tool_use,
 * tool_result) stays one record. Its blocks are sub-content *inside* that row,
 * so a `tool_result` is never consumed by an adjacent `tool_use` row: both
 * source lines remain visible and independently inspectable.
 */

/** One content block inside a message record. */
export type ClaudeTranscriptBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; callId: string; name: string; input: string }
  | { kind: 'tool_result'; callId: string; text: string; isError: boolean }
  | { kind: 'image'; mediaType: string | null }
  | { kind: 'other'; blockType: string; preview: string };

/**
 * What a record is drawn as.
 *
 * `unknown` and `invalid` are rendering outcomes, not parser-status badges: the
 * row uses a generic structure and the Raw action, and no label says
 * "unrecognized".
 */
export type ClaudeTranscriptRecordKind =
  | 'user'
  | 'assistant'
  | 'system'
  | 'attachment'
  | 'metadata'
  | 'event'
  | 'unknown'
  | 'invalid';

/** One extra native detail line (a top-level field of the record). */
export interface ClaudeTranscriptField {
  label: string;
  value: string;
}

/** A decoded record, independent of the wire record that carried it. */
export interface ParsedTranscriptRecord {
  kind: ClaudeTranscriptRecordKind;
  /** Upstream `type`, verbatim. */
  type: string | null;
  /** Upstream `subtype`, verbatim. */
  subtype: string | null;
  timestamp: string | null;
  /** The row's own name — never a parser diagnostic. */
  label: string;
  /** A short collapsed-line preview, when the record has one. */
  preview: string | null;
  blocks: ClaudeTranscriptBlock[];
  fields: ClaudeTranscriptField[];
  /** The parsed JSON value, or `null` for malformed input. */
  value: unknown;
  validJson: boolean;
}

/** Session-state record types, mirrored as data rather than a closed union. */
const METADATA_TYPES = new Set([
  'ai-title',
  'last-prompt',
  'mode',
  'permission-mode',
  'pr-link',
  'agent-name',
  'atis-latch',
  'cost-state',
  'worktree-state',
]);

/** Runtime/checkpoint records that are facts, not messages. */
const EVENT_TYPES = new Set([
  'file-history-snapshot',
  'file-history-delta',
  'relocated',
  'continued-in',
  'queue-operation',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Collapse whitespace and bound a label or one-line preview. */
export function collapseText(text: string, max = 180): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** A bounded representation of a JSON value for native detail. */
function compactValue(value: unknown, max = 320): string {
  if (typeof value === 'string') {
    return collapseText(value, max);
  }
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return collapseText(JSON.stringify(value), max);
  } catch {
    return '[a value that cannot be shown]';
  }
}

/** Text carried by a `tool_result` or block `content` field. */
function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const texts = content
      .map((entry) => {
        const block = asRecord(entry);
        return block ? (asString(block.text) ?? asString(block.content)) : null;
      })
      .filter((text): text is string => text !== null);
    if (texts.length > 0) {
      return texts.join('\n');
    }
  }
  return compactValue(content);
}

/** Decode `message.content` into blocks, keeping unmodelled blocks visible. */
function messageBlocks(content: unknown): ClaudeTranscriptBlock[] {
  if (typeof content === 'string') {
    return [{ kind: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((entry): ClaudeTranscriptBlock => {
    const block = asRecord(entry);
    if (!block) {
      return { kind: 'other', blockType: 'block', preview: compactValue(entry) };
    }
    const blockType = asString(block.type) ?? 'block';
    switch (blockType) {
      case 'text':
        return { kind: 'text', text: asString(block.text) ?? '' };
      case 'thinking':
        return {
          kind: 'thinking',
          text: asString(block.thinking) ?? asString(block.text) ?? '',
        };
      case 'tool_use':
        return {
          kind: 'tool_use',
          callId: asString(block.id) ?? '',
          name: asString(block.name) ?? 'tool',
          input: JSON.stringify(block.input ?? null, null, 2),
        };
      case 'tool_result':
        return {
          kind: 'tool_result',
          callId: asString(block.tool_use_id) ?? '',
          text: contentText(block.content),
          isError: block.is_error === true,
        };
      case 'image': {
        const source = asRecord(block.source);
        return { kind: 'image', mediaType: asString(source?.media_type) };
      }
      default:
        return {
          kind: 'other',
          blockType,
          preview: compactValue(block.text ?? block.content ?? block),
        };
    }
  });
}

/** A user envelope that was not authored by the person reading it. */
function userLabel(record: Record<string, unknown>): string {
  const origin = asRecord(record.origin);
  if (
    record.isMeta === true ||
    asString(record.promptSource) === 'system' ||
    asString(origin?.kind) === 'task-notification'
  ) {
    return 'Context';
  }
  return 'You';
}

/** The first meaningful one-line preview of a message's blocks. */
function messagePreview(blocks: ClaudeTranscriptBlock[]): string | null {
  for (const block of blocks) {
    if (block.kind === 'text' && block.text.trim() !== '') {
      return collapseText(block.text);
    }
  }
  for (const block of blocks) {
    if (block.kind === 'thinking' && block.text.trim() !== '') {
      return collapseText(block.text);
    }
  }
  for (const block of blocks) {
    if (block.kind === 'tool_use') {
      const input = block.input.replace(/\s+/g, ' ').trim();
      return collapseText(`${block.name} ${input}`);
    }
  }
  for (const block of blocks) {
    if (block.kind === 'tool_result' && block.text.trim() !== '') {
      return collapseText(block.text);
    }
  }
  return null;
}

/** Top-level fields worth showing as native detail. */
function recordFields(record: Record<string, unknown>): ClaudeTranscriptField[] {
  const fields: ClaudeTranscriptField[] = [];
  for (const [label, value] of Object.entries(record)) {
    if (label === 'type' || label === 'subtype' || label === 'timestamp') {
      continue;
    }
    // `message` and `attachment` are rendered as their own native content.
    if (label === 'message' || label === 'attachment') {
      continue;
    }
    fields.push({ label, value: compactValue(value) });
    if (fields.length >= 14) {
      break;
    }
  }
  return fields;
}

/** The first string leaf worth previewing, excluding envelope metadata. */
function firstStringLeaf(value: unknown, depth = 0): string | null {
  if (depth > 3) {
    return null;
  }
  if (typeof value === 'string') {
    return value.trim() === '' ? null : value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstStringLeaf(entry, depth + 1);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  const record = asRecord(value);
  if (record) {
    for (const [key, entry] of Object.entries(record)) {
      if (['type', 'subtype', 'uuid', 'timestamp', 'sessionId', 'cwd'].includes(key)) {
        continue;
      }
      const found = firstStringLeaf(entry, depth + 1);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/** Native detail for an attachment, including its own payload fields. */
function attachmentFields(attachment: Record<string, unknown>): ClaudeTranscriptField[] {
  return Object.entries(attachment)
    .filter(([label]) => label !== 'type')
    .slice(0, 12)
    .map(([label, value]) => ({ label, value: compactValue(value) }));
}

/**
 * Decode a wire record when the page carried its text; `null` means the record
 * is a placeholder that must be resolved through Raw.
 */
export function parseWireRecord(record: {
  raw?: string | null;
}): ParsedTranscriptRecord | null {
  return typeof record.raw === 'string' ? parseTranscriptRecord(record.raw) : null;
}

/** The generic shape every decoder arm starts from. */
function baseRecord(
  kind: ClaudeTranscriptRecordKind,
  value: unknown,
  validJson: boolean,
): ParsedTranscriptRecord {
  return {
    kind,
    type: null,
    subtype: null,
    timestamp: null,
    label: 'Record',
    preview: null,
    blocks: [],
    fields: [],
    value,
    validJson,
  };
}

interface RecordMeta {
  type: string | null;
  subtype: string | null;
  timestamp: string | null;
  fields: ClaudeTranscriptField[];
}

interface RecordDisplay {
  label: string;
  preview: string | null;
}

function messageRecord(
  record: Record<string, unknown>,
  type: 'user' | 'assistant',
  meta: RecordMeta,
  value: unknown,
): ParsedTranscriptRecord {
  const message = asRecord(record.message);
  const blocks = messageBlocks(message?.content);
  return {
    ...baseRecord(type, value, true),
    type,
    subtype: meta.subtype,
    timestamp: meta.timestamp,
    label: type === 'assistant' ? 'Claude' : userLabel(record),
    preview: messagePreview(blocks),
    blocks,
    fields: meta.fields,
  };
}

function kindRecord(
  kind: ClaudeTranscriptRecordKind,
  meta: RecordMeta,
  display: RecordDisplay,
  value: unknown,
): ParsedTranscriptRecord {
  return {
    ...baseRecord(kind, value, true),
    type: meta.type,
    subtype: meta.subtype,
    timestamp: meta.timestamp,
    label: display.label,
    preview: display.preview,
    fields: meta.fields,
  };
}

function attachmentRecord(
  record: Record<string, unknown>,
  meta: RecordMeta,
  value: unknown,
): ParsedTranscriptRecord {
  const attachment = asRecord(record.attachment);
  const attachmentType = asString(attachment?.type);
  return kindRecord(
    'attachment',
    {
      ...meta,
      fields: attachment ? [...attachmentFields(attachment), ...meta.fields] : meta.fields,
    },
    {
      label: attachmentType ?? 'attachment',
      preview: attachment
        ? (firstStringLeaf(attachment) ?? attachmentType)
        : firstStringLeaf(record),
    },
    value,
  );
}

/**
 * Decode one raw JSONL line.
 *
 * Never throws and never returns nothing: malformed input becomes a generic
 * `invalid` record carrying the original text, so the row and its Raw action
 * survive a line no decoder could read.
 */
export function parseTranscriptRecord(raw: string): ParsedTranscriptRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      ...baseRecord('invalid', null, false),
      preview: collapseText(raw),
    };
  }

  const record = asRecord(value);
  if (!record) {
    return {
      ...baseRecord('unknown', value, true),
      preview: compactValue(value),
    };
  }

  const meta: RecordMeta = {
    type: asString(record.type),
    subtype: asString(record.subtype),
    timestamp: asString(record.timestamp),
    fields: recordFields(record),
  };
  const { type } = meta;

  if (type === 'user' || type === 'assistant') {
    return messageRecord(record, type, meta, value);
  }
  if (type === 'attachment') {
    return attachmentRecord(record, meta, value);
  }
  if (type !== null && (METADATA_TYPES.has(type) || EVENT_TYPES.has(type))) {
    return kindRecord(
      METADATA_TYPES.has(type) ? 'metadata' : 'event',
      meta,
      {
        label: meta.subtype ? `${type} · ${meta.subtype}` : type,
        preview: firstStringLeaf(record),
      },
      value,
    );
  }
  if (type === 'system') {
    return kindRecord(
      'system',
      meta,
      {
        label: meta.subtype ?? 'system',
        preview: asString(record.content) ?? firstStringLeaf(record),
      },
      value,
    );
  }
  return kindRecord(
    'unknown',
    meta,
    {
      label:
        [type, meta.subtype].filter((part): part is string => part !== null).join(' · ') ||
        'Record',
      preview: firstStringLeaf(record),
    },
    value,
  );
}
