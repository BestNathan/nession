import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import type {
  ActiveEnvFile,
  EnvFileInfo,
  EnvGetResponse,
  EnvListResponse,
  SessionEnvActiveResponse,
} from '@/capabilities/env';
import { WIRE as ENV_LIST_WIRE } from '@/generated/protocol/core/server-env-list/v1';
import { WIRE as ENV_GET_WIRE } from '@/generated/protocol/core/server-env-get/v1';
import { WIRE as SESSION_ENV_ACTIVE_WIRE } from '@/generated/protocol/core/server-session-env-active/v1';
import { FIXTURE_AGENTS, FIXTURE_SELECTED_ID } from './fixtureData';

/**
 * A canned env backend for the fixture route (#1202).
 *
 * The fixture is offline, so the Environment capability has nothing to talk
 * to. This stands in for the server's `server.env.*` answers with
 * deterministic data, which is what lets the canonical route render the
 * context-first surfaces at all — and therefore what lets e2e assert the
 * #1202 states (masked sensitive value, empty value, skipped line, Current
 * Session activity, in-use impact) against real DOM rather than against a
 * jsdom mock.
 *
 * The states emerge from the *files*, never from a named view: a route can
 * ask for the empty inventory (`env=empty`), but "the masked row" exists
 * because `staging.env` contains a key that matches the shared sensitive
 * pattern, and the in-use dialog exists because `prod.env` is used by two
 * sessions. A fixture that named states directly would let a test assert a
 * rendering the app never decided on.
 *
 * The stub is read-only. Mutating wires (`server.env.write`,
 * `server.env.delete`, `server.session.env.apply|unset`) are rejected: a
 * stateless fixture that answered success would render a follow-up state the
 * product cannot produce (the "saved" content would be gone on the next
 * read). Specs drive dialogs up to confirmation, not past it.
 *
 *   /#/fixture/workspace?capability=env            → three profiles, one Session-active
 *   /#/fixture/workspace?capability=env&env=empty  → the empty inventory
 */

/**
 * `staging.env` — Session-active, and carries every variable-row state: a
 * sensitive key, an empty value, a skipped line — and six assignments, which
 * is the threshold past which the Variables view offers its filter.
 */
const STAGING_CONTENT = [
  'NODE_ENV=staging',
  'API_BASE=https://staging.internal',
  'API_KEY=staging-secret-9f2c7d',
  'EMPTY_OVERRIDE=',
  'FEATURE_FLAGS=beta,workspace',
  'LOG_LEVEL=debug',
  'this line has no equals sign',
].join('\n');

/** `prod.env` — agent-local and in use, so every write path explains impact. */
const PROD_CONTENT = [
  'NODE_ENV=production',
  'DATABASE_URL=postgres://db.internal:5432/app',
  'DB_PASSWORD=prod-password-77',
  'LOG_LEVEL=info',
].join('\n');

/** `local.env` — a quiet third row: no sensitivity, no usage, no warnings. */
const LOCAL_CONTENT = ['DEBUG=true', 'PORT=13000'].join('\n');

/** The sessions the server would name for `prod.env` — including none of the fixture's own. */
const PROD_IN_USE_BY = ['api-tests', 'deploy'];

const FILES: EnvFileInfo[] = [
  {
    name: 'staging.env',
    source: 'server',
    size: STAGING_CONTENT.length,
    modified: 1756684800,
    var_count: 6,
  },
  {
    name: 'prod.env',
    source: 'agent',
    agent_id: 'devbox-01',
    size: PROD_CONTENT.length,
    modified: 1756598400,
    var_count: 4,
  },
  {
    name: 'local.env',
    source: 'agent',
    agent_id: 'devbox-01',
    size: LOCAL_CONTENT.length,
    modified: 1756512000,
    var_count: 2,
  },
];

function contentFor(payload: Record<string, unknown>): EnvGetResponse {
  const key = `${String(payload.source)}:${String(payload.agent_id ?? '')}:${String(payload.name)}`;
  if (key === 'server::staging.env') {
    return { success: true, content: STAGING_CONTENT, in_use_by: [] };
  }
  if (key === 'agent:devbox-01:prod.env') {
    return { success: true, content: PROD_CONTENT, in_use_by: PROD_IN_USE_BY };
  }
  if (key === 'agent:devbox-01:local.env') {
    return { success: true, content: LOCAL_CONTENT, in_use_by: [] };
  }
  return { success: false, error: `env file not found: ${String(payload.name)}` };
}

/** The files the selected Session has sourced — asked per session, like the server. */
function activeFor(sessionId: unknown): SessionEnvActiveResponse {
  if (sessionId !== FIXTURE_SELECTED_ID) {
    return { active: [] };
  }
  const active: ActiveEnvFile[] = [{ name: 'staging.env', source: 'server', phase: 'attach' }];
  return { active };
}

export function fixtureEnvSurface(search: string): PluginSurface {
  const scenario = new URLSearchParams(search).get('env') ?? 'profiles';
  const list: EnvListResponse = scenario === 'empty' ? { files: [] } : { files: FILES };

  // The real directory is filled from the agent list; the fixture fills the
  // same directory from the same FIXTURE_AGENTS the rest of the route renders
  // (same move as fixtureGitSurface).
  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(FIXTURE_AGENTS));

  return {
    connectionState: 'connected',
    protocols,
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      if (type === ENV_LIST_WIRE) {
        return Promise.resolve(list as T);
      }
      if (type === ENV_GET_WIRE) {
        return Promise.resolve(contentFor(payload) as T);
      }
      if (type === SESSION_ENV_ACTIVE_WIRE) {
        return Promise.resolve(activeFor(payload.session_id) as T);
      }
      return Promise.reject(new Error(`fixture env surface is read-only and does not answer ${type}`));
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
}
