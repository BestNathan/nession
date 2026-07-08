import type { EnvFileInfo, EnvFileRef, EnvSource } from '../../types';

/** Stable identity for an env file: source + agent + name. */
export function refKey(ref: { name: string; source: EnvSource; agent_id?: string }): string {
  return `${ref.source}:${ref.agent_id ?? ''}:${ref.name}`;
}

/** Narrow an EnvFileInfo (or ref) down to a plain EnvFileRef. */
export function toRef(info: { name: string; source: EnvSource; agent_id?: string }): EnvFileRef {
  return { name: info.name, source: info.source, agent_id: info.agent_id };
}

/** Human label for a file's source, used in badges: e.g. "server" / "agent:host-1". */
export function sourceLabel(info: Pick<EnvFileInfo, 'source' | 'agent_id'>): string {
  return info.source === 'agent' && info.agent_id ? `agent:${info.agent_id}` : info.source;
}
