import {
  WIRE as CONTEXT_WIRE,
  type SandboxActionResult,
  type SandboxContextResponse,
  type SandboxImageSelection,
  type SandboxPolicyDraft,
  type SandboxPreflightResult,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { WIRE as ENTER_WIRE } from '@/generated/protocol/core/server-session-sandbox-enter/v1';
import { WIRE as FOCUS_WIRE } from '@/generated/protocol/core/server-session-sandbox-focus/v1';
import { WIRE as PREFLIGHT_WIRE } from '@/generated/protocol/core/server-session-sandbox-preflight/v1';
import { WIRE as RETURN_WIRE } from '@/generated/protocol/core/server-session-sandbox-return-to-native/v1';

import type { PluginSurface, TransportPlugin } from '@/platform/socket/types';

/**
 * Sandbox capability (#3124) — the context read, preflight, Enter and the two
 * focus transitions. Wire strings come from the generated bindings, so one
 * that drifts from the Rust contract fails the build; consumers use the typed
 * methods and never spell a wire themselves.
 *
 * The plugin has no presence: it is a transport adapter. Whether Sandbox
 * appears at all is the Product Capability layer's decision.
 */
export class SandboxPlugin implements TransportPlugin {
  readonly name = 'sandbox';

  private connection: PluginSurface | null = null;
  private generation = 0;

  /** Bind to a connection; a later install replaces an earlier one. */
  install(connection: PluginSurface): () => void {
    const generation = ++this.generation;
    this.connection = connection;
    return () => {
      if (this.generation === generation && this.connection === connection) {
        this.connection = null;
      }
    };
  }

  /** The active Pane's authenticated context for one Session. */
  async context(
    sessionId: string,
    cacheDigests: readonly string[] = [],
  ): Promise<SandboxContextResponse> {
    return this.requireConnection().request<SandboxContextResponse>(CONTEXT_WIRE, {
      session_id: sessionId,
      cache_digests: [...cacheDigests],
    });
  }

  /**
   * Per-digest Agent cache observations. This reuses the context wire so the
   * Agent answers with the same authenticated Session identity; it does not
   * create a second cache-status protocol.
   */
  async imageCacheStatuses(
    sessionId: string,
    cacheDigests: readonly string[],
  ): Promise<SandboxContextResponse['cache_statuses']> {
    const response = await this.context(sessionId, cacheDigests);
    if (!response.success) {
      throw new Error(response.error ?? 'Agent image cache status is unavailable');
    }
    return response.cache_statuses;
  }

  /** Validate one draft against the exact context generation. */
  async preflight(request: {
    sessionId: string;
    generation: string;
    probeGeneration: string;
    policy: SandboxPolicyDraft;
    images?: readonly SandboxImageSelection[];
    workingDir: string;
  }): Promise<SandboxPreflightResult> {
    return this.requireConnection().request<SandboxPreflightResult>(PREFLIGHT_WIRE, {
      session_id: request.sessionId,
      generation: request.generation,
      probe_generation: request.probeGeneration,
      policy: request.policy,
      images: request.images ? [...request.images] : [],
      working_dir: request.workingDir,
    });
  }

  /**
   * The one explicit Enter. `enterId` is the client's idempotency key: a
   * repeated delivery of the same attempt replays its outcome on the Agent
   * instead of launching a second Pane.
   */
  async enter(request: {
    sessionId: string;
    generation: string;
    probeGeneration: string;
    enterId: string;
    policy: SandboxPolicyDraft;
    images?: readonly SandboxImageSelection[];
    workingDir: string;
  }): Promise<SandboxActionResult> {
    return this.requireConnection().request<SandboxActionResult>(ENTER_WIRE, {
      session_id: request.sessionId,
      generation: request.generation,
      probe_generation: request.probeGeneration,
      enter_id: request.enterId,
      policy: request.policy,
      images: request.images ? [...request.images] : [],
      working_dir: request.workingDir,
    });
  }

  /** Focus the preserved Native Pane; the Sandbox execution keeps running. */
  async returnToNative(sessionId: string): Promise<SandboxActionResult> {
    return this.requireConnection().request<SandboxActionResult>(RETURN_WIRE, {
      session_id: sessionId,
    });
  }

  /** Focus an existing, tracked Sandbox Pane of the Session. */
  async focus(sessionId: string, paneId: string): Promise<SandboxActionResult> {
    return this.requireConnection().request<SandboxActionResult>(FOCUS_WIRE, {
      session_id: sessionId,
      pane_id: paneId,
    });
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('sandbox capability is not connected');
    }
    return this.connection;
  }
}

/** App-level singleton — one capability binding per WebSocketService lifetime. */
export const sandboxApi = new SandboxPlugin();
