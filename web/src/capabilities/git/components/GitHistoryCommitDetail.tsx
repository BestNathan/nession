import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import { describeUnavailable, formatBytes } from '../state';
import type { GitCommitChangedFile, GitCommitResponse } from '../types';

export function GitHistoryCommitDetail({
  oid,
  detail,
  loading,
  error,
  selectedFile,
  onSelectFile,
}: {
  oid: string | null;
  detail: GitCommitResponse | null;
  loading: boolean;
  error: string | null;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}) {
  if (!oid) {
    return (
      <p data-testid="git-commit-empty" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        Select a commit to see its details and changed files.
      </p>
    );
  }
  if (loading) {
    return (
      <p data-testid="git-commit-loading" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        Reading commit…
      </p>
    );
  }
  if (error) {
    return (
      <p data-testid="git-commit-error" className={cn('p-4 text-destructive', chromeSansRole('body'))}>
        {error}
      </p>
    );
  }
  if (!detail || detail.state !== 'ok') {
    return (
      <p data-testid="git-commit-unavailable" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        {detail ? describeUnavailable(detail).title : 'Commit unavailable.'}
      </p>
    );
  }

  const c = detail.commit;
  return (
    <div data-testid="git-commit-detail" className={cn('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4', workspaceScrollClearanceClass)}>
      <p className={chromeSansRole('secondary')}>{c.subject}</p>
      {c.body ? (
        <pre className={cn('whitespace-pre-wrap text-muted-foreground', chromeSansRole('metadata'))}>{c.body}</pre>
      ) : null}
      {c.messageTruncated ? (
        <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
          Message truncated — {formatBytes(c.messageTruncatedBytes)} not read.
        </p>
      ) : null}
      <dl className={cn('grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1', chromeSansRole('metadata'))}>
        <dt className="text-muted-foreground">Commit</dt>
        <dd className="truncate font-mono" title={c.oid}>
          {c.oid}
        </dd>
        <dt className="text-muted-foreground">Author</dt>
        <dd className="truncate">{c.author}</dd>
        <dt className="text-muted-foreground">Date</dt>
        <dd className="truncate" title={c.authorDate}>
          {c.authorDate}
        </dd>
        {c.decorations ? (
          <>
            <dt className="text-muted-foreground">Refs</dt>
            <dd className="truncate">{c.decorations}</dd>
          </>
        ) : null}
        {c.parents.length > 1 ? (
          <>
            <dt className="text-muted-foreground">Merge diff</dt>
            <dd className="truncate">{c.mergeDiffParent.replace('_', ' ')}</dd>
          </>
        ) : null}
      </dl>
      <div>
        <p className={cn('mb-1 text-muted-foreground', chromeSansRole('metadata'))}>Changed files</p>
        <ul data-testid="git-commit-files" className="flex flex-col gap-0.5">
          {c.files.map((file) => (
            <ChangedFileRow
              key={`${file.path}-${file.newPath ?? ''}`}
              file={file}
              selected={selectedFile === file.path}
              onSelect={() => onSelectFile(file.path)}
            />
          ))}
        </ul>
        {c.filesTruncated ? (
          <p className={cn('mt-2 text-muted-foreground', chromeSansRole('metadata'))}>
            File list truncated — {formatBytes(c.filesTruncatedBytes)} not read.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ChangedFileRow({
  file,
  selected,
  onSelect,
}: {
  file: GitCommitChangedFile;
  selected: boolean;
  onSelect: () => void;
}) {
  const label = file.newPath ? `${file.path} → ${file.newPath}` : file.path;
  return (
    <li>
      <button
        type="button"
        data-testid="git-commit-file-row"
        data-path={file.path}
        onClick={() => onSelect()}
        className={cn(
          'w-full rounded px-2 py-1 text-left hover:bg-accent',
          chromeSansRole('metadata'),
          selected && 'bg-accent',
        )}
      >
        <span className="font-mono text-muted-foreground">{file.status}</span>{' '}
        <span className="truncate">{label}</span>
        {file.binary ? (
          <span className="ml-1 text-muted-foreground">(binary)</span>
        ) : null}
      </button>
    </li>
  );
}
