import type {
  GitChangedFile,
  GitStatus,
  GitUnavailable,
  GitUnavailableState,
} from './types';

/**
 * The repository listing, shaped for the view.
 *
 * A discriminated union rather than one row type with an `expandable` flag: #750
 * SC2 says an untracked entry has **no** expander, and a boolean would let a
 * later refactor flip it without the type system noticing. Here, an untracked row
 * carries no `file`, so a row that could request a diff cannot be built for one.
 */
export type GitRow =
  /** Tracked and changed — has a diff to show, so it is selectable. */
  | { kind: 'tracked'; path: string; file: GitChangedFile }
  /** Untracked — git has no diff for it, so the row is inert. */
  | { kind: 'untracked'; path: string }
  /** Mid-merge/rebase conflict. Listed apart: git reports no ordinary change for it. */
  | { kind: 'unmerged'; path: string };

export function statusRows(status: GitStatus): GitRow[] {
  return [
    ...status.unmerged.map((path): GitRow => ({ kind: 'unmerged', path })),
    ...status.modified.map(
      (file): GitRow => ({ kind: 'tracked', path: file.path, file }),
    ),
    ...status.untracked.map((path): GitRow => ({ kind: 'untracked', path })),
  ];
}

/** Whether a row can be opened. The one place that question is answered. */
export function isSelectable(row: GitRow): row is Extract<GitRow, { kind: 'tracked' }> {
  return row.kind === 'tracked';
}

/**
 * What the header says under the branch name.
 *
 * `visual-language.md` P6: a clean working tree is a healthy state — no green,
 * no badge, no celebratory copy. It says what is true and stops.
 */
export function describeStatus(status: GitStatus): string {
  const parts: string[] = [];

  if (status.ahead > 0) {
    parts.push(`${status.ahead} ahead`);
  }
  if (status.behind > 0) {
    parts.push(`${status.behind} behind`);
  }

  const changed = status.modified.length;
  const untracked = status.untracked.length;
  const unmerged = status.unmerged.length;

  // Conflicts first and in their own words: a merge in progress is not "3
  // modified", and saying so would be the "pretend it is clean" failure the
  // issue's edge-case table names.
  if (unmerged > 0) {
    parts.push(`${count(unmerged, 'conflicted file')}`);
  }
  if (changed > 0) {
    parts.push(`${count(changed, 'changed file')}`);
  }
  if (untracked > 0) {
    parts.push(`${count(untracked, 'untracked file')}`);
  }

  if (parts.length === 0) {
    return 'Working tree clean';
  }
  return parts.join(', ');
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export interface UnavailableCopy {
  title: string;
  /** What the user can do about it. Absent when there is nothing to offer. */
  detail?: string;
}

const UNAVAILABLE_TITLES: Record<GitUnavailableState, string> = {
  // `reason` refines this one below; the state alone is not specific enough to
  // say whether the problem is the tool host or the directory.
  unavailable: 'Repository state is unavailable',
  not_a_repository: 'This Session is not in a git repository',
  error: 'Could not read repository state',
};

const UNAVAILABLE_DETAILS: Record<GitUnavailableState, string | undefined> = {
  unavailable: undefined,
  not_a_repository:
    "Nession reads the repository of the directory this Session is sitting in. Change it to a repository's directory, or open a Session that is already there.",
  error: 'The agent reported a problem reading the repository. Try again.',
};

/**
 * Readable copy for each failure state (#750 SC4).
 *
 * The four states are kept apart on purpose — "no git installed" and "not a
 * repository" have different fixes, and collapsing them into one blank panel is
 * what the criterion exists to prevent. A state the agent sent with its own
 * `message` keeps that message as the detail: it knows more than this does.
 */
export function describeUnavailable(response: GitUnavailable): UnavailableCopy {
  const title = UNAVAILABLE_TITLES[response.state];

  if (response.reason === 'session_workdir_unknown') {
    return {
      title: "Nession can't find this Session's directory",
      detail: 'The Session may have exited. Reopen it, or pick another Session.',
    };
  }
  if (response.reason === 'git_not_installed') {
    return {
      title: 'git is not installed on this host',
      detail: 'Install git on the machine running this Session, then try again.',
    };
  }

  return {
    title,
    detail: response.message ?? UNAVAILABLE_DETAILS[response.state],
  };
}

/** How a unified-diff line reads. `+++`/`---` are headers, not changes. */
export function classifyDiffLine(line: string): 'meta' | 'added' | 'removed' | 'context' {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
    return 'meta';
  }
  if (line.startsWith('+')) {
    return 'added';
  }
  if (line.startsWith('-')) {
    return 'removed';
  }
  return 'context';
}

/** Bytes as a size a person reads. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
