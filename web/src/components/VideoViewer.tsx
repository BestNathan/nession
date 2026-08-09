export interface VideoViewerProps {
  blobUrl: string;
  filename: string;
}

export function VideoViewer({ blobUrl, filename }: VideoViewerProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-2 py-1 border-b flex-shrink-0">
        <span className="text-xs font-medium text-foreground truncate max-w-[200px]">
          {filename}
        </span>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center bg-black/30">
        <video
          controls
          src={blobUrl}
          className="max-w-full max-h-full"
          data-testid="video-viewer"
        >
          Your browser does not support the video element.
        </video>
      </div>
    </div>
  );
}
