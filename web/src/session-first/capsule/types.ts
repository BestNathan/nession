export type CapsuleMode = 'input' | 'commands';

export type CapsuleVariant = 'desktop' | 'mobile';

export type CapsulePopoverId = 'history' | 'commands';

/** Content-driven Input composer layout (spec: flat-stacked). */
export type ComposerLayout = 'flat' | 'stacked';

/** @deprecated Use ComposerLayout — single≡flat, multi≡stacked */
export type DockHeight = 'single' | 'multi';

export function dockHeightFromLayout(layout: ComposerLayout): DockHeight {
  return layout === 'stacked' ? 'multi' : 'single';
}

export function layoutFromLineCount(lineCount: number): ComposerLayout {
  return lineCount >= 2 ? 'stacked' : 'flat';
}
