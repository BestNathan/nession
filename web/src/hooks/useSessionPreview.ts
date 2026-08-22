import { useState, useRef, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';
import { toast } from 'sonner';

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

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
  const ws = useWebSocket();
  const [status, setStatus] = useState<PreviewStatus>('idle');
  const [ansi, setAnsi] = useState<string>('');
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
        const result = await ws.capturePreview(sessionId, lines);
        if (ctrl.signal.aborted) {
          return;
        }
        setAnsi(result);
        setStatus(result === '' ? 'idle' : 'ready');
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
    [ws],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setStatus('idle');
    setAnsi('');
    setError(null);
  }, []);

  return { status, ansi, error, capture, reset };
}
