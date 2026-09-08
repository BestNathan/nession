import { Music } from 'lucide-react';

export interface AudioViewerProps {
  blobUrl: string;
  filename: string;
}

export function AudioViewer({ blobUrl, filename }: AudioViewerProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-2 py-1 border-b flex-shrink-0">
        <span className="text-xs font-medium text-foreground truncate max-w-[200px]">
          {filename}
        </span>
      </div>
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4">
        <Music className="h-12 w-12 text-muted-foreground" />
        <audio
          controls
          src={blobUrl}
          className="w-full max-w-md"
          data-testid="audio-viewer"
        >
          Your browser does not support the audio element.
        </audio>
      </div>
    </div>
  );
}
