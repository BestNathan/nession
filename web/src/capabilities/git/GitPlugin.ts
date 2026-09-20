import {
  PROTOCOL as BRANCHES_PROTOCOL,
  VERSION as BRANCHES_VERSION,
  WIRE as BRANCHES_WIRE,
} from '@/generated/protocol/git/branches/v1';
import {
  PROTOCOL as DIFF_PROTOCOL,
  VERSION as DIFF_VERSION,
  WIRE as DIFF_WIRE,
} from '@/generated/protocol/git/diff/v1';
import {
  PROTOCOL as LOG_PROTOCOL,
  VERSION as LOG_VERSION,
  WIRE as LOG_WIRE,
} from '@/generated/protocol/git/log/v1';
import {
  PROTOCOL as ROOT_PROTOCOL,
  VERSION as ROOT_VERSION,
  WIRE as ROOT_WIRE,
} from '@/generated/protocol/git/root/v1';
import {
  PROTOCOL as STATUS_PROTOCOL,
  VERSION as STATUS_VERSION,
  WIRE as STATUS_WIRE,
} from '@/generated/protocol/git/status/v1';
import {
  PROTOCOL as WORKTREES_PROTOCOL,
  VERSION as WORKTREES_VERSION,
  WIRE as WORKTREES_WIRE,
} from '@/generated/protocol/git/worktrees/v1';
import { addressedPayload } from '@/platform/protocol';
import type { TransportPlugin, PluginSurface } from '@/platform/socket/types';
import type {
  GitBranchesRequest,
  GitBranchesResponse,
  GitDiffRequest,
  GitDiffResponse,
  GitLogRequest,
  GitLogResponse,
  GitRootResponse,
  GitStatusRequest,
  GitStatusResponse,
  GitWorktreesResponse,
} from './types';

/**
 * The contract versions this client can read, per unit (`#678`, Phase 4).
 *
 * A **Consumer Requirement** in the design's terms: not what any agent offers,
 * but what this capability was written against. Both halves now come from the
 * generated bindings rather than from a comment — the id and the version are
 * read out of the contract that produced the TypeScript, so a version bump in
 * Rust moves this with it instead of leaving a stale number behind.
 *
 * The import path is the third half: `git/status/v1` is the shape these types
 * *are*. If the contract moved to v2, this file would import `v2` and the
 * numbers below would change with it, or the build would fail — either way not
 * silently.
 */
const CONSUMER_REQUIREMENTS = {
  [STATUS_PROTOCOL]: [STATUS_VERSION],
  [DIFF_PROTOCOL]: [DIFF_VERSION],
  [ROOT_PROTOCOL]: [ROOT_VERSION],
  [LOG_PROTOCOL]: [LOG_VERSION],
  [BRANCHES_PROTOCOL]: [BRANCHES_VERSION],
  [WORKTREES_PROTOCOL]: [WORKTREES_VERSION],
} as const satisfies Record<string, readonly number[]>;

type GitUnit = keyof typeof CONSUMER_REQUIREMENTS;

/**
 * git capability — repository state and file diffs for the current Session
 * (`extension.git.{status,diff,root}`, #750).
 *
 * The request objects are forwarded whole, exactly as the Claude Code plugin
 * does: the transport never sees individual fields. The wire strings and the
 * protocol ids are **not** written here any more — they are the generated
 * bindings, so they cannot disagree with the Rust. Consumers import the typed
 * API.
 *
 * One field is added on the way past: `contract_version`, resolved per target
 * from what that agent advertises against what this client speaks
 * ({@link CONSUMER_REQUIREMENTS}). A target that advertised no manifest is a
 * Legacy Peer and gets the request exactly as it always went — naming no
 * version is not a downgrade, it is the absence of a claim.
 *
 * **Read-only.** The agent refuses mutating subcommands outright, so there is
 * deliberately no method here that could ask for one. #750 SC5 asserts the view
 * contains no control that would; this class is the other half of that — there
 * is nothing to call.
 */
