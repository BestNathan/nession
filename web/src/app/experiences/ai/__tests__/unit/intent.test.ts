import { describe, expect, it } from 'vitest';
import { resolveUIIntent } from '@/app/experiences/ai/intent';
import type { Agent } from '@/types';

const agents = [
  { agent_id: 'a1', display_name: 'Beijing Server', hostname: 'beijing-01' },
  { agent_id: 'a2', display_name: 'MacBook Pro', hostname: 'macbook' },
] as Agent[];

describe('resolveUIIntent', () => {
  it('routes Chinese and English Agent list requests', () => {
    expect(resolveUIIntent('看看我的节点列表', agents)).toEqual({ type: 'agent.list' });
    expect(resolveUIIntent('show agents', agents)).toEqual({ type: 'agent.list' });
  });

  it('routes Session lists without generating UI', () => {
    expect(resolveUIIntent('列出所有 sessions', agents)).toEqual({ type: 'session.list' });
  });

  it('preselects only a uniquely named Agent for Session creation', () => {
    expect(resolveUIIntent('在 Beijing Server 创建 Session', agents)).toEqual({
      type: 'session.create', agentId: 'a1',
    });
    expect(resolveUIIntent('创建 session', agents)).toEqual({ type: 'session.create' });
  });

  it('never invents an action for an unsupported request', () => {
    expect(resolveUIIntent('delete every node', agents)).toEqual({ type: 'unsupported' });
    expect(resolveUIIntent('', agents)).toEqual({ type: 'unsupported' });
  });
});
