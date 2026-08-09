import { useState, useCallback } from 'react';
import { ZoomIn, ZoomOut, Maximize, Minimize } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

export interface ImageViewerProps {
  blobUrl: string;
  filename: string;
}

export function ImageViewer({ blobUrl, filename }: ImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [fitToScreen, setFitToScreen] = useState(false);

  const zoomIn = useCallback(() => { setScale((s) => Math.min(s + 0.1, 5)); }, []);
  const zoomOut = useCallback(() => { setScale((s) => Math.max(s - 0.1, 0.1)); }, []);
  const toggleFit = useCallback(() => { setFitToScreen((f) => !f); }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-2 py-1 border-b flex-shrink-0">
        <span className="text-xs font-medium text-foreground truncate max-w-[200px]">
          {filename}
        </span>
        <span className="text-xs text-muted-foreground">{Math.round(scale * 100)}%</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-black/20">
        <img
          src={blobUrl}
          alt={filename}
          className={cn(
            'transition-transform duration-100',
            fitToScreen ? 'object-contain max-w-full max-h-full' : '',
          )}
          style={fitToScreen ? undefined : { transform: `scale(${scale})` }}
        />
      </div>
      <div className="flex items-center justify-center gap-1 px-2 py-1 border-t flex-shrink-0">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={zoomOut} aria-label="Zoom out">
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setScale(1); }} aria-label="Reset zoom">
          <span className="text-xs font-mono">{Math.round(scale * 100)}%</span>
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={zoomIn} aria-label="Zoom in">
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={toggleFit} aria-label="Fit to screen">
          {fitToScreen ? <Minimize className="h-3.5 w-3.5" /> : <Maximize className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}
