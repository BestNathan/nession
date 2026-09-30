import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

export interface PdfViewerProps {
  blobUrl: string;
  filename: string;
}

export function PdfViewer({ blobUrl, filename }: PdfViewerProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-2 py-1 border-b flex-shrink-0">
        <span className={cn('max-w-[200px] truncate text-foreground', chromeSansRole('metadata'))}>
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
