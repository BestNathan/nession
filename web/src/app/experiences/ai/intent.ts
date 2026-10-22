import type { Agent } from '@/types';

/**
 * System-1 UI intent boundary for the prototype. It selects a known capability;
 * it does not create UI code, invoke a model, or execute a server command.
 * A browser-side classifier can replace this implementation without changing
 * the action dispatch and rendering contracts.
 */
export type UIIntent =
  | { type: 'agent.list' }
  | { type: 'session.list' }
  | { type: 'session.create'; agentId?: string }
  | { type: 'unsupported' };

export function resolveUIIntent(input: string, agents: Agent[]): UIIntent {
  const text = input.trim().toLowerCase();
  if (!text) { return { type: 'unsupported' }; }

  const create = /create|new|创建|新建|新增/.test(text);
  const mentionsAgent = /agents?|节点|主机|机器/.test(text);
  const mentionsSession = /sessions?|会话/.test(text);
  const show = /show|list|browse|display|查看|看看|列出|显示|展示|有哪些|所有|多少|状态|打开/.test(text);

  if (create && mentionsSession) {
    // Preselect an Agent only on an unambiguous explicit name reference.
    const matches = agents.filter((agent) =>
      [agent.display_name, agent.hostname].some(
        (name) => name && text.includes(name.toLowerCase()),
      ),
    );
    const distinctIds = [...new Set(matches.map((agent) => agent.agent_id))];
    return {
      type: 'session.create',
      ...(distinctIds.length === 1 ? { agentId: distinctIds[0] } : {}),
    };
  }

  if (mentionsAgent && show) { return { type: 'agent.list' }; }
  if (mentionsSession && show) { return { type: 'session.list' }; }
  return { type: 'unsupported' };
}
