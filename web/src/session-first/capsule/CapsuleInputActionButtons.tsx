import { ClipboardPaste, Copy, ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

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
                  size="icon-sm"
                  disabled={disabled}
                  data-testid="capsule-paste"
                  aria-label="Paste"
                  className="max-lg:min-h-11 max-lg:min-w-11"
                  onClick={onPaste}
                >
                  <ClipboardPaste className="size-4" />
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
                  size="icon-sm"
                  disabled={disabled || !inputValue}
                  data-testid="capsule-copy"
                  aria-label="Copy"
                  className="max-lg:min-h-11 max-lg:min-w-11"
                  onClick={() => { void onCopy(); }}
                >
                  <Copy className="size-4" />
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
              size="icon-sm"
              disabled={!canSend}
              data-testid="capsule-send"
              aria-label="Send"
              className={cn(
                'size-8 rounded-full max-lg:size-11',
                canSend
                  ? 'bg-foreground text-background hover:bg-foreground/90'
                  : 'bg-muted text-muted-foreground',
              )}
              onClick={onSend}
            >
              <ArrowUp className="size-4" />
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
