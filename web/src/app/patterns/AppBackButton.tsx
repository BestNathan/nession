import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { shellIconButtonClass } from '@/app/shellStyles';

export interface AppBackButtonProps {
  /** Accessible name for the affordance (e.g. "Back to files"). */
  label: string;
  /** Test id for the button (per-page, so tests can pick the right back). */
  testid: string;
  onClick: () => void;
}

/**
 * App back affordance: 44px ghost icon button with the shared motion tokens.
 *
 * The physical affordance every App depth's Back renders through, so the pushed
 * detail's Back and the capability root's Back cannot drift apart (#1051).
 */
export function AppBackButton({ label, testid, onClick }: AppBackButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={shellIconButtonClass}
      aria-label={label}
      data-testid={testid}
      onClick={onClick}
    >
      <ChevronLeft className="size-5" />
    </Button>
  );
}
