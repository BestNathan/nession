import { ClipboardPaste, Copy, SendHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

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
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || !inputValue.trim()}
              data-testid="capsule-send"
              className="max-lg:min-h-11"
              aria-label="Send"
              onClick={onSend}
            >
              <SendHorizontal className="size-4" />
              Send
            </Button>
          }
        />
        <TooltipContent side="top">
          <p>Send (Enter)</p>
        </TooltipContent>
      </Tooltip>
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
    </>
  );
}
