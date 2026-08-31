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
}

export function CapsuleInputActionButtons({
  inputValue,
  disabled,
  showPasteCopy,
  onSend,
  onPaste,
  onCopy,
}: CapsuleInputActionButtonsProps) {
  const canSend = !disabled && Boolean(inputValue.trim());

  return (
    <>
      {showPasteCopy ? (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  data-testid="capsule-paste"
                  aria-label="Paste"
                  className={capsuleIconButtonClass}
                  onClick={onPaste}
                >
                  <ClipboardPaste />
                </Button>
              }
            />
            <TooltipContent side="top">
              <p>Paste</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled || !inputValue}
                  data-testid="capsule-copy"
                  aria-label="Copy"
                  className={capsuleIconButtonClass}
                  onClick={() => {
                    void onCopy();
                  }}
                >
                  <Copy />
                </Button>
              }
            />
            <TooltipContent side="top">
              <p>Copy</p>
            </TooltipContent>
          </Tooltip>
        </>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
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
        <TooltipContent side="top">
          <p>Send (Enter)</p>
        </TooltipContent>
      </Tooltip>
    </>
  );
}
