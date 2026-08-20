// web/src/terminal/state/__tests__/capability.test.ts
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import { capabilitiesAtomFamily } from '@/terminal/state/capability';

describe('capabilitiesAtomFamily', () => {
  it('defaults with clipboard/mouse/resize enabled and the rest disabled', () => {
    const store = createStore();
    const caps = store.get(capabilitiesAtomFamily('s1'));
    expect(caps.clipboard).toBe(true);
    expect(caps.search).toBe(false);
    expect(caps.customInput).toBe(false);
    expect(caps.aiInput).toBe(false);
    expect(caps.commandPalette).toBe(false);
    expect(caps.mouse).toBe(true);
    expect(caps.resize).toBe(true);
  });

  it('is writable and isolated per session', () => {
    const store = createStore();
    store.set(capabilitiesAtomFamily('s1'), {
      clipboard: false,
      search: true,
      customInput: false,
      aiInput: false,
      commandPalette: false,
      mouse: true,
      resize: true,
    });
    expect(store.get(capabilitiesAtomFamily('s1')).search).toBe(true);
    expect(store.get(capabilitiesAtomFamily('s1')).clipboard).toBe(false);
    expect(store.get(capabilitiesAtomFamily('s2')).search).toBe(false);
  });
});
