import { ImagesPanel } from '@/capabilities/images';
import { cn } from '@/shared/lib/utils';
import { SandboxDistributionPanel } from './SandboxDistributionPanel';

/**
 * The Sandbox Images section (#3408).
 *
 * The Server registry is still global and Server-owned; this section is the
 * Session-scoped presentation. Library and Builds reuse the canonical Images
 * capability rather than creating a second registry or build flow. The
 * Distribution view is Agent-scoped and supplied by the Sandbox because it
 * observes the current Session's Agent cache (#3412).
 */
export function SandboxImagesPanel({
  experience,
  sessionId,
}: {
  experience: 'web' | 'app';
  sessionId: string | null;
}) {
  return (
    <div
      data-testid="sandbox-images"
      className={cn(
        'flex min-w-0 flex-col',
        experience === 'web' && 'min-h-0 flex-1 overflow-y-auto',
      )}
    >
      <ImagesPanel
        experience={experience}
        distribution={<SandboxDistributionPanel sessionId={sessionId} />}
      />
    </div>
  );
}
