import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import type {
  ActiveEnvFile,
  EnvFileInfo,
  EnvFileRef,
  EnvGetResponse,
  EnvListResponse,
  SessionEnvActiveResponse,
  SessionEnvBindingResponse,
} from '@/capabilities/env';
import { WIRE as ENV_LIST_WIRE } from '@/generated/protocol/core/server-env-list/v1';
import { WIRE as ENV_GET_WIRE } from '@/generated/protocol/core/server-env-get/v1';
import { WIRE as SESSION_ENV_ACTIVE_WIRE } from '@/generated/protocol/core/server-session-env-active/v1';
import { WIRE as SESSION_ENV_BINDING_GET_WIRE } from '@/generated/protocol/core/server-session-env-binding-get/v1';
import { WIRE as SESSION_ENV_BINDING_SET_WIRE } from '@/generated/protocol/core/server-session-env-binding-set/v1';
import { WIRE as SESSION_ENV_BINDING_REAPPLY_WIRE } from '@/generated/protocol/core/server-session-env-binding-reapply/v1';
import { FIXTURE_AGENTS, FIXTURE_SELECTED_ID } from './fixtureData';

/**
 * A canned env backend for the fixture route (#1202, Session-first in #2654).
 *
 * The fixture is offline, so the Environment capability has nothing to talk
 * to. This stands in for the server's `server.env.*` answers with
 * deterministic data, which is what lets the canonical route render the
 * context-first surfaces at all — and therefore what lets e2e assert the
 * #1202/#2654 states (masked sensitive value, empty value, skipped line,
 * Session-first binding, ordered draft, pending/unsupported/outdated
 * disclosure) against real DOM rather than against a jsdom mock.
 *
 * The states emerge from the *files*, never from a named view: a route can
 * ask for the empty inventory (`env=empty`), but "the masked row" exists
 * because `staging.env` contains a key that matches the shared sensitive
 * pattern, and the in-use dialog exists because `prod.env` is used by two
 * sessions. A fixture that named states directly would let a test assert a
 * rendering the app never decided on.
 *
 * Binding SET/REAPPLY mutate an in-memory revision, because a replace-whole
 * selection is exactly what the fixture can simulate: the follow-up read
 * answers the new state, so the draft's Apply → Session overview flow is a
 * state the product really produces. Content writes and deletes stay
 * rejected: a stateless fixture that answered success would render a follow-up
 * state the product cannot produce (the "saved" content would be gone on the
 * next read). Specs drive those dialogs up to confirmation, not past it.
 *
 *   /#/fixture/workspace?capability=env                  → Session overview, in sync
 *   /#/fixture/workspace?capability=env&env=empty        → no profiles, no binding
 *   /#/fixture/workspace?capability=env&env=pending      → waiting for the next prompt
 *   /#/fixture/workspace?capability=env&env=outdated     → source changed; Reapply
 *   /#/fixture/workspace?capability=env&env=unsupported  → tmux applied, shell unsupported
 *   /#/fixture/workspace?capability=env&env=error        → materialization failed
 *   /#/fixture/workspace?capability=env&env=unavailable  → Agent did not report
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

const BINDING_REF: EnvFileRef = { name: 'staging.env', source: 'server' };

/** The keys a profile would manage, derived from the content the fixture serves. */
const KEYS: Record<string, string[]> = {
  'server::staging.env': ['API_BASE', 'API_KEY', 'EMPTY_OVERRIDE', 'FEATURE_FLAGS', 'LOG_LEVEL', 'NODE_ENV'],
  'agent:devbox-01:prod.env': ['DATABASE_URL', 'DB_PASSWORD', 'LOG_LEVEL', 'NODE_ENV'],
  'agent:devbox-01:local.env': ['DEBUG', 'PORT'],
};

function refIdentity(ref: EnvFileRef): string {
  return `${ref.source}:${ref.agent_id ?? ''}:${ref.name}`;
}

function managedKeys(refs: EnvFileRef[]): string[] {
  const keys = new Set<string>();
  for (const ref of refs) {
    for (const key of KEYS[refIdentity(ref)] ?? []) {
      keys.add(key);
    }
  }
  return [...keys];
}

interface BindingShape {
  status: string;
  shell: string | null;
  shellRevision: number | null;
  lastError: string | null;
  outdated: boolean;
}

const IN_SYNC: BindingShape = {
  status: 'in_sync',
  shell: 'bash',
  shellRevision: null,
  lastError: null,
  outdated: false,
};

/**
 * Render the desired + observed state for an ordered selection. `applied`
 * describes how far the Agent got; the fixture never invents convergence.
 */
