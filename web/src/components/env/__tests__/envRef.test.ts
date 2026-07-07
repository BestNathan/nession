import { describe, it, expect } from 'vitest';
import { refKey, toRef, sourceLabel } from '../envRef';
import type { EnvFileInfo } from '../../../types';

function info(overrides: Partial<EnvFileInfo> = {}): EnvFileInfo {
  return {
    name: 'a.env',
    source: 'server',
    size: 10,
    modified: 0,
    var_count: 1,
    ...overrides,
  };
}

describe('envRef helpers', () => {
  it('refKey distinguishes source and agent', () => {
    expect(refKey({ name: 'a.env', source: 'server' })).toBe('server::a.env');
    expect(refKey({ name: 'a.env', source: 'agent', agent_id: 'h1' })).toBe('agent:h1:a.env');
    // Same name, different source → different keys (EC6).
    expect(refKey({ name: 'staging.env', source: 'server' })).not.toBe(
      refKey({ name: 'staging.env', source: 'agent', agent_id: 'h1' }),
    );
  });

  it('toRef strips metadata to a plain ref', () => {
    expect(toRef(info({ name: 'x.env', source: 'agent', agent_id: 'h2' }))).toEqual({
      name: 'x.env',
      source: 'agent',
      agent_id: 'h2',
    });
  });

  it('sourceLabel renders server vs agent:id', () => {
    expect(sourceLabel(info({ source: 'server' }))).toBe('server');
    expect(sourceLabel(info({ source: 'agent', agent_id: 'node-1' }))).toBe('agent:node-1');
    expect(sourceLabel(info({ source: 'agent', agent_id: undefined }))).toBe('agent');
  });
});