export class GitPlugin implements TransportPlugin {
  readonly name = 'git';

  private connection: PluginSurface | null = null;
  private generation = 0;

  /**
   * Bind the plugin to a connection. A later install replaces an earlier
   * binding (same instance, new surface — StrictMode remount); the teardown is
   * generation-guarded so a stale release cannot detach the newer binding.
   */
  install(connection: PluginSurface): () => void {
    const generation = ++this.generation;
    this.connection = connection;
    return () => {
      if (this.generation === generation && this.connection === connection) {
        this.connection = null;
      }
    };
  }

  /** Branch, upstream relationship and changed files for a Session's repository. */
  async gitStatus(req: GitStatusRequest): Promise<GitStatusResponse> {
    return this.requireConnection().request<GitStatusResponse>(
      STATUS_WIRE,
      this.addressed(STATUS_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * One file's diff against HEAD.
   *
   * `path` is repository-relative and the agent validates it before spawning
   * anything, so an escaping path is refused there; nothing is checked here
   * because a client-side check would be a second, weaker boundary.
   */
  async gitDiff(req: GitDiffRequest): Promise<GitDiffResponse> {
    return this.requireConnection().request<GitDiffResponse>(
      DIFF_WIRE,
      this.addressed(DIFF_PROTOCOL, req.agent_id, req),
    );
  }

  /** The repository root — the context a Workspace handoff carries (#826). */
  async gitRoot(req: GitStatusRequest): Promise<GitRootResponse> {
    return this.requireConnection().request<GitRootResponse>(
      ROOT_WIRE,
      this.addressed(ROOT_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * Recent commits on the current branch.
   *
   * `limit` is a request the agent clamps, not a guarantee — a caller cannot
   * ask a remote host to build an unbounded answer.
   */
  async gitLog(req: GitLogRequest): Promise<GitLogResponse> {
    return this.requireConnection().request<GitLogResponse>(
      LOG_WIRE,
      this.addressed(LOG_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * Local branches and their tracking state.
   *
   * Answers what the Workspace header cannot: the header knows the current
   * branch and how far it is from its upstream, and nothing about the others.
   */
  async gitBranches(req: GitBranchesRequest): Promise<GitBranchesResponse> {
    return this.requireConnection().request<GitBranchesResponse>(
      BRANCHES_WIRE,
      this.addressed(BRANCHES_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * The repository's worktrees, with the Session's own marked.
   *
   * `current` is decided agent-side, where the Session's working directory is
   * known, rather than here by comparing a path the view was handed.
   */
  async gitWorktrees(req: GitStatusRequest): Promise<GitWorktreesResponse> {
    return this.requireConnection().request<GitWorktreesResponse>(
      WORKTREES_WIRE,
      this.addressed(WORKTREES_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * The payload to address `unit` to `agentId` with.
   *
   * Every method goes through here, and that is the point: resolution is per
   * target (`#678` Phase 4 — the Web reaches several agents through one server,
   * and one agent's versions say nothing about another's), so it cannot be done
   * once for the connection and cached. It is a map lookup on the way past;
   * there is nothing here worth caching and a cache would be a stale manifest
   * waiting to happen.
   */
  private addressed(
    unit: GitUnit,
    agentId: string,
    req: { session: string },
  ): Record<string, unknown> {
    const connection = this.requireConnection();
    return addressedPayload({
      unit,
      target: agentId,
      requirements: CONSUMER_REQUIREMENTS[unit],
      manifest: connection.protocols.manifestFor(agentId),
      payload: { ...req },
    });
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('git capability is not connected');
    }
    return this.connection;
  }
}

/**
 * App-level singleton — one git binding per WebSocketService lifetime.
 *
 * Defined here rather than in `index.ts` for the reason the Claude Code plugin
 * records: the barrel re-exports the contribution, the contribution imports the
 * view, and the view imports this module. Declaring the singleton in the barrel
 * would close that into a cycle.
 */
export const gitApi = new GitPlugin();
