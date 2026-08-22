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
  // Calculate cols from actual max line width, capped at 300
  const lines = ansi.split('\n');
  const maxLineWidth = Math.max(1, ...lines.map((l) => l.length));
  const cols = Math.min(maxLineWidth, 300);
  const lineCount = Math.max(1, lines.length);

  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-99999px';
  // Approximate width: cols * 8px per char (monospace at 14px)
  container.style.width = `${cols * 8}px`;
  document.body.appendChild(container);

  const offscreen = new Terminal({
    cols,
    rows: lineCount,
    convertEol: true,
    disableStdin: true,
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 14, // Match live terminal font size
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
    throw new Error('Canvas not found after render');
  }
  await new Promise<void>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('toBlob failed'));
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Filename: {session}_{YYYY-MM-DD_HH-mm-ss}.png
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);
      a.download = `${sessionName}_${timestamp}.png`;
      a.click();
      URL.revokeObjectURL(url);
      offscreen.dispose();
      document.body.removeChild(container);
      resolve();
    });
  });
}
