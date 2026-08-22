import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionPreview } from '@/hooks/useSessionPreview';
import { useWebSocket } from '@/hooks/useWebSocket';

vi.mock('@/hooks/useWebSocket');

describe('useSessionPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures and transitions to ready', async () => {
    vi.mocked(useWebSocket).mockReturnValue({
      capturePreview: vi.fn().mockResolvedValue('hello'),
    } as unknown as ReturnType<typeof useWebSocket>);
    const { result } = renderHook(() => useSessionPreview());
    await act(async () => {
      await result.current.capture('agent1:session1', 100);
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.ansi).toBe('hello');
  });

  it('transitions to error on failure', async () => {
    vi.mocked(useWebSocket).mockReturnValue({
      capturePreview: vi.fn().mockRejectedValue(new Error('tmux failed')),
    } as unknown as ReturnType<typeof useWebSocket>);
    const { result } = renderHook(() => useSessionPreview());
    await act(async () => {
      await result.current.capture('agent1:session1', 100);
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('tmux failed');
  });

  it('reset clears state', async () => {
    vi.mocked(useWebSocket).mockReturnValue({
      capturePreview: vi.fn().mockResolvedValue('data'),
    } as unknown as ReturnType<typeof useWebSocket>);
    const { result } = renderHook(() => useSessionPreview());
    await act(async () => {
      await result.current.capture('agent1:session1', 100);
    });
    expect(result.current.status).toBe('ready');
    act(() => {
      result.current.reset();
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.ansi).toBe('');
  });

  it('empty capture result stays idle', async () => {
    vi.mocked(useWebSocket).mockReturnValue({
      capturePreview: vi.fn().mockResolvedValue(''),
    } as unknown as ReturnType<typeof useWebSocket>);
    const { result } = renderHook(() => useSessionPreview());
    await act(async () => {
      await result.current.capture('agent1:session1', 100);
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.ansi).toBe('');
  });

  it('calls capturePreview with correct args', async () => {
    const captureFn = vi.fn().mockResolvedValue('data');
    vi.mocked(useWebSocket).mockReturnValue({
      capturePreview: captureFn,
    } as unknown as ReturnType<typeof useWebSocket>);
    const { result } = renderHook(() => useSessionPreview());
    await act(async () => {
      await result.current.capture('agentX:sessY', 500);
    });
    expect(captureFn).toHaveBeenCalledWith('agentX:sessY', 500);
  });
});
