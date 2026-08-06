import { X } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';
import { KEY_DEFINITIONS } from './floatingKeyBarKeys';

interface FloatingKeyBarProps {
  sendText: (text: string) => void;
  visible: boolean;
  dismissed: boolean;
  onShow: () => void;
  onActivity: () => void;
  onDismiss: () => void;
  onRestore: () => void;
}

export function FloatingKeyBar({
  sendText,
  visible,
  dismissed,
  onActivity,
  onDismiss,
  onRestore,
}: FloatingKeyBarProps) {
  const handleKey = (command: string) => {
    sendText(command);
    // Do NOT call focusTerminal() — on mobile it triggers the soft keyboard
    // because xterm.focus() targets a hidden textarea. The escape sequence is
    // sent directly via WebSocket; no DOM focus needed.
    onActivity();
  };

  if (dismissed && !visible) {
    return (
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10">
        <button
          type="button"
          onClick={onRestore}
          className="text-xs text-muted-foreground/50 hover:text-muted-foreground px-2 py-0.5 rounded-full bg-background/50 backdrop-blur-sm"
          tabIndex={-1}
          aria-label="Show keyboard keys"
        >
          ◉
        </button>
      </div>
    );
  }

  if (!visible) {
    return null;
  }

  return (
    <div
      className={cn(
        'absolute bottom-2 left-2 right-2 z-10',
        'bg-background/80 backdrop-blur-sm rounded-md',
        'border shadow-sm',
        'px-1.5 py-1',
        'transition-opacity duration-300',
      )}
    >
      <div className="flex flex-wrap gap-0.5 items-center">
        {KEY_DEFINITIONS.map((group, gi) => (
          <div key={gi} className="flex items-center gap-0.5">
            {gi > 0 && (
              <div className="w-px h-4 bg-border mx-0.5 flex-shrink-0" />
            )}
            {group.keys.map((key) => (
              <Button
                key={key.label}
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs font-mono hover:bg-accent flex-shrink-0"
                tabIndex={-1}
                onClick={() => handleKey(key.command)}
              >
                {key.label}
              </Button>
            ))}
          </div>
        ))}
        <div className="w-px h-4 bg-border mx-0.5 flex-shrink-0" />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 hover:bg-accent flex-shrink-0"
          tabIndex={-1}
          onClick={onDismiss}
          aria-label="Dismiss key bar"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
