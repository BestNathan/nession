import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';

interface UseAsyncOperationOptions<T> {
  /** Toast message on success (omit to skip toast) */
  successMessage?: string | ((data: T) => string);
  /** Show toast on error, default true */
  showToastOnError?: boolean;
  /** Custom error message (overrides the error's message) */
  errorMessage?: string | ((err: Error) => string);
}

interface UseAsyncOperationResult<TArgs extends unknown[], TResult> {
  execute: (...args: TArgs) => Promise<TResult | undefined>;
  loading: boolean;
  error: string | null;
  data: TResult | null;
  reset: () => void;
}

/**
 * Generic hook for async operations with loading/error state and optional toast.
 *
 * @param operation - The async function to execute
 * @param options - Configuration for toast messages and error handling
 * @returns Object with execute function, loading/error/data state, and reset function
 */
export function useAsyncOperation<TArgs extends unknown[], TResult>(
  operation: (...args: TArgs) => Promise<TResult>,
  options: UseAsyncOperationOptions<TResult> = {},
): UseAsyncOperationResult<TArgs, TResult> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TResult | null>(null);
  const operationRef = useRef(operation);
  operationRef.current = operation;

  const execute = useCallback(async (...args: TArgs) => {
    setLoading(true);
    setError(null);
    try {
      const result = await operationRef.current(...args);
      setData(result);
      const msg = options.successMessage;
      if (msg) {
        toast.success(typeof msg === 'function' ? msg(result) : msg);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Operation failed';
      const displayMessage = options.errorMessage
        ? (typeof options.errorMessage === 'function'
            ? options.errorMessage(err as Error)
            : options.errorMessage)
        : message;
      setError(displayMessage);
      if (options.showToastOnError !== false) {
        toast.error(displayMessage);
      }
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [options]);

  const reset = useCallback(() => {
    setError(null);
    setData(null);
  }, []);

  return { execute, loading, error, data, reset };
}
