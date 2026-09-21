/**
 * The git capability's names for the wire types (`git.*`, #750).
 *
 * **These are aliases, not mirrors.** Every shape here is derived from the
 * generated bindings in `@/generated/protocol/git/…`, which are generated from
 * the Rust contracts — so there is nothing to keep in step by hand. Until
 * `#678` Phase 5 this file was 238 lines of hand-copied shapes, and the only
 * thing holding them to the Rust was that someone had read both.
 *
 * The aliases exist because a capability is allowed its own vocabulary: inside
 * a git capability `GitStatus` reads better than `RepoStatus`, and the `Git`
 * prefix is what distinguishes a wire shape from the many other `status`
 * variables in a view. What they must not do is restate a field — if a shape
 * needs changing, it changes in Rust and `just codegen` carries it here.
 *
 * `agent_id` is the one thing the generated types do not have, and cannot:
 * routing is not part of the contract, so the request aliases add it themselves
 * rather than the contract pretending to know about it.
 */

import {
  type ChangeKind,
  type ChangedFile,
  type RepoStatus,
  type SessionTargetV1,
  type StatusResponse,
} from '@/generated/protocol/git/status/v1';
import {
  type DiffRequest,
  type DiffResponse,
  type FileDiff,
} from '@/generated/protocol/git/diff/v1';
import {
  type Commit,
  type History,
  type LogRequest,
  type LogResponse,
} from '@/generated/protocol/git/log/v1';
import {
  type Branch,
  type Branches,
  type BranchesRequest,
  type BranchesResponse,
} from '@/generated/protocol/git/branches/v1';
import type { RootResponse } from '@/generated/protocol/git/root/v1';
import {
  type Worktree,
  type Worktrees,
  type WorktreesRequest,
  type WorktreesResponse,
} from '@/generated/protocol/git/worktrees/v1';

/**
 * Requests, with the routing field the contract does not carry.
 *
 * `session` names the Session; the agent resolves its working directory from
 * tmux and ignores any path a client sends (#750 C2).
 */
export type GitStatusRequest = SessionTargetV1 & { agent_id: string };
export type GitDiffRequest = DiffRequest & { agent_id: string };
export type GitLogRequest = LogRequest & { agent_id: string };
export type GitBranchesRequest = BranchesRequest & { agent_id: string };
export type GitWorktreesRequest = WorktreesRequest & { agent_id: string };

/** The capability's names for the responses. */
export type GitStatusResponse = StatusResponse;
export type GitDiffResponse = DiffResponse;
export type GitLogResponse = LogResponse;
export type GitBranchesResponse = BranchesResponse;
export type GitRootResponse = RootResponse;
export type GitWorktreesResponse = WorktreesResponse;

/** The capability's names for the payload shapes. */
export type GitChangeKind = ChangeKind;
export type GitChangedFile = ChangedFile;
export type GitStatus = RepoStatus;
export type GitFileDiff = FileDiff;
export type GitCommit = Commit;
export type GitHistory = History;
export type GitBranch = Branch;
export type GitBranches = Branches;
export type GitWorktree = Worktree;
export type GitWorktrees = Worktrees;

/**
 * The non-ok answers, as one type.
 *
 * `Exclude` rather than a restatement: the generated response is a
 * discriminated union on `state`, so "everything that is not ok" is a set
 * operation on it. Writing the variants out by hand is exactly the copy this
 * file stopped keeping — and it would silently miss a fifth state added in
 * Rust, where an extra union member here is checked by the compiler.
 *
 * They are *not* failures of the request: "this directory is not a repository"
 * is an answer, and #750 SC4 requires each be tellable apart.
 */
export type GitUnavailable = Exclude<GitStatusResponse, { state: 'ok' }>;
export type GitUnavailableState = GitUnavailable['state'];

/** The ok member of each response, for a view that has already narrowed. */
export type GitStatusOk = Extract<GitStatusResponse, { state: 'ok' }>;
export type GitDiffOk = Extract<GitDiffResponse, { state: 'ok' }>;
export type GitLogOk = Extract<GitLogResponse, { state: 'ok' }>;
export type GitBranchesOk = Extract<GitBranchesResponse, { state: 'ok' }>;
export type GitRootOk = Extract<GitRootResponse, { state: 'ok' }>;
export type GitWorktreesOk = Extract<GitWorktreesResponse, { state: 'ok' }>;

export function isOk<T extends { state: string }>(
  response: T | GitUnavailable,
): response is T & { state: 'ok' } {
  return response.state === 'ok';
}
