import type {
  ConnectionState,
  PluginSurface,
  RequestOptions,
  SocketMessage,
} from '@/services/socket/types';

/** A fire-and-forget message the mock surface was asked to send. */
export interface MockSentMessage {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * A correlated request the mock surface is holding. The entry is recorded
 * when {@link MockPluginSurfaceImpl.request} is called and stays pending
 * until the test settles it with resolveNext / rejectNext.
 */
export interface MockRequest {
  type: string;
  payload: Record<string, unknown>;
  options?: RequestOptions;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
}

/** Test double for {@link PluginSurface}: records calls, lets tests drive messages and requests. */
export interface MockPluginSurface extends PluginSurface {
  readonly sent: MockSentMessage[];
  readonly requests: MockRequest[];
  /** Deliver an inbound text message to the subscribed handlers. */
  pushMessage(type: string, payload: unknown, raw?: Partial<SocketMessage>): void;
  /** Deliver an inbound binary frame to the onBinary handlers. */
  pushBinary(data: ArrayBuffer): void;
  /**
   * Settle the first pending request whose type matches (any request when
   * `type` is omitted). Returns false when nothing was pending.
   */
  resolveNext(type?: string, payload?: unknown): boolean;
  /** Reject the first pending request whose type matches (any when omitted). */
  rejectNext(type?: string, error?: Error): boolean;
  setConnectionState(next: ConnectionState): void;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Minimal PluginSurface double for capability-feature unit tests (node
 * environment, no DOM). Request promises stay pending until the test settles
 * them, so timeout and error mappings are exercised by rejecting with the
 * exact error the transport would produce.
 */
export class MockPluginSurfaceImpl implements MockPluginSurface {
  readonly sent: MockSentMessage[] = [];
  readonly requests: MockRequest[] = [];

  private state: ConnectionState;
  private readonly handlers = new Map<string, Set<(payload: unknown, raw: SocketMessage) => void>>();
  private readonly binaryHandlers = new Set<(data: ArrayBuffer) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly waiters = new Set<Waiter>();
  private messageCounter = 0;

  constructor(state: ConnectionState = 'connected') {
    this.state = state;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  send(type: string, payload: Record<string, unknown>): void {
    this.sent.push({ type, payload });
  }

  subscribe(
    type: string,
    handler: (payload: unknown, raw: SocketMessage) => void,
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => {
      const set = this.handlers.get(type);
      if (set) {
        set.delete(handler);
      }
    };
  }

  request<T>(
    type: string,
    payload: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.requests.push({
        type,
        payload,
        options,
        resolve: (value: unknown) => {
          resolve(value as T);
        },
        reject: (error: Error) => {
          reject(error);
        },
      });
    });
  }

  onBinary(handler: (data: ArrayBuffer) => void): () => void {
    this.binaryHandlers.add(handler);
    return () => {
      this.binaryHandlers.delete(handler);
    };
  }

  waitForConnection(): Promise<void> {
    if (this.state === 'connected') {
      return Promise.resolve();
    }
    if (this.state === 'disconnected') {
      return Promise.reject(new Error('Connection lost'));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          this.waiters.delete(waiter);
          resolve();
        },
        reject: (error) => {
          this.waiters.delete(waiter);
          reject(error);
        },
      };
      this.waiters.add(waiter);
    });
  }

  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(handler);
    return () => {
      this.stateListeners.delete(handler);
    };
  }

  pushMessage(type: string, payload: unknown, raw?: Partial<SocketMessage>): void {
    this.messageCounter += 1;
    const message: SocketMessage = {
      msg_type: type,
      id: raw?.id ?? `test_msg_${this.messageCounter}`,
      timestamp: raw?.timestamp ?? 0,
      payload: raw?.payload ?? payload,
    };
    const handlers = this.handlers.get(type);
    if (handlers) {
      for (const handler of [...handlers]) {
        handler(message.payload, message);
      }
    }
  }

  pushBinary(data: ArrayBuffer): void {
    for (const handler of [...this.binaryHandlers]) {
      handler(data);
    }
  }

  resolveNext(type?: string, payload?: unknown): boolean {
    const index = this.requests.findIndex((request) => !type || request.type === type);
    if (index < 0) {
      return false;
    }
    const [request] = this.requests.splice(index, 1);
    request.resolve(payload);
    return true;
  }

  rejectNext(type?: string, error = new Error('Remote error')): boolean {
    const index = this.requests.findIndex((request) => !type || request.type === type);
    if (index < 0) {
      return false;
    }
    const [request] = this.requests.splice(index, 1);
    request.reject(error);
    return true;
  }

  setConnectionState(next: ConnectionState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    for (const listener of [...this.stateListeners]) {
      listener(next);
    }
    if (next === 'connected') {
      const pending = [...this.waiters];
      this.waiters.clear();
      for (const waiter of pending) {
        waiter.resolve();
      }
    } else if (next === 'disconnected') {
      const pending = [...this.waiters];
      this.waiters.clear();
      for (const waiter of pending) {
        waiter.reject(new Error('Connection lost'));
      }
    }
  }
}

export function createMockPluginSurface(
  state: ConnectionState = 'connected',
): MockPluginSurface {
  return new MockPluginSurfaceImpl(state);
}
