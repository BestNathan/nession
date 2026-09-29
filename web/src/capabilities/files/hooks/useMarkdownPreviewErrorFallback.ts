import { useEffect } from 'react';
import type { ViewMode } from './useFileViewer';

/** Switch to Raw when MarkdownPreview reports a render failure. */
export function useMarkdownPreviewErrorFallback(
  filename: string,
  setViewMode: (mode: ViewMode) => void,
) {
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ filename: string }>).detail;
      if (detail.filename === filename) {
        setViewMode('raw');
      }
    };
    window.addEventListener('markdown-preview-error', handler);
    return () => window.removeEventListener('markdown-preview-error', handler);
  }, [filename, setViewMode]);
}
