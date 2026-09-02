import type { ComposerLayout, DockHeight } from '@/session-first/capsule/types';

export function layoutFromLineCount(lineCount: number): ComposerLayout {
  return lineCount >= 2 ? 'stacked' : 'flat';
}

export function dockHeightFromLayout(layout: ComposerLayout): DockHeight {
  return layout === 'stacked' ? 'multi' : 'single';
}
