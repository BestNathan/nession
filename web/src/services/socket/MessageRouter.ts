import type { MessageRouter, RequestOptions, SocketMessage } from './types';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface MessageRouterDeps {
  send: (msg: SocketMessage) => void;
  generateId: () => string;
}

export class MessageRouterImpl implements MessageRouter {
  private readonly handlers = new Map<string, Set<(payload: unknown, raw: SocketMessage) => void>>();
  private readonly pending = new Map<string, Pending>();
  private readonly binaryHandlers = new Set<(data: ArrayBuffer) => void>();
  private disposed = false;

  constructor(private readonly deps: MessageRouterDeps) {}

  send(message: SocketMessage): void {
    if (this.disposed) {
      throw new Error('MessageRouter disposed');
    }
    this.deps.send(message);
  }

  subscribe(type: string, handler: (payload: unknown, raw: SocketMessage) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) {
        this.handlers.delete(type);
      }
    };
  }

  request<T>(type: string, payload: Record<string, unknown>, options: RequestOptions = {}): Promise<T> {
    const id = this.deps.generateId();
    const msg: SocketMessage = { msg_type: type, id, timestamp: Date.now(), payload };
    const timeoutMs = options.timeoutMs ?? 15_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.deps.send(msg);
    });
  }

  handleIncoming(message: SocketMessage): void {
    const pending = this.pending.get(message.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message.payload);
      return;
    }
    const set = this.handlers.get(message.msg_type);
    if (set) {
      for (const h of set) {
        h(message.payload, message);
      }
    }
  }

  onBinary(handler: (data: ArrayBuffer) => void): () => void {
    this.binaryHandlers.add(handler);
    return () => {
      this.binaryHandlers.delete(handler);
    };
  }

  handleBinary(data: ArrayBuffer): void {
    for (const h of this.binaryHandlers) {
      h(data);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('MessageRouter disposed'));
    }
    this.pending.clear();
    this.handlers.clear();
    this.binaryHandlers.clear();
  }
}
