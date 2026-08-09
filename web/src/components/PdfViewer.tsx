export interface PdfViewerProps {
  blobUrl: string;
  filename: string;
}

export function PdfViewer({ blobUrl, filename }: PdfViewerProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-2 py-1 border-b flex-shrink-0">
        <span className="text-xs font-medium text-foreground truncate max-w-[200px]">
          {filename}
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <embed
          src={blobUrl}
          type="application/pdf"
          className="w-full h-full"
          data-testid="pdf-viewer"
        />
      </div>
    </div>
  );
}
