import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock plugins before importing WebSocketService
// All mocks use constructor functions because WebSocketService calls `new PluginClass()`.

function createEventsMock() {
  return {
    name: 'events',
    install: vi.fn(),
    onAgentsChanged: vi.fn(() => vi.fn()),
    onSessionsChanged: vi.fn(() => vi.fn()),
    onCommandsChanged: vi.fn(() => vi.fn()),
    onTerminalOutput: vi.fn(() => vi.fn()),
    onTerminalResize: vi.fn(() => vi.fn()),
  };
}

function createRequestsMock() {
  return {
    name: 'requests',
    install: vi.fn(),
    listAgents: vi.fn(() => Promise.resolve([])),
    serverInfo: vi.fn(() => Promise.resolve({})),
    listSessions: vi.fn(() => Promise.resolve([])),
    requestAttach: vi.fn(() => Promise.resolve({})),
    createSession: vi.fn(() => Promise.resolve({ success: true })),
    killSession: vi.fn(() => Promise.resolve({ success: true })),
    renameAgent: vi.fn(() => Promise.resolve({})),
    listEnvFiles: vi.fn(() => Promise.resolve({ files: [] })),
    getEnvFile: vi.fn(() => Promise.resolve({ success: true })),
    writeEnvFile: vi.fn(() => Promise.resolve({ success: true })),
    deleteEnvFile: vi.fn(() => Promise.resolve({ success: true })),
    applySessionEnv: vi.fn(() => Promise.resolve({ success: true })),
    unsetSessionEnv: vi.fn(() => Promise.resolve({ success: true })),
    getSessionEnvActive: vi.fn(() => Promise.resolve({ active: [] })),
    queryAgentEnvState: vi.fn(() => Promise.resolve({ sourced_files: [] })),
    listCommands: vi.fn(() => Promise.resolve({ commands: [] })),
    addCommand: vi.fn(() => Promise.resolve({ success: true })),
    removeCommand: vi.fn(() => Promise.resolve({ success: true })),
    updateCommand: vi.fn(() => Promise.resolve({ success: true })),
  };
}

function createTerminalMock() {
  return {
    name: 'terminal',
    install: vi.fn(),
    beginRelay: vi.fn(),
    endRelay: vi.fn(),
    sendTerminalInput: vi.fn(),
    sendTerminalResize: vi.fn(),
    sendRelayInput: vi.fn(),
    sendRelayResize: vi.fn(),
  };
}

vi.mock('../plugins/EventPlugin', () => {
  const Mock = vi.fn(function (this: Record<string, unknown>) { Object.assign(this, createEventsMock()); });
  return { EventPlugin: Mock };
});

vi.mock('../plugins/RequestPlugin', () => {
  const Mock = vi.fn(function (this: Record<string, unknown>) { Object.assign(this, createRequestsMock()); });
  return { RequestPlugin: Mock };
});

vi.mock('../plugins/TerminalPlugin', () => {
  const Mock = vi.fn(function (this: Record<string, unknown>) { Object.assign(this, createTerminalMock()); });
  return { TerminalPlugin: Mock };
});

// Build fresh core mock functions each time, and expose them for assertion.
const coreMocks = {
  connect: vi.fn(() => Promise.resolve()),
  disconnect: vi.fn(),
  isConnected: vi.fn(() => true),
  isAuthenticated: vi.fn(() => true),
  getConnectionStatus: vi.fn(() => 'authenticated' as const),
  onConnectionChange: vi.fn(() => vi.fn()),
  authenticate: vi.fn(() => Promise.resolve()),
  getP2PConnectionInfo: vi.fn(() => null),
};

vi.mock('../core', () => {
  const WebSocketServiceCoreImplMock = vi.fn(function (this: Record<string, unknown>) {
    Object.assign(this, coreMocks);
  });
  return { WebSocketServiceCoreImpl: WebSocketServiceCoreImplMock };
});

import { WebSocketService } from '../WebSocketService';
import { EventPlugin } from '../plugins/EventPlugin';
import { RequestPlugin } from '../plugins/RequestPlugin';
import { TerminalPlugin } from '../plugins/TerminalPlugin';

