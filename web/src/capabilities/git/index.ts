export { GitPlugin, gitApi } from './GitPlugin';
export { isOk } from './types';
export type {
  GitBranch,
  GitBranches,
  GitBranchesOk,
  GitBranchesRequest,
  GitBranchesResponse,
  GitChangedFile,
  GitChangeKind,
  GitCommit,
  GitHistory,
  GitLogOk,
  GitLogRequest,
  GitLogResponse,
  GitDiffOk,
  GitDiffRequest,
  GitDiffResponse,
  GitFileDiff,
  GitRootOk,
  GitRootResponse,
  GitStatus,
  GitStatusOk,
  GitStatusRequest,
  GitStatusResponse,
  GitUnavailable,
  GitUnavailableState,
  GitWorktree,
  GitWorktrees,
  GitWorktreesOk,
  GitWorktreesResponse,
} from './types';

/** What this capability contributes to the shell: its presence state, its views. */
export { GIT_ID, GIT_TITLE, gitProjection, gitView, resolveGitState } from './contribution';
