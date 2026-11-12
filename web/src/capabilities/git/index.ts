export { GitPlugin, gitApi } from './GitPlugin';
export { canOpenWorktreeAsSession, normalizeWorktreePath } from './worktreeGate';
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
  GitCommitCreated,
  GitCommitDetail,
  GitCommitResponse,
  GitCreateCommitOk,
  GitCreateCommitRequest,
  GitCreateCommitResponse,
  GitDiffSource,
  GitHistory,
  GitLogOk,
  GitLogRequest,
  GitLogResponse,
  GitDiffOk,
  GitDiffRequest,
  GitDiffResponse,
  GitFileDiff,
  GitFilePreview,
  GitMutationFailure,
  GitMutationOk,
  GitMutationResponse,
  GitPreviewOk,
  GitPreviewRequest,
  GitPreviewResponse,
  GitRootOk,
  GitRootResponse,
  GitSnapshot,
  GitStageRequest,
  GitStageResponse,
  GitStatus,
  GitStatusOk,
  GitStatusRequest,
  GitStatusResponse,
  GitUnavailable,
  GitUnavailableState,
  GitUnstageRequest,
  GitUnstageResponse,
  GitWorktree,
  GitWorktrees,
  GitWorktreesOk,
  GitWorktreesResponse,
} from './types';

/** What this capability contributes to the shell: its presence state, its views. */
export { GIT_ID, GIT_TITLE, gitView, resolveGitState } from './contribution';

export { GithubPlugin, githubApi } from './GithubPlugin';
export type * from './githubTypes';
