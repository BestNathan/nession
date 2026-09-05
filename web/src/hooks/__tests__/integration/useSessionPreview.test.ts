import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionPreview } from '@/hooks/useSessionPreview';

// The hook captures through the sessions feature singleton, so the whole
// service dependency collapses into one mocked module.
const sessionsApiMock = vi.hoisted(() => ({
  capturePreview: vi.fn(),
}));

vi.mock('@/features/sessions', () => ({ sessionsApi: sessionsApiMock }));

describe('useSessionPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures and transitions to ready', async () => {
    sessionsApiMock.capturePreview.mockResolvedValue({ ansi: 'hello', cols: 80, rows: 24 });
    const { result } = renderHook(() => useSessionPreview());
    await act(async () => {
      await result.current.capture('agent1:session1', 100);
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.ansi).toBe('hello');
    expect(result.current.cols).toBe(80);
    expect(result.current.rows).toBe(24);
  });

  it('transitions to error on failure', async () => {
    sessionsApiMock.capturePreview.mockRejectedValue(new Error('tmux failed'));
    const { result } = renderHook(() => useSessionPreview());
    await act(async () => {
      await result.current.capture('agent1:session1', 100);
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('tmux failed');
  });

  it('reset clears state', async () => {
    sessionsApiMock.capturePreview.mockResolvedValue({ ansi: 'data', cols: 80, rows: 24 });
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
    sessionsApiMock.capturePreview.mockResolvedValue({ ansi: '', cols: 80, rows: 24 });
    const { result } = renderHook(() => useSessionPreview());
    await act(async () => {
      await result.current.capture('agent1:session1', 100);
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.ansi).toBe('');
  });

  it('calls capturePreview with correct args', async () => {
    sessionsApiMock.capturePreview.mockResolvedValue({ ansi: 'data', cols: 80, rows: 24 });
    const { result } = renderHook(() => useSessionPreview());
    await act(async () => {
      await result.current.capture('agentX:sessY', 500);
    });
    expect(sessionsApiMock.capturePreview).toHaveBeenCalledWith('agentX:sessY', 500);
  });
});
