import { ClipboardPaste, Copy, ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { capsuleIconButtonClass } from '@/session-first/capsule/capsuleStyles';

interface CapsuleInputActionButtonsProps {
  inputValue: string;
  disabled: boolean;
  showPasteCopy: boolean;
  onSend: () => void;
  onPaste: () => void;
  onCopy: () => void;
  secondaryIconClass?: string;
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

export function CapsuleInputActionButtons({
  inputValue,
  disabled,
  showPasteCopy,
  onSend,
  onPaste,
  onCopy,
  secondaryIconClass = capsuleIconButtonClass,
  showTooltips = true,
}: CapsuleInputActionButtonsProps) {
  const canSend = !disabled && Boolean(inputValue.trim());

  return (
    <>
      {showPasteCopy ? (
        <>
          <CapsuleIconAction
            showTooltips={showTooltips}
            tooltip="Paste"
            button={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                data-testid="capsule-paste"
                aria-label="Paste"
                className={secondaryIconClass}
                onClick={onPaste}
              >
                <ClipboardPaste />
              </Button>
            }
          />
          <CapsuleIconAction
            showTooltips={showTooltips}
            tooltip="Copy"
            button={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled || !inputValue}
                data-testid="capsule-copy"
                aria-label="Copy"
                className={secondaryIconClass}
                onClick={() => {
                  void onCopy();
                }}
              >
                <Copy />
              </Button>
            }
          />
        </>
      ) : null}
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
    </>
  );
}