describe('WebSocketService (facade)', () => {
  let service: WebSocketService;
  let eventsInstance: InstanceType<typeof EventPlugin>;
  let requestsInstance: InstanceType<typeof RequestPlugin>;
  let terminalInstance: InstanceType<typeof TerminalPlugin>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new WebSocketService('ws://test', 'token');
    eventsInstance = (EventPlugin as unknown as ReturnType<typeof vi.fn>).mock.instances[0] as InstanceType<typeof EventPlugin>;
    requestsInstance = (RequestPlugin as unknown as ReturnType<typeof vi.fn>).mock.instances[0] as InstanceType<typeof RequestPlugin>;
    terminalInstance = (TerminalPlugin as unknown as ReturnType<typeof vi.fn>).mock.instances[0] as InstanceType<typeof TerminalPlugin>;
  });

  describe('constructor', () => {
    it('installs all three plugins', () => {
      expect(EventPlugin).toHaveBeenCalledTimes(1);
      expect(RequestPlugin).toHaveBeenCalledTimes(1);
      expect(TerminalPlugin).toHaveBeenCalledTimes(1);
      expect(eventsInstance.install).toHaveBeenCalled();
      expect(requestsInstance.install).toHaveBeenCalled();
      expect(terminalInstance.install).toHaveBeenCalled();
    });
  });

  describe('connection management delegates to core', () => {
    it('connect()', async () => {
      await service.connect();
      expect(coreMocks.connect).toHaveBeenCalled();
    });

    it('disconnect()', () => {
      service.disconnect();
      expect(coreMocks.disconnect).toHaveBeenCalled();
    });

    it('isConnected()', () => {
      expect(service.isConnected()).toBe(true);
      expect(coreMocks.isConnected).toHaveBeenCalled();
    });

    it('isAuthenticated()', () => {
      expect(service.isAuthenticated()).toBe(true);
      expect(coreMocks.isAuthenticated).toHaveBeenCalled();
    });

    it('isauthenticated() (deprecated backward-compat)', () => {
      expect(service.isauthenticated()).toBe(true);
      expect(coreMocks.isAuthenticated).toHaveBeenCalled();
    });

    it('getConnectionStatus()', () => {
      expect(service.getConnectionStatus()).toBe('authenticated');
      expect(coreMocks.getConnectionStatus).toHaveBeenCalled();
    });

    it('onConnectionChange()', () => {
      const cb = vi.fn();
      const unsub = service.onConnectionChange(cb);
      expect(coreMocks.onConnectionChange).toHaveBeenCalledWith(cb);
      expect(typeof unsub).toBe('function');
    });

    it('authenticate()', async () => {
      await service.authenticate();
      expect(coreMocks.authenticate).toHaveBeenCalled();
    });
  });

  describe('backward-compat accessors', () => {
    it('reconnectAttempts getter/setter', () => {
      // The mock core uses Object.assign, so reconnectAttempts lives on the service directly
      // through the facade's getter/setter that casts to `unknown`.
      service.reconnectAttempts = 3;
      expect(service.reconnectAttempts).toBe(3);
    });

    it('reconnectTimer getter/setter', () => {
      const timer = setTimeout(() => {}, 0);
      service.reconnectTimer = timer;
      expect(service.reconnectTimer).toBe(timer);
      clearTimeout(timer);
    });

    it('reconnectTimer can be set to null', () => {
      service.reconnectTimer = null;
      expect(service.reconnectTimer).toBeNull();
    });
  });

  describe('P2P support delegates to core', () => {
    it('getP2PConnectionInfo', () => {
      const info = { mode: 'p2p' as const, session_id: 's1', agent_address: 'ws://a/ws', connection_token: 'tok' };
      service.getP2PConnectionInfo(info);
      expect(coreMocks.getP2PConnectionInfo).toHaveBeenCalledWith(info);
    });
  });

  describe('event subscriptions delegate to EventPlugin', () => {
    it('onAgentsChanged', () => {
      const cb = vi.fn();
      service.onAgentsChanged(cb);
      expect(eventsInstance.onAgentsChanged).toHaveBeenCalledWith(cb);
    });

    it('onSessionsChanged', () => {
      const cb = vi.fn();
      service.onSessionsChanged(cb);
      expect(eventsInstance.onSessionsChanged).toHaveBeenCalledWith(cb);
    });

    it('onCommandsChanged', () => {
      const cb = vi.fn();
      service.onCommandsChanged(cb);
      expect(eventsInstance.onCommandsChanged).toHaveBeenCalledWith(cb);
    });

    it('onTerminalOutput', () => {
      const cb = vi.fn();
      service.onTerminalOutput('sess-1', cb);
      expect(eventsInstance.onTerminalOutput).toHaveBeenCalledWith('sess-1', cb);
    });

    it('onTerminalResize', () => {
      const cb = vi.fn();
      service.onTerminalResize('sess-1', cb);
      expect(eventsInstance.onTerminalResize).toHaveBeenCalledWith('sess-1', cb);
    });
  });

  describe('request methods delegate to RequestPlugin', () => {
    it('listAgents', async () => {
      await service.listAgents();
      expect(requestsInstance.listAgents).toHaveBeenCalled();
    });

    it('serverInfo', async () => {
      await service.serverInfo();
      expect(requestsInstance.serverInfo).toHaveBeenCalled();
    });

    it('listSessions', async () => {
      await service.listSessions('agent-1');
      expect(requestsInstance.listSessions).toHaveBeenCalledWith('agent-1');
    });

    it('requestAttach', async () => {
      await service.requestAttach('s1', 'relay', 'wss://r');
      expect(requestsInstance.requestAttach).toHaveBeenCalledWith('s1', 'relay', 'wss://r');
    });

    it('createSession', async () => {
      const env = [{ name: 'e', source: 'server' as const }];
      await service.createSession('a1', 'sess', env);
      expect(requestsInstance.createSession).toHaveBeenCalledWith('a1', 'sess', env);
    });

    it('killSession', async () => {
      await service.killSession('s1');
      expect(requestsInstance.killSession).toHaveBeenCalledWith('s1');
    });

    it('renameAgent', async () => {
      await service.renameAgent('a1', 'New');
      expect(requestsInstance.renameAgent).toHaveBeenCalledWith('a1', 'New');
    });

    it('listEnvFiles', async () => {
      await service.listEnvFiles();
      expect(requestsInstance.listEnvFiles).toHaveBeenCalled();
    });

    it('getEnvFile', async () => {
      const ref = { name: 'f', source: 'server' as const };
      await service.getEnvFile(ref);
      expect(requestsInstance.getEnvFile).toHaveBeenCalledWith(ref);
    });

    it('writeEnvFile', async () => {
      const ref = { name: 'f', source: 'server' as const };
      await service.writeEnvFile(ref, 'X=1', true);
      expect(requestsInstance.writeEnvFile).toHaveBeenCalledWith(ref, 'X=1', true);
    });

    it('deleteEnvFile', async () => {
      const ref = { name: 'f', source: 'server' as const };
      await service.deleteEnvFile(ref);
      expect(requestsInstance.deleteEnvFile).toHaveBeenCalledWith(ref);
    });

    it('applySessionEnv', async () => {
      const env = [{ name: 'e', source: 'server' as const }];
      await service.applySessionEnv('s1', env);
      expect(requestsInstance.applySessionEnv).toHaveBeenCalledWith('s1', env);
    });

    it('unsetSessionEnv', async () => {
      const env = [{ name: 'e', source: 'server' as const }];
      await service.unsetSessionEnv('s1', env);
      expect(requestsInstance.unsetSessionEnv).toHaveBeenCalledWith('s1', env);
    });

    it('getSessionEnvActive', async () => {
      await service.getSessionEnvActive('s1');
      expect(requestsInstance.getSessionEnvActive).toHaveBeenCalledWith('s1');
    });

    it('queryAgentEnvState', async () => {
      await service.queryAgentEnvState('s1');
      expect(requestsInstance.queryAgentEnvState).toHaveBeenCalledWith('s1');
    });

    it('listCommands', async () => {
      await service.listCommands();
      expect(requestsInstance.listCommands).toHaveBeenCalled();
    });

    it('addCommand', async () => {
      await service.addCommand('L', 'cmd', true);
      expect(requestsInstance.addCommand).toHaveBeenCalledWith('L', 'cmd', true);
    });

    it('removeCommand', async () => {
      await service.removeCommand('c1');
      expect(requestsInstance.removeCommand).toHaveBeenCalledWith('c1');
    });

    it('updateCommand', async () => {
      await service.updateCommand('c1', { label: 'X' });
      expect(requestsInstance.updateCommand).toHaveBeenCalledWith('c1', { label: 'X' });
    });
  });

  describe('terminal I/O delegates to TerminalPlugin', () => {
    it('sendTerminalInput', () => {
      service.sendTerminalInput('s1', 'data');
      expect(terminalInstance.sendTerminalInput).toHaveBeenCalledWith('s1', 'data');
    });

    it('sendTerminalResize', () => {
      service.sendTerminalResize('s1', 80, 24);
      expect(terminalInstance.sendTerminalResize).toHaveBeenCalledWith('s1', 80, 24);
    });

    it('beginRelay', () => {
      service.beginRelay('s1', 'url', 80, 24);
      expect(terminalInstance.beginRelay).toHaveBeenCalledWith('s1', 'url', 80, 24);
    });

    it('endRelay', () => {
      service.endRelay('s1');
      expect(terminalInstance.endRelay).toHaveBeenCalledWith('s1');
    });

    it('sendRelayInput', () => {
      service.sendRelayInput('sess', 'data');
      expect(terminalInstance.sendRelayInput).toHaveBeenCalledWith('sess', 'data');
    });

    it('sendRelayResize', () => {
      service.sendRelayResize('sess', 80, 24);
      expect(terminalInstance.sendRelayResize).toHaveBeenCalledWith('sess', 80, 24);
    });
  });
});
