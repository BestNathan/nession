export { GitPlugin, gitApi } from './GitPlugin';
export { isOk } from './types';
export type {
  GitChangedFile,
  GitChangeKind,
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
} from './types';

/** What this capability contributes to the shell: its presence state and view. */
export { GIT_ID, GIT_TITLE, gitView, resolveGitState } from './contribution';
