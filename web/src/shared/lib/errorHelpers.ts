import { toast } from 'sonner';

/**
 * Show a toast error message from an unknown error.
 * Uses err.message if err is an Error, otherwise uses fallback.
 */
export function toastError(err: unknown, fallback: string): void {
  toast.error(err instanceof Error ? err.message : fallback);
}
