import { useState, useRef, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

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
        setError((e as Error).message);
        setStatus('error');
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
