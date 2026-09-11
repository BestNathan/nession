import { describe, expect, it } from 'vitest';
import { WORKSPACE_TOOLS } from '../../tools';

describe('legacy workspace view bindings', () => {
  it('uses unique capability ids without defining presentation policy', () => {
    const ids = WORKSPACE_TOOLS.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps web and app deeper-view renderers available during migration', () => {
    for (const tool of WORKSPACE_TOOLS) {
      expect(typeof tool.layout.web).toBe('function');
      expect(typeof tool.layout.app).toBe('function');
    }
  });

  it('keeps legacy availability as adapter input rather than direct chrome ownership', () => {
    const files = WORKSPACE_TOOLS.find((tool) => tool.id === 'files')!;
    expect(files.availability({ fileOps: null } as never)).toBe(false);
    expect(files.availability({ fileOps: {} } as never)).toBe(true);
  });
});
