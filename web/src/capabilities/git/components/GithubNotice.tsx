import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import type { GithubError } from '../githubTypes';

const FRIENDLY: Record<string, string> = {
  not_a_repository: 'This Session is not in a Git repository.',
  no_github_remote: 'This repository has no GitHub remote.',
  ambiguous_remote: 'More than one GitHub remote was found. Choose one below.',
  host_not_allowed: 'This repository host is not approved for authenticated GitHub reads.',
  client_unavailable: 'The Agent could not start its GitHub client.',
  not_authenticated:
    'The Agent has no GitHub credential. Set GITHUB_TOKEN or GH_TOKEN on the Agent host.',
  access_denied: 'GitHub denied access to this repository.',
  not_found: 'GitHub could not find this item.',
  rate_limited: 'GitHub rate limit reached.',
  network_unavailable: 'GitHub could not be reached.',
  timeout: 'The GitHub request timed out.',
  api_error: 'GitHub returned an API error.',
  malformed_response: 'GitHub returned a response Nession could not read.',
};

function githubErrorMessage(error: GithubError): string {
  const message = FRIENDLY[error.code] ?? error.message;
  if (error.code === 'rate_limited' && error.retryAfterSeconds) {
    return `${message} Retry after ${error.retryAfterSeconds}s.`;
  }
  return message;
}

/** A scoped explanation with an optional retry; never a fake empty state. */
export function GithubNotice({
  error,
  testId,
  onRetry,
  children,
}: {
  error?: GithubError | null;
  testId?: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={cn('flex min-h-0 flex-col items-start gap-3 px-4 py-4', chromeSansRole('body'))}
    >
      <p className="text-muted-foreground">
        {error ? githubErrorMessage(error) : children}
      </p>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={() => onRetry()}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
