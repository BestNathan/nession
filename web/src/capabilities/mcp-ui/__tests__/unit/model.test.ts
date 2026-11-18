import { describe, expect, it } from 'vitest';

import {
  boundedJson,
  credentialLabel,
  defaultArguments,
  hasOutputSchema,
  outputSchemaNote,
  parseArgumentsDraft,
  readSchema,
  redactSecrets,
  redactText,
  scopeLabel,
  transportLabel,
  validateArguments,
} from '../../model';
import type { McpTool } from '../../types';

function tool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    name: 'session.list',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['current', 'all'], description: 'Scope' },
        limit: { type: 'integer', minimum: 1, default: 20 },
      },
      required: ['scope'],
    },
    ...overrides,
  };
}

describe('MCP UI kit model', () => {
  it('reads top-level schema fields and keeps unknown keywords in raw form', () => {
    const schema = readSchema({
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['current', 'all'], description: 'Scope' },
        limit: { type: 'integer', default: 20 },
        tags: { type: 'array', items: { type: 'string' } },
        ref: { $ref: '#/$defs/mode' },
        nested: { type: 'object', properties: { a: { type: 'string' } } },
        open: {},
      },
      required: ['scope'],
      $defs: { mode: { type: 'string' } },
    });
    expect(schema.form).toBe('object');
    expect(schema.fields.map((field) => field.name)).toEqual([
      'scope',
      'limit',
      'tags',
      'ref',
      'nested',
      'open',
    ]);
    expect(schema.fields[0]).toMatchObject({
      type: 'string',
      required: true,
      choices: ['current', 'all'],
      description: 'Scope',
    });
    expect(schema.fields[1]).toMatchObject({ type: 'integer', defaultValue: 20 });
    expect(schema.fields[2]).toMatchObject({ type: 'array', itemsType: 'string' });
    expect(schema.fields[3].type).toBe('$ref #/$defs/mode');
    expect(schema.fields[4].type).toBe('object');
    expect(schema.fields[5].type).toBe('unknown');
  });

  it('reads a schema carried as a JSON string and refuses an unreadable one', () => {
    const parsed = readSchema('{"type":"object","properties":{"q":{"type":"string"}}}');
    expect(parsed.form).toBe('object');
    expect(parsed.fields[0]).toMatchObject({ name: 'q', type: 'string' });
    expect(readSchema('{not json').form).toBe('unsupported');
    expect(readSchema(undefined).form).toBe('unsupported');
  });

  it('distinguishes a missing output schema from an advertised one', () => {
    expect(hasOutputSchema(tool())).toBe(false);
    expect(outputSchemaNote(tool())).toContain('not advertised');
    const withOutput = tool({ outputSchema: { type: 'object' } });
    expect(hasOutputSchema(withOutput)).toBe(true);
    expect(outputSchemaNote(withOutput)).toBe('');
  });

  it('validates required, typed, enum and minimum constraints; unknown args pass', () => {
    const subject = tool();
    expect(validateArguments(subject, {})).toBe('Required: scope');
    expect(validateArguments(subject, { scope: 'current' })).toBeNull();
    expect(validateArguments(subject, { scope: 'current', limit: 1.5 })).toBe(
      'limit must be an integer',
    );
    expect(validateArguments(subject, { scope: 'nope' })).toBe(
      'scope has an unsupported value',
    );
    expect(validateArguments(subject, { scope: 'current', limit: 0 })).toBe(
      'limit must be at least 1',
    );
    // The JSON draft preserves fields the readable schema does not advertise.
    expect(validateArguments(subject, { scope: 'current', extra: { kept: true } })).toBeNull();
    expect(validateArguments(tool({ inputSchema: 'nonsense' }), {})).toBeNull();
  });

  it('parses a JSON argument draft without narrowing away unknown fields', () => {
    expect(parseArgumentsDraft('{"a":1,"unknown":{"x":2}}')).toEqual({
      ok: true,
      value: { a: 1, unknown: { x: 2 } },
    });
    expect(parseArgumentsDraft('[1,2]')).toMatchObject({ ok: false });
    expect(parseArgumentsDraft('{broken')).toMatchObject({ ok: false });
  });

  it('prefills only defaults the schema declares', () => {
    expect(defaultArguments(tool())).toEqual({ limit: 20 });
    expect(defaultArguments(tool({ inputSchema: {} }))).toEqual({});
  });

  it('redacts credential-looking keys everywhere and keeps the structure', () => {
    const result = redactSecrets({
      authorization: 'Bearer abc',
      nested: { api_key: 'sk-live', token_count: 2 },
      list: [{ password: 'hunter2' }, { ok: true }],
      name: 'nession',
    });
    expect(result.redacted).toBe(true);
    expect(result.value).toEqual({
      authorization: '[redacted]',
      nested: { api_key: '[redacted]', token_count: 2 },
      list: [{ password: '[redacted]' }, { ok: true }],
      name: 'nession',
    });
    expect(redactSecrets({ name: 'plain' })).toEqual({ value: { name: 'plain' }, redacted: false });
  });

  it('redacts bearer and key/value shapes in free text', () => {
    expect(redactText('Authorization: Bearer abcdefghijkl')).toEqual({
      text: 'Authorization: Bearer [redacted]',
      redacted: true,
    });
    expect(redactText('{"token":"supersecret"}')).toEqual({
      text: '{"token":"[redacted]"}',
      redacted: true,
    });
    expect(redactText('ordinary text')).toEqual({ text: 'ordinary text', redacted: false });
  });

  it('bounds rendered JSON and says so', () => {
    expect(boundedJson({ ok: true }, 100)).toEqual({ text: '{\n  "ok": true\n}', truncated: false });
    const bounded = boundedJson({ text: 'x'.repeat(100) }, 20);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).toContain('truncated');
    expect(boundedJson(undefined).text).toBe('null');
  });

  it('labels adapter vocabulary without inventing values', () => {
    expect(scopeLabel('user')).toBe('User');
    expect(scopeLabel('weird')).toBe('weird');
    expect(transportLabel('sse')).toBe('SSE (legacy)');
    expect(credentialLabel('missing')).toBe('Credential unavailable');
  });
});
