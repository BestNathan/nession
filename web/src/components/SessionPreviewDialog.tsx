import { useState, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Skeleton } from './ui/skeleton';
import { RefreshCw, Download } from 'lucide-react';
import { useSessionPreview, type PreviewStatus } from '../hooks/useSessionPreview';
import { useDialogReset } from '../hooks/useDialogReset';
import { exportSessionPreviewPng } from '@/lib/previewPng';
import { CATPPUCCIN_MOCHA } from '@/terminal/ThemeManager';

interface SessionPreviewDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  sessionName: string;
}

const DEFAULT_LINES = 2000;
const MAX_LINES = 10000;

function ReadonlyTerminal({ ansi }: { ansi: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) {
      return;
    }
    const term = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 13,
      theme: CATPPUCCIN_MOCHA,
    });
    const fit = new FitAddon();
    term.loadAddon(new CanvasAddon());
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();
    term.write(ansi);
    return () => term.dispose();
  }, [ansi]);
  return <div ref={ref} className="h-full w-full" />;
}

function StatusContent({
  status,
  ansi,
  error,
  onRefresh,
}: {
  status: PreviewStatus;
  ansi: string;
  error: string | null;
  onRefresh: () => void;
}) {
  if (status === 'loading') {
    return (
      <div className="p-4 space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    );
  }
  if (status === 'ready') {
    return <ReadonlyTerminal ansi={ansi} />;
  }
  if (status === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-destructive">{error}</p>
        <Button onClick={onRefresh} variant="outline" size="sm">
          Retry
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground">
      No content captured. Click Refresh to fetch.
    </div>
  );
}

export function SessionPreviewDialog({
  isOpen,
  onClose,
  sessionId,
  sessionName,
}: SessionPreviewDialogProps) {
  const [lines, setLines] = useState(DEFAULT_LINES);
  const { status, ansi, error, capture, reset } = useSessionPreview();

  useDialogReset(isOpen, () => {
    setLines(DEFAULT_LINES);
    reset();
  });

  const handleRefresh = () => {
    if (lines < 1 || lines > MAX_LINES) {
      return;
    }
    capture(sessionId, lines);
  };

  const handleSavePng = async () => {
    if (status !== 'ready' || !ansi) {
      return;
    }
    await exportSessionPreviewPng(ansi, sessionName);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Preview — {sessionName}</DialogTitle>
          <DialogDescription>Last {lines} lines. Refresh to update.</DialogDescription>
        </DialogHeader>
        <div className="flex-1 flex flex-col gap-3 min-h-0">
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="preview-lines">Lines</Label>
              <Input
                id="preview-lines"
                type="number"
                min={1}
                max={MAX_LINES}
                step={100}
                value={lines}
                onChange={(e) => setLines(Number(e.target.value))}
                className="w-32"
                disabled={status === 'loading'}
              />
            </div>
            <Button onClick={handleRefresh} disabled={status === 'loading'} size="sm">
              <RefreshCw className="h-4 w-4 mr-1" />
              Refresh
            </Button>
            <Button onClick={handleSavePng} disabled={status !== 'ready'} variant="outline" size="sm">
              <Download className="h-4 w-4 mr-1" />
              Save PNG
            </Button>
          </div>
          <div className="flex-1 min-h-0 border rounded bg-black/50">
            <StatusContent status={status} ansi={ansi} error={error} onRefresh={handleRefresh} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
