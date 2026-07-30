import { createElement, type ComponentType, type ReactNode } from 'react';
import type { UIExtension } from './types';

/** All discovered extensions. Populated at app startup. */
const extensions: UIExtension[] = [];

/** Init: discover extensions from the directory listing. */
export async function initExtensions(): Promise<void> {
  // Use Vite's import.meta.glob for dynamic discovery of extension directories
  const modules = import.meta.glob<{ default: UIExtension }>(
    './*/index.ts',
    { eager: false },
  );

  for (const [path, loader] of Object.entries(modules)) {
    try {
      const mod = await loader();
      if (mod.default) {
        extensions.push(mod.default);
      }
    } catch (e) {
      console.warn(`Failed to load extension at ${path}:`, e);
    }
  }
}

/** Get all registered extensions. */
export function getExtensions(): readonly UIExtension[] {
  return extensions;
}

/**
 * Render all extensions for a given slot.
 * Returns an array of React elements that host components render inline.
 */
export function renderSlot(
  slot: 'agent-detail' | 'terminal-header',
  props: Record<string, unknown>,
): ReactNode[] {
  return extensions
    .filter((ext) => ext.slots[slot])
    .map((ext) => {
      const Component = ext.slots[slot] as ComponentType;
      return createElement(Component, { key: ext.name, ...props });
    });
}
