// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { EnvGetResponse, EnvListResponse } from '@/capabilities/env';
import { WIRE as ENV_LIST_WIRE } from '@/generated/protocol/core/server-env-list/v1';
import { WIRE as ENV_GET_WIRE } from '@/generated/protocol/core/server-env-get/v1';
import { WIRE as ENV_WRITE_WIRE } from '@/generated/protocol/core/server-env-write/v1';
import { fixtureEnvSurface, type FixtureEnvControl } from '../../fixtureEnv';

function control(): FixtureEnvControl {
  const installed = (window as Window & { fixtureEnv?: FixtureEnvControl }).fixtureEnv;
  if (!installed) {
    throw new Error('env=race must install the fixture control');
  }
  return installed;
}

describe('fixture env race scenario (#2878)', () => {
  it('holds the first list and answers it with the pre-import snapshot', async () => {
    const surface = fixtureEnvSurface('?env=race');
    expect(control().isHeld()).toBe(false);

    const first = surface.request<EnvListResponse>(ENV_LIST_WIRE, {});
    expect(control().isHeld()).toBe(true);
    let firstSettled = false;
    void first.then(() => { firstSettled = true; });
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    // The import succeeds and mutates the list read by the next request.
    await expect(
      surface.request(ENV_WRITE_WIRE, {
        name: 'race.env',
        source: 'server',
        content: 'RACE_PROFILE=1\n',
        overwrite: false,
        force: false,
      }),
    ).resolves.toEqual({ success: true });
    const afterImport = await surface.request<EnvListResponse>(ENV_LIST_WIRE, {});
    expect(afterImport.files.map((file) => file.name)).toContain('race.env');

    // The held request answers with what the server computed before the
    // import — the older list, not the current one.
    control().releaseList();
    const old = await first;
    expect(old.files.map((file) => file.name)).not.toContain('race.env');
    expect(old.files).toHaveLength(3);

    await expect(
      surface.request<EnvGetResponse>(ENV_GET_WIRE, {
        name: 'race.env',
        source: 'server',
      }),
    ).resolves.toEqual({ success: true, content: 'RACE_PROFILE=1\n', in_use_by: [] });
  });

  it('keeps every other scenario read-only', async () => {
    const surface = fixtureEnvSurface('');
    await expect(
      surface.request(ENV_WRITE_WIRE, { name: 'x.env', source: 'server', content: 'X=1' }),
    ).rejects.toThrow('does not answer');
  });
});
