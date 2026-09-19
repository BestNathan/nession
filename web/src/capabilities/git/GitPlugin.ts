import type { TransportPlugin, PluginSurface } from '@/platform/socket/types';
import type {
  GitDiffRequest,
  GitDiffResponse,
  GitLogRequest,
  GitLogResponse,
  GitRootResponse,
  GitStatusRequest,
  GitStatusResponse,
} from './types';

/**
 * git capability — repository state and file diffs for the current Session
 * (`extension.git.{status,diff,root}`, #750).
 *
 * The request objects are forwarded whole, exactly as the Claude Code plugin
 * does: the transport never sees individual fields, and the wire strings live
 * only in this file. Consumers import the typed API.
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
    return this.requireConnection().request<GitStatusResponse>('extension.git.status', {
      ...req,
    });
  }

  /**
   * One file's diff against HEAD.
   *
   * `path` is repository-relative and the agent validates it before spawning
   * anything, so an escaping path is refused there; nothing is checked here
   * because a client-side check would be a second, weaker boundary.
   */
  async gitDiff(req: GitDiffRequest): Promise<GitDiffResponse> {
    return this.requireConnection().request<GitDiffResponse>('extension.git.diff', {
      ...req,
    });
  }

  /** The repository root — the context a Workspace handoff carries (#826). */
  async gitRoot(req: GitStatusRequest): Promise<GitRootResponse> {
    return this.requireConnection().request<GitRootResponse>('extension.git.root', {
      ...req,
    });
  }

  /**
   * Recent commits on the current branch.
   *
   * `limit` is a request the agent clamps, not a guarantee — a caller cannot
   * ask a remote host to build an unbounded answer.
   */
  async gitLog(req: GitLogRequest): Promise<GitLogResponse> {
    return this.requireConnection().request<GitLogResponse>('extension.git.log', {
      ...req,
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
