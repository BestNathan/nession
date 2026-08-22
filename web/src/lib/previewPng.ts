import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { CATPPUCCIN_MOCHA } from '@/terminal/ThemeManager';

/**
 * Render ANSI text to an offscreen terminal and download it as PNG.
 * Uses the Canvas addon (not WebGL) so canvas.toBlob() is trivially available.
 */
export async function exportSessionPreviewPng(
  ansi: string,
  sessionName: string,
): Promise<void> {
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-99999px';
  container.style.width = '1600px'; // 200 cols × 8px per char
  document.body.appendChild(container);
  const lineCount = Math.max(1, ansi.split('\n').length);
  const offscreen = new Terminal({
    cols: 200,
    rows: lineCount,
    convertEol: true,
    disableStdin: true,
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 13,
    theme: CATPPUCCIN_MOCHA,
  });
  offscreen.loadAddon(new CanvasAddon());
  offscreen.open(container);
  offscreen.write(ansi);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const canvas = container.querySelector('canvas');
  if (!canvas) {
    offscreen.dispose();
    document.body.removeChild(container);
    return;
  }
  canvas.toBlob((blob) => {
    if (!blob) {
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `preview-${sessionName}-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
    offscreen.dispose();
    document.body.removeChild(container);
  });
}
