import type { Agent, EnvFileInfo } from '@/types';

/**
 * Environment profile vocabulary (#1202).
 *
 * A `.env` resource is an *Environment profile*; "file" appears only in
 * Raw/Import/location contexts. Profile identity is name + location, so the
 * same name at different sources stays distinct (#29 EC6) — but a row leads
 * with the name and keeps location as secondary metadata.
 */

/** Where a profile lives, said as a place: the Agent's name, or "Server". */
export function profileLocation(
  profile: Pick<EnvFileInfo, 'source' | 'agent_id'>,
  agents: Agent[],
): string {
  if (profile.source !== 'agent') {
    return 'Server';
  }
  const agent = agents.find((a) => a.agent_id === profile.agent_id);
  return agent?.display_name ?? agent?.hostname ?? profile.agent_id ?? 'Agent';
}

/** The row's one metadata line: "devbox-01 · 18 vars". */
export function profileMetaLine(
  profile: Pick<EnvFileInfo, 'source' | 'agent_id' | 'var_count'>,
  agents: Agent[],
): string {
  return `${profileLocation(profile, agents)} · ${varsLabel(profile.var_count)}`;
}

export function varsLabel(count: number): string {
  return count === 1 ? '1 var' : `${count} vars`;
}

export function variablesLabel(count: number): string {
  return count === 1 ? '1 variable' : `${count} variables`;
}

/**
 * The detail's location line: "Agent · devbox-01" / "Server". The source word
 * stays because server- and agent-resident profiles are genuinely different
 * places, but it is metadata — never a badge.
 */
export function profileSourceLine(
  profile: Pick<EnvFileInfo, 'source' | 'agent_id'>,
  agents: Agent[],
): string {
  return profile.source === 'agent'
    ? `Agent · ${profileLocation(profile, agents)}`
    : 'Server';
}
