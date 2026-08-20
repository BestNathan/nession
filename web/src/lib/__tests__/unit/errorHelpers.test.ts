// web/src/lib/__tests__/errorHelpers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toast } from 'sonner';
import { toastError } from '@/lib/errorHelpers';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

describe('toastError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows err.message when err is an Error', () => {
    toastError(new Error('boom'), 'fallback');
    expect(toast.error).toHaveBeenCalledWith('boom');
  });

  it('shows the fallback when err is not an Error', () => {
    toastError('a plain string', 'fallback');
    expect(toast.error).toHaveBeenCalledWith('fallback');
  });
});
