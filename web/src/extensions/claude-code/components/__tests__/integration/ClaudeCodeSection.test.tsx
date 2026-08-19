import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClaudeCodeSection } from '@/extensions/claude-code/components/ClaudeCodeSection';
import type { WebSocketService } from '@/services/websocket';
import { WebSocketContext } from '@/hooks/useWebSocket';

/** Create a mock WebSocketService focused on Claude Code methods. */
function mockWs(): WebSocketService {
  return {
    claudeCodeList: vi.fn().mockResolvedValue({ available: false, categories: [] }),
    claudeCodeRead: vi.fn(),
    request: vi.fn(),
  } as unknown as WebSocketService;
}

describe('ClaudeCodeSection', () => {
  const mockAgent = {
    agent_id: 'test-agent-1',
    hostname: 'test-host',
    ip_address: '127.0.0.1',
    port: 19090,
    status: 'online' as const,
    session_count: 3,
    last_heartbeat: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders section header', () => {
    render(
      <WebSocketContext.Provider value={mockWs()}>
        <ClaudeCodeSection agent={mockAgent} />
      </WebSocketContext.Provider>,
    );
    expect(screen.getByText('Claude Code')).toBeDefined();
  });

  it('renders loading state initially', () => {
    render(
      <WebSocketContext.Provider value={mockWs()}>
        <ClaudeCodeSection agent={mockAgent} />
      </WebSocketContext.Provider>,
    );
    expect(screen.getByText('Loading...')).toBeDefined();
  });
});
