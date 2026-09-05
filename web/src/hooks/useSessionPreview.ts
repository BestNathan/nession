import { useState, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { sessionsApi } from '../features/sessions';

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

interface PreviewResult {
  ansi: string;
  cols?: number;
  rows?: number;
}

function isVersionError(error: string): boolean {
  return (
    error.toLowerCase().includes('unsupported message type') ||
    error.toLowerCase().includes('unknown message type')
  );
}

function localizeError(error: string): string {
  if (isVersionError(error)) {
    return 'Preview not supported by this agent version. Please upgrade the agent.';
  }
  if (error.includes('session not found')) {
    return 'Session not found. It may have been killed.';
  }
  if (error.includes('capture_failed')) {
    return 'Failed to capture terminal output.';
  }
  return error;
}

export function useSessionPreview() {
  const [status, setStatus] = useState<PreviewStatus>('idle');
  const [result, setResult] = useState<PreviewResult>({ ansi: '' });
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const capture = useCallback(
    async (sessionId: string, lines: number) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setStatus('loading');
      setError(null);
      try {
        const previewResult = await sessionsApi.capturePreview(sessionId, lines);
        if (ctrl.signal.aborted) {
          return;
        }
        setResult(previewResult);
        setStatus(previewResult.ansi === '' ? 'idle' : 'ready');
      } catch (e) {
        if (ctrl.signal.aborted) {
          return;
        }
        const errorMessage = localizeError((e as Error).message);
        setError(errorMessage);
        setStatus('error');
        toast.error('Failed to capture preview', {
          description: errorMessage,
        });
      }
    },
    [],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setStatus('idle');
    setResult({ ansi: '' });
    setError(null);
  }, []);

  return { status, ansi: result.ansi, cols: result.cols, rows: result.rows, error, capture, reset };
}