function bindingState(
  refs: EnvFileRef[],
  desiredRevision: number,
  appliedRevision: number,
  shape: BindingShape,
): SessionEnvBindingResponse {
  const desired = refs.map((profile) => ({
    profile,
    phase: 'attach',
    content_hash: null,
    outdated: shape.outdated,
  }));
  return {
    success: true,
    binding: {
      session_id: FIXTURE_SELECTED_ID,
      desired_revision: desiredRevision,
      desired_profiles: desired,
      observed: {
        applied_revision: appliedRevision,
        status: shape.status,
        profiles: refs,
        managed_keys: managedKeys(refs),
        shell: shape.shell,
        shell_revision: shape.shellRevision,
        last_error: shape.lastError,
      },
    },
    warnings: [],
  };
}

/** The current Session's binding at the start of a scenario. */
function bindingFor(scenario: string): SessionEnvBindingResponse {
  if (scenario === 'empty') {
    return {
      success: true,
      binding: {
        session_id: FIXTURE_SELECTED_ID,
        desired_revision: 0,
        desired_profiles: [],
      },
      warnings: [],
    };
  }
  if (scenario === 'pending') {
    return bindingState([BINDING_REF], 4, 4, {
      status: 'pending_shell',
      shell: 'bash',
      shellRevision: null,
      lastError: null,
      outdated: false,
    });
  }
  if (scenario === 'outdated') {
    return bindingState([BINDING_REF], 4, 3, {
      status: 'in_sync',
      shell: 'bash',
      shellRevision: 3,
      lastError: null,
      outdated: true,
    });
  }
  if (scenario === 'unsupported') {
    return bindingState([BINDING_REF], 3, 3, {
      status: 'unsupported_shell',
      shell: 'fish',
      shellRevision: null,
      lastError: 'No Session-local adapter for shell /usr/bin/fish.',
      outdated: false,
    });
  }
  if (scenario === 'error') {
    return bindingState([BINDING_REF], 3, 2, {
      status: 'error',
      shell: 'bash',
      shellRevision: 2,
      lastError: 'Failed to write the Session environment: permission denied.',
      outdated: false,
    });
  }
  return bindingState([BINDING_REF], 3, 3, {
    ...IN_SYNC,
    shellRevision: 3,
  });
}

/** Apply a new ordered selection: materialization waits for the next prompt. */
function afterSet(binding: SessionEnvBindingResponse, refs: EnvFileRef[]): SessionEnvBindingResponse {
  const current = binding.binding;
  const revision = (current?.desired_revision ?? 0) + 1;
  if (refs.length === 0) {
    return {
      success: true,
      binding: {
        session_id: FIXTURE_SELECTED_ID,
        desired_revision: revision,
        desired_profiles: [],
        observed: {
          applied_revision: revision,
          status: 'in_sync',
          profiles: [],
          managed_keys: [],
          shell: 'bash',
          shell_revision: revision,
          last_error: null,
        },
      },
      warnings: [],
    };
  }
  return bindingState(refs, revision, current ? current.observed?.applied_revision ?? 0 : 0, {
    status: 'pending_shell',
    shell: 'bash',
    shellRevision: null,
    lastError: null,
    outdated: false,
  });
}

/**
 * Reapply re-resolves the desired selection at a new revision. A shell that
 * has no adapter, or a materialization error, stays that way — reapply is a
 * retry, not a different shell.
 */
function afterReapply(binding: SessionEnvBindingResponse): SessionEnvBindingResponse {
  const current = binding.binding;
  if (!current) {
    return binding;
  }
  const refs = current.desired_profiles.map((entry) => entry.profile);
  const revision = current.desired_revision + 1;
  const observed = current.observed;
  if (observed?.status === 'unsupported_shell' || observed?.status === 'error') {
    return bindingState(refs, revision, observed.applied_revision, {
      status: observed.status,
      shell: observed.shell ?? null,
      shellRevision: observed.shell_revision ?? null,
      lastError: observed.last_error ?? null,
      outdated: false,
    });
  }
  return bindingState(refs, revision, revision, {
    status: 'in_sync',
    shell: observed?.shell ?? 'bash',
    shellRevision: revision,
    lastError: null,
    outdated: false,
  });
}

export function fixtureEnvSurface(search: string): PluginSurface {
  const scenario = new URLSearchParams(search).get('env') ?? 'profiles';
  const list: EnvListResponse = scenario === 'empty' ? { files: [] } : { files: FILES };
  // The binding is the one mutable piece: SET and REAPPLY change the revision
  // this surface answers from then on.
  let binding = bindingFor(scenario);

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
      if (type === SESSION_ENV_BINDING_GET_WIRE) {
        if (scenario === 'unavailable') {
          return Promise.reject(new Error('Agent did not report the Session environment'));
        }
        return Promise.resolve(binding as T);
      }
      if (type === SESSION_ENV_BINDING_SET_WIRE) {
        const refs = Array.isArray(payload.profiles)
          ? (payload.profiles as EnvFileRef[])
          : [];
        binding = afterSet(binding, refs);
        return Promise.resolve(binding as T);
      }
      if (type === SESSION_ENV_BINDING_REAPPLY_WIRE) {
        binding = afterReapply(binding);
        return Promise.resolve(binding as T);
      }
      return Promise.reject(new Error(`fixture env surface does not answer ${type}`));
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
