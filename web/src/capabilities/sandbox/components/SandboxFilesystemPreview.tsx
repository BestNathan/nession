import { FormSection } from '@/components/ui/configuration-form';
import type { SandboxFilesystemPolicy } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import { rootfsLabel, workspaceLabel } from '../model';

interface PreviewRow {
  id: string;
  target: string;
  source: string;
  mode: string;
}

function previewRows(filesystem: SandboxFilesystemPolicy | undefined): PreviewRow[] {
  const rows: PreviewRow[] = [];
  const rootfs = filesystem?.rootfs ?? undefined;
  rows.push({
    id: 'rootfs',
    target: '/',
    source: rootfs?.kind === 'image' ? rootfs.digest : 'Local host root',
    mode: rootfs?.kind === 'image' ? 'read-only' : 'host identity',
  });
  for (const [index, mount] of (filesystem?.mounts ?? []).entries()) {
    rows.push({
      id: `mount-${index}`,
      target: mount.target,
      source: mount.source.digest,
      mode: mount.read_only ? 'read-only' : 'writable',
    });
  }
  if (filesystem?.workspace) {
    rows.push({
      id: 'workspace',
      target: '/workspace',
      source: workspaceLabel(filesystem.workspace),
      mode: 'read-write',
    });
  }
  const access = filesystem?.access;
  for (const [index, path] of (access?.read ?? []).entries()) {
    rows.push({
      id: `read-${index}`,
      target: path,
      source: 'Agent host path',
      mode: 'read-only',
    });
  }
  for (const [index, path] of (access?.write ?? []).entries()) {
    rows.push({
      id: `write-${index}`,
      target: path,
      source: 'Agent host path',
      mode: 'read-write',
    });
  }
  return rows;
}

/**
 * The derived Filesystem mapping preview (#3405).
 *
 * Never editable: it is recomputed from the four configuration sections so a
 * user can see every target, source and mode the Agent will receive.
 */
export function SandboxFilesystemPreview({
  filesystem,
}: {
  filesystem: SandboxFilesystemPolicy | undefined;
}) {
  const rows = previewRows(filesystem);
  const rootfs = filesystem?.rootfs ?? undefined;
  return (
    <FormSection
      title="Preview"
      description={`Derived from the declaration, never editable. RootFS: ${rootfsLabel(rootfs)}.`}
      testId="sandbox-filesystem-preview-section"
    >
      <div className="flex min-w-0 flex-col" data-testid="sandbox-filesystem-preview">
        {rows.map((row) => (
          <div
            key={row.id}
            data-testid={`sandbox-filesystem-preview-${row.id}`}
            className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 border-b border-border py-1 last:border-b-0"
          >
            <span className={cn('min-w-0 break-all', chromeMonoRole('code'))}>
              {row.target}
            </span>
            <span className={cn('min-w-0 truncate text-muted-foreground', chromeMonoRole('code'))}>
              {row.source}
            </span>
            <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
              {row.mode}
            </span>
          </div>
        ))}
      </div>
    </FormSection>
  );
}
