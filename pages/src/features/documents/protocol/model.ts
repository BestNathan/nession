// Protocol-only Documents contract. Every shape comes from the pinned Rust
// codegen JSON Schema; no hand-copied protocol fields.
const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{40}$/;

export interface ProtocolField {
  path: string;
  variant?: string;
  type: string;
  required: boolean;
  description?: string;
  since: string | null;
  since_status: 'verified' | 'unknown' | 'unreleased';
  shape?: unknown;
}

export interface ProtocolHalf {
  alias: string;
  shape: unknown;
  fields: ProtocolField[];
}

export interface ProtocolVersion {
  version: number;
  request: ProtocolHalf | null;
  response: ProtocolHalf | null;
}

export interface ProtocolGroup {
  id: string;
  owner: string;
  wires: string[];
  versions: ProtocolVersion[];
}

export interface ProtocolRelease {
  version: string;
  tag: string;
  sha: string | null;
  status: 'available' | 'unavailable';
}

export interface DocumentsSource {
  repository: string;
  branch: string;
  sha: string;
  source_version?: string | null;
}

export interface DocumentsSnapshot {
  schema_version: number;
  status: 'available' | 'unavailable';
  source: DocumentsSource | null;
  definitions: Record<string, unknown>;
  releases: ProtocolRelease[];
  protocols: ProtocolGroup[];
}

export interface DocumentsFilterState {
  query: string;
  owner: string;
}

export interface DocumentsRoute {
  id: string | null;
  version: number | null;
  invalid: boolean;
}

export function documentsHref(id: string, version?: number): string {
  if (!ID.test(id || '')) return '#/documents/protocol';
  return (
    '#/documents/protocol?protocol=' +
    encodeURIComponent(id) +
    (Number.isSafeInteger(version) && (version as number) > 0 ? '&v=' + version : '')
  );
}

export function documentsRoute(hash: string): DocumentsRoute | null {
  const raw = String(hash || '').replace(/^#/, '');
  if (!/^\/documents(?:\/protocol)?(?:\?|$)/.test(raw)) return null;
  const params = new URLSearchParams(raw.split('?')[1] || '');
  const id = params.get('protocol');
  const version = params.get('v');
  const validId = id === null || ID.test(id);
  const validVersion = version === null || /^[1-9][0-9]{0,3}$/.test(version);
  return {
    id: validId ? id : null,
    version: validVersion && version ? Number(version) : null,
    invalid: !validId || !validVersion,
  };
}

export function validDocumentsSnapshot(data: unknown): data is DocumentsSnapshot {
  const snapshot = data as Partial<DocumentsSnapshot> | null;
  if (
    snapshot?.schema_version !== 4 ||
    !['available', 'unavailable'].includes(snapshot.status as string) ||
    !Array.isArray(snapshot.protocols) ||
    snapshot.protocols.length > 400 ||
    !snapshot.definitions ||
    typeof snapshot.definitions !== 'object' ||
    !Array.isArray(snapshot.releases) ||
    snapshot.releases.length > 30
  ) {
    return false;
  }
  if (snapshot.status === 'unavailable') {
    return snapshot.source === null && snapshot.protocols.length === 0;
  }
  if (
    snapshot.source?.repository !== 'BestNathan/nession' ||
    snapshot.source?.branch !== 'main' ||
    !SHA.test(snapshot.source.sha || '') ||
    !snapshot.protocols.length
  ) {
    return false;
  }
  const ids = new Set<string>();
  if (
    !snapshot.releases.every(
      (release) =>
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release?.version || '') &&
        release.tag === 'v' + release.version &&
        ['available', 'unavailable'].includes(release.status),
    )
  ) {
    return false;
  }
  return snapshot.protocols.every((group) => {
    if (
      !ID.test(group?.id || '') ||
      ids.has(group.id) ||
      typeof group.owner !== 'string' ||
      !Array.isArray(group.versions) ||
      !group.versions.length ||
      group.versions.length > 25 ||
      !Array.isArray(group.wires) ||
      !group.wires.every((wire) => typeof wire === 'string')
    ) {
      return false;
    }
    ids.add(group.id);
    const versions = new Set<number>();
    return group.versions.every((version) => {
      if (!Number.isSafeInteger(version.version) || version.version < 1 || versions.has(version.version)) {
        return false;
      }
      versions.add(version.version);
      return (['request', 'response'] as const).every(
        (half) =>
          version[half] === null ||
          (version[half] &&
            typeof version[half].alias === 'string' &&
            Array.isArray(version[half].fields) &&
            version[half].fields.length <= 6000 &&
            version[half].shape !== undefined &&
            version[half].fields.every(
              (field) =>
                typeof field.path === 'string' &&
                typeof field.type === 'string' &&
                ['verified', 'unknown', 'unreleased'].includes(field.since_status) &&
                (field.since_status === 'verified'
                  ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(field.since || '')
                  : field.since === null),
            )),
      );
    });
  });
}

export function filterDocuments(
  items: ProtocolGroup[],
  {query = '', owner = 'All'}: Partial<DocumentsFilterState> = {},
): ProtocolGroup[] {
  const term = query.trim().toLocaleLowerCase();
  return items.filter(
    (group) =>
      (owner === 'All' || group.owner === owner) &&
      (!term ||
        [
          group.id,
          group.owner,
          ...group.versions.flatMap((version) => [
            version.request?.alias || '',
            version.response?.alias || '',
            ...(version.request?.fields?.map((field) => field.path) || []),
            ...(version.response?.fields?.map((field) => field.path) || []),
          ]),
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(term)),
  );
}

export function protocolFieldSince(field: ProtocolField): string {
  return field.since_status === 'verified' && field.since
    ? field.since
    : field.since_status === 'unreleased'
      ? 'Unreleased'
      : 'Unknown';
}

export function protocolFieldSinceTitle(field: ProtocolField): string {
  return field.since_status === 'verified'
    ? 'First verified as introduced in Nession ' + field.since
    : field.since_status === 'unreleased'
      ? 'Not present in the latest verified release; only present in main'
      : 'Historical Nession releases cannot establish the first supported version';
}
