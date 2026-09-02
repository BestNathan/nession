import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { shellIconButtonClass } from '@/session-first/shellStyles';

export interface AppBackButtonProps {
  /** Accessible name for the affordance (e.g. "Back to files"). */
  label: string;
  /** Test id for the button (per-page, so tests can pick the right back). */
  testid: string;
  onClick: () => void;
}

/**
 * App back affordance: 44px ghost icon button with the shared motion tokens.
 * Used by the workspace page header and tool-internal sub-headers — top-level
 * navigation and push/pop both render the same physical affordance.
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
