import type { ReactNode } from 'react';
import { ArrowLeft, Columns2 } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * The list/reader split #1290 asks for.
 *
 * On a wide surface the list and the reader scroll independently; selecting a
 * row changes only the reader. On a narrow surface the list is the first level
 * and the reader is a full-width pushed view with an explicit Back. The list
 * stays mounted while hidden, so returning restores its scroll position.
 */
export function GithubReaderLayout({
  testId,
  listTestId,
  readerTestId,
  list,
  reader,
  selected,
  detailOpen,
  focusReading,
  onFocusReading,
  onBack,
}: {
  testId: string;
  listTestId: string;
  readerTestId: string;
  list: ReactNode;
  reader: ReactNode;
  selected: boolean;
  /** Narrow-surface push state; the wide reader ignores it. */
  detailOpen?: boolean;
  focusReading: boolean;
  onFocusReading: (value: boolean) => void;
  onBack: () => void;
}) {
  const pushed = detailOpen ?? selected;
  return (
    <div data-testid={testId} className="flex min-h-0 flex-1">
      <div
        data-testid={listTestId}
        className={cn(
          'flex min-h-0 w-full flex-col border-r md:w-[38%] md:min-w-[16rem] md:max-w-[28rem]',
          pushed && 'hidden md:flex',
          pushed && focusReading && 'md:hidden',
        )}
      >
        {list}
      </div>
      <div
        data-testid={readerTestId}
        className={cn(
          'flex min-h-0 flex-1 flex-col',
          !pushed && 'hidden md:flex',
        )}
      >
        {selected ? (
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 md:justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="github-back-to-list"
              onClick={() => onBack()}
              className="md:hidden"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              Back to list
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="github-focus-reading"
              aria-pressed={focusReading}
              onClick={() => onFocusReading(!focusReading)}
            >
              <Columns2 className="h-3.5 w-3.5" aria-hidden />
              {focusReading ? 'Show list' : 'Focus reading'}
            </Button>
          </div>
        ) : null}
        <div data-testid={`${readerTestId}-scroll`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {reader}
        </div>
      </div>
    </div>
  );
}
