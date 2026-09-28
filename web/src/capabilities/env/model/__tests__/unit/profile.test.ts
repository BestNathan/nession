import { describe, it, expect } from 'vitest';
import type { Agent } from '@/types';
import {
  profileLocation,
  profileMetaLine,
  profileSourceLine,
  variablesLabel,
  varsLabel,
} from '@/capabilities/env/model/profile';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'a1',
    hostname: 'devbox-01',
    ip_address: '10.0.0.1',
    port: 19090,
    status: 'online',
    ...overrides,
  } as Agent;
}

describe('profileLocation', () => {
  it('says Server for a server-resident profile', () => {
    expect(profileLocation({ source: 'server' }, [])).toBe('Server');
  });

  it('prefers the agent display name, then hostname, then the raw id', () => {
    const withDisplay = agent({ display_name: 'Build Box' });
    expect(profileLocation({ source: 'agent', agent_id: 'a1' }, [withDisplay])).toBe('Build Box');
    expect(profileLocation({ source: 'agent', agent_id: 'a1' }, [agent()])).toBe('devbox-01');
    expect(profileLocation({ source: 'agent', agent_id: 'gone' }, [agent()])).toBe('gone');
  });
});

describe('profileMetaLine', () => {
  it('joins location and the var count', () => {
    expect(
      profileMetaLine({ source: 'agent', agent_id: 'a1', var_count: 18 }, [agent()]),
    ).toBe('devbox-01 · 18 vars');
    expect(profileMetaLine({ source: 'server', var_count: 1 }, [])).toBe('Server · 1 var');
  });
});

describe('count labels', () => {
  it('singularizes one', () => {
    expect(varsLabel(1)).toBe('1 var');
    expect(varsLabel(0)).toBe('0 vars');
    expect(varsLabel(18)).toBe('18 vars');
    expect(variablesLabel(1)).toBe('1 variable');
    expect(variablesLabel(3)).toBe('3 variables');
  });
});

describe('profileSourceLine', () => {
  it('names the source kind for an agent profile and stays bare for server', () => {
    expect(profileSourceLine({ source: 'agent', agent_id: 'a1' }, [agent()])).toBe(
      'Agent · devbox-01',
    );
    expect(profileSourceLine({ source: 'server' }, [])).toBe('Server');
  });
});
