import { useState } from 'react';
import { GitCommitHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/shared/lib/utils';
import { chromeLabelRole, chromeSansRole } from '@/shared/typography/chromeRoles';

function files(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`;
}

/**
 * Commit authoring for the staged index (#845).
 *
 * The confirmation is deliberately heavier than stage/unstage: a commit is the
 * one action here that writes history, runs the repository's hooks and cannot
 * be undone from Nession. It states the staged count, the exact message and
 * what the Agent host will execute before anything is sent.
 */
export function GitCommitForm({
  stagedCount,
  busy,
  onCommit,
}: {
  stagedCount: number;
  busy: boolean;
  onCommit: (message: string) => Promise<boolean>;
}) {
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);
  const trimmed = message.trim();
  const canCommit = stagedCount > 0 && trimmed.length > 0 && !busy;

  return (
    <div data-testid="git-commit-form" className="space-y-2 border-b p-3">
      <label
        htmlFor="git-commit-message"
        className={cn('text-muted-foreground', chromeLabelRole())}
      >
        Commit message
      </label>
      <Textarea
        id="git-commit-message"
        data-testid="git-commit-message"
        value={message}
        rows={2}
        disabled={busy}
        placeholder={
          stagedCount > 0
            ? `Describe the ${files(stagedCount)} in the index`
            : 'Stage a change to commit it'
        }
        onChange={(event) => setMessage(event.target.value)}
        className="min-h-14 resize-none"
      />
      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={!canCommit}
        data-testid="git-commit"
        onClick={() => setConfirming(true)}
      >
        <GitCommitHorizontal className="h-3.5 w-3.5" aria-hidden />
        Commit {stagedCount > 0 ? files(stagedCount) : ''}
      </Button>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="git-commit-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Create this commit?</AlertDialogTitle>
            <AlertDialogDescription>
              Nession commits the {files(stagedCount)} in the index on the Agent host using its
              Git identity. Repository hooks and signing still run. This cannot be undone from
              Nession.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-40 overflow-y-auto rounded-[var(--nession-radius-control)] border bg-muted p-2">
            <p className={cn('whitespace-pre-wrap break-words', chromeSansRole('secondary'))}>
              {trimmed}
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="git-commit-confirm"
              onClick={() => {
                void onCommit(trimmed).then((created) => {
                  if (created) {
                    setMessage('');
                  }
                });
              }}
            >
              Commit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
