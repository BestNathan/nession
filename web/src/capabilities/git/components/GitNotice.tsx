import type { ReactNode } from 'react';

/**
 * The panel a git section shows when it has no list to show.
 *
 * Every section needs the same four: still reading, could not reach the agent,
 * the agent answered with a state rather than a listing, and an answer that is
 * legitimately empty. They are one component because they are one thing — a
 * centred line where the list would be — and four copies would be four chances
 * for one section to grow a heading or a colour the others do not have.
 *
 * `destructive` is only for a transport failure. A repository with no commits,
 * or a Session that is not in a repository, are states and not errors, which is
 * why `#750` SC4 requires them to be tellable apart in the first place.
 */
export function GitNotice({
  testId,
  destructive,
  children,
}: {
  testId: string;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex h-full min-h-0 items-center justify-center px-6 text-center"
    >
      <p
        role={destructive ? 'alert' : undefined}
        className={
          destructive ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'
        }
      >
        {children}
      </p>
    </div>
  );
}
