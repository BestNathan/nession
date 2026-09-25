import { ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/shared/lib/utils';
import { capsuleIconButtonClass } from '@/product/terminal/capsule/capsuleStyles';

interface CapsuleInputActionButtonsProps {
  inputValue: string;
  disabled: boolean;
  onSend: () => void;
  /** Tooltips intercept touch on mobile — app surfaces rely on aria-label instead. */
  showTooltips?: boolean;
}

function CapsuleIconAction({
  showTooltips,
  tooltip,
  button,
}: {
  showTooltips: boolean;
  tooltip: string;
  button: React.ReactElement;
}) {
  if (!showTooltips) {
    return button;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="top">
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The composer's primary action, and the only one of them.
 *
 * The capsule used to mirror native paste/copy here. `terminal-capsule.md`
 * §Anti-patterns names that directly ("duplicating native copy/paste/selection
 * actions as Nession capabilities"), and the intended-entry surface is the
 * platform's own long-press/selection affordances — so the capsule carries
 * neither, on either experience.
 */
export function CapsuleInputActionButtons({
  inputValue,
  disabled,
  onSend,
  showTooltips = true,
}: CapsuleInputActionButtonsProps) {
  const canSend = !disabled && Boolean(inputValue.trim());

  return (
    <CapsuleIconAction
      showTooltips={showTooltips}
      tooltip="Send (Enter)"
      button={
        <Button
          type="button"
          size="icon"
          disabled={!canSend}
          data-testid="capsule-send"
          aria-label="Send"
          className={cn(
            capsuleIconButtonClass,
            'rounded-full border-0',
            canSend
              ? 'bg-foreground text-background hover:bg-foreground/90'
              : 'bg-muted text-muted-foreground',
          )}
          onClick={onSend}
        >
          <ArrowUp />
        </Button>
      }
    />
  );
}
