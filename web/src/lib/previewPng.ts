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
  cols?: number,
  rows?: number,
): Promise<void> {
  // Use provided dimensions or calculate from content
  const lines = ansi.split('\n');
  const actualCols = cols ?? Math.min(Math.max(1, ...lines.map((l) => l.length)), 300);
  const actualRows = rows ?? Math.max(1, lines.length);

  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-99999px';
  // Approximate width: cols * 8px per char (monospace at 14px)
  container.style.width = `${actualCols * 8}px`;
  document.body.appendChild(container);

  const offscreen = new Terminal({
    cols: actualCols,
    rows: actualRows,
    convertEol: true,
    disableStdin: true,
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 14, // Match live terminal font size
    theme: CATPPUCCIN_MOCHA,
  });
  offscreen.loadAddon(new CanvasAddon());
  offscreen.open(container);
  offscreen.write(ansi);
  // Wait for terminal to fully render (multiple frames for canvas addon)
  await new Promise<void>((resolve) => {
    let frames = 0;
    const waitForRender = () => {
      requestAnimationFrame(() => {
        frames++;
        if (frames >= 3) {
          resolve();
        } else {
          waitForRender();
        }
      });
    };
    waitForRender();
  });
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
      // Filename: {session}_{YYYY-MM-DD_HH-mm-ss}.png
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);

      // Detect mobile device
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

      if (isMobile && navigator.share && navigator.canShare) {
        // Mobile: use Web Share API to save to photo album
        const file = new File([blob], `${sessionName}_${timestamp}.png`, {
          type: 'image/png',
        });
        if (navigator.canShare({ files: [file] })) {
          navigator
            .share({
              files: [file],
              title: 'Terminal Preview',
              text: `Preview of ${sessionName}`,
            })
            .then(() => {
              URL.revokeObjectURL(url);
              offscreen.dispose();
              document.body.removeChild(container);
              resolve();
            })
            .catch((err) => {
              // Fallback to download if share fails
              console.warn('Share failed, falling back to download:', err);
              triggerDownload(url, sessionName, timestamp);
              URL.revokeObjectURL(url);
              offscreen.dispose();
              document.body.removeChild(container);
              resolve();
            });
        } else {
          // Fallback to download if can't share files
          triggerDownload(url, sessionName, timestamp);
          URL.revokeObjectURL(url);
          offscreen.dispose();
          document.body.removeChild(container);
          resolve();
        }
      } else {
        // Web: trigger download
        triggerDownload(url, sessionName, timestamp);
        URL.revokeObjectURL(url);
        offscreen.dispose();
        document.body.removeChild(container);
        resolve();
      }
    });
  });
}

function triggerDownload(url: string, sessionName: string, timestamp: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sessionName}_${timestamp}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
