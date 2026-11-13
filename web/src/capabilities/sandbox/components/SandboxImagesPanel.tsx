import { ImagesPanel } from '@/capabilities/images';
import { cn } from '@/shared/lib/utils';

/**
 * The Sandbox Images section (#3408).
 *
 * The Server registry is still global and Server-owned; this section is the
 * Session-scoped presentation. Library and Builds reuse the canonical Images
 * capability rather than creating a second registry or build flow.
 */
export function SandboxImagesPanel({ experience }: { experience: 'web' | 'app' }) {
  return (
    <div
      data-testid="sandbox-images"
      className={cn(
        'flex min-w-0 flex-col',
        experience === 'web' && 'min-h-0 flex-1 overflow-y-auto',
      )}
    >
      <ImagesPanel experience={experience} />
    </div>
  );
}
