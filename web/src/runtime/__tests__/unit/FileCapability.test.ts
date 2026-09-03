// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { FileCapability } from '@/runtime/FileCapability';
import type { AgentSocketClient } from '@/services/socket/AgentSocketClient';
import type { MessageRouter } from '@/services/socket/types';

function makeRouter(): MessageRouter & Pick<AgentSocketClient, 'waitForConnection'> {
  return {
    send: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    dispose: vi.fn(),
    request: vi.fn(async (type: string) => {
      if (type === 'file.list') {
        return { entries: [{ name: 'a', path: '/a', full_path: '/a', is_dir: false, size: 1, modified: 0 }] };
      }
      if (type === 'file.read') {
        return { path: '/a', content: 'YQ==', mime_type: 'text/plain' };
      }
      if (type === 'file.write') {
        return { path: '/a', written: 1 };
      }
      if (type === 'file.delete') {
        return { path: '/a', success: true };
      }
      if (type === 'file.create_dir') {
        return { path: '/dir', success: true };
      }
      if (type === 'file.rename') {
        return { from: '/a', to: '/b', success: true };
      }
      if (type === 'file.cwd') {
        return { path: '/home' };
      }
      throw new Error(`unexpected ${type}`);
    }),
    waitForConnection: vi.fn(async () => {}),
  } as unknown as MessageRouter & Pick<AgentSocketClient, 'waitForConnection'>;
}

describe('FileCapability', () => {
  it('delegates domain methods to router.request', async () => {
    const router = makeRouter();
    const cap = new FileCapability(router);

    await cap.listDir('/');
    await cap.readFile('/a');
    await cap.writeFile('/a', 'YQ==');
    await cap.deleteFile('/a', true);
    await cap.createDir('/dir');
    await cap.renameFile('/a', '/b');
    await cap.getCwd('sess-1');

    expect(router.waitForConnection).toHaveBeenCalled();
    expect(router.request).toHaveBeenCalledTimes(7);
  });

  it('toFileOps exposes FileOps surface including upload', async () => {
    const router = makeRouter();
    const ops = new FileCapability(router).toFileOps();

    const listed = await ops.listDir('/');
    expect(listed.entries).toHaveLength(1);

    const encoded = ops.base64Encode('hi');
    expect(ops.base64Decode(encoded)).toBe('hi');

    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    await expect(ops.uploadFile('/upload/hello.txt', file)).resolves.toEqual({
      path: '/a',
      written: 1,
    });
  });
});
