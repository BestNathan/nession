import { describe, expect, it } from 'vitest';
import { WORKSPACE_TOOLS } from '../../tools';

describe('workspace tool registry', () => {
  it('registers files, session and agent', () => {
    expect(WORKSPACE_TOOLS.map((t) => t.id)).toEqual(['files', 'session', 'agent']);
  });

  it('ids are unique', () => {
    const ids = WORKSPACE_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each tool provides web and app layouts', () => {
    for (const tool of WORKSPACE_TOOLS) {
      expect(typeof tool.layout.web).toBe('function');
      expect(typeof tool.layout.app).toBe('function');
    }
  });

  it('files requires fileOps (availability)', () => {
    const files = WORKSPACE_TOOLS.find((t) => t.id === 'files')!;
    expect(files.availability({ fileOps: null } as never)).toBe(false);
    expect(files.availability({ fileOps: {} } as never)).toBe(true);
  });
});
