import { ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import { WIRE as ENV_LIST_WIRE } from '@/generated/protocol/core/server-env-list/v1';
import { WIRE as ENV_GET_WIRE } from '@/generated/protocol/core/server-env-get/v1';
import { WIRE as ENV_WRITE_WIRE } from '@/generated/protocol/core/server-env-write/v1';
import { WIRE as ENV_DELETE_WIRE } from '@/generated/protocol/core/server-env-delete/v1';
import { WIRE as SESSION_ENV_ACTIVE_WIRE } from '@/generated/protocol/core/server-session-env-active/v1';
import { WIRE as SESSION_ENV_APPLY_WIRE } from '@/generated/protocol/core/server-session-env-apply/v1';
import { WIRE as SESSION_ENV_UNSET_WIRE } from '@/generated/protocol/core/server-session-env-unset/v1';
import {
  envApi,
  type ActiveEnvFile,
  type EnvFileInfo,
  type EnvGetResponse,
  type EnvWriteResponse,
} from '@/capabilities/env';

/**
 * A canned `server.env.*` / `server.session.env.*` backend for integration
 * tests of the Environment surfaces.
 *
 * This installs a stub `PluginSurface` on the REAL `envApi` singleton instead
 * of `vi.mock`-ing the capability barrel, because the barrel mock is circular
 * here: the barrel creates the singleton and re-exports the hooks, the hooks
 * import the singleton back from the barrel, and a
 * `vi.mock('@/capabilities/env', importOriginal-spread)` factory evaluates the
 * real hook modules while the factory is still running — which binds the REAL
 * singleton inside those modules. The symptom is the navigator rendering "env
 * feature is not connected" despite the mock. Hook-level tests avoid the cycle
 * because they enter through the hook's deep path, so the mock factory
 * completes before any real hook module evaluates. Layout tests enter through
 * the barrel itself, so they cannot. Installing a surface on the real
 * singleton (the same move `fixtureGitSurface` makes for the fixture route)
 * has no cycle at all.
 *
 * Answers route on the generated WIRE constants, so a renamed wire fails the
 * build rather than silently falling into the reject branch.
 */
export interface EnvStubRequest {
  type: string;
  payload: Record<string, unknown>;
}

export interface EnvStub {
  /** Every request the surfaces sent, in order (for assertions). */
  readonly requests: EnvStubRequest[];
  setFiles(files: EnvFileInfo[]): void;
  setFile(response: EnvGetResponse): void;
  setWrite(response: EnvWriteResponse): void;
  setActiveSessionFiles(active: ActiveEnvFile[]): void;
  /** Detach the stub — call in `afterEach` so the singleton goes back to unbound. */
  teardown(): void;
}

export function stubEnvApi(): EnvStub {
  const requests: EnvStubRequest[] = [];
  let files: EnvFileInfo[] = [];
  let getResponse: EnvGetResponse = { success: true, content: '', in_use_by: [] };
  let writeResponse: EnvWriteResponse = { success: true };
  let active: ActiveEnvFile[] = [];

  const surface: PluginSurface = {
    connectionState: 'connected',
    protocols: new ProtocolDirectory(),
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      requests.push({ type, payload });
      if (type === ENV_LIST_WIRE) {
        return Promise.resolve({ files } as T);
      }
      if (type === ENV_GET_WIRE) {
        return Promise.resolve(getResponse as T);
      }
      if (type === ENV_WRITE_WIRE) {
        return Promise.resolve(writeResponse as T);
      }
      if (type === ENV_DELETE_WIRE) {
        return Promise.resolve({ success: true } as T);
      }
      if (type === SESSION_ENV_ACTIVE_WIRE) {
        return Promise.resolve({ active } as T);
      }
      if (type === SESSION_ENV_APPLY_WIRE || type === SESSION_ENV_UNSET_WIRE) {
        return Promise.resolve({ success: true } as T);
      }
      return Promise.reject(new Error(`env stub does not answer ${type}`));
    },
    send(): void {},
    subscribe(): () => void {
      return () => {};
    },
    onBinary(): () => void {
      return () => {};
    },
    waitForConnection(): Promise<void> {
      return Promise.resolve();
    },
    onConnectionStateChange(): () => void {
      return () => {};
    },
  };

  const release = envApi.install(surface);
  return {
    requests,
    setFiles(next) {
      files = next;
    },
    setFile(next) {
      getResponse = next;
    },
    setWrite(next) {
      writeResponse = next;
    },
    setActiveSessionFiles(next) {
      active = next;
    },
    teardown: release,
  };
}
