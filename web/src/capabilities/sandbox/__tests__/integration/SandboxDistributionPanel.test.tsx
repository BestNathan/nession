import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import type { ImageCacheObservation } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { imagesApi, type ImageDescriptor } from '@/capabilities/images';
import { SandboxDistributionPanel } from '../../components/SandboxDistributionPanel';
import { sandboxApi } from '../../SandboxPlugin';

function digest(id: string): string {
  return `sha256:${id.repeat(64).slice(0, 64)}`;
}

function image(index: number): ImageDescriptor {
  const id = digest(index.toString(16));
  return {
    image_id: `image-${index}`,
    digest: id,
    size_bytes: 4096,
    source: { kind: 'local_directory', path: `/srv/images/${index}` },
    packaging: {
      compression: 'none',
      block_size: 4096,
      fixed_timestamp: 0,
      fixed_uuid: '11111111-1111-4111-8111-111111111111',
    },
    status: 'ready',
    aliases: [`image-${index}`],
    created_at: 1,
    updated_at: 2,
  };
}

function observation(
  id: string,
  phase: ImageCacheObservation['phase'],
): ImageCacheObservation {
  const active = phase === 'downloading' || phase === 'verifying';
  return {
    contract_version: 1,
    digest: id,
    phase,
    downloaded_bytes: phase === 'absent' ? undefined : 100,
    total_bytes: phase === 'absent' ? undefined : 1000,
    active,
    updated_at: 1,
    detail: null,
  };
}

describe('Sandbox Distribution panel', () => {
  let surface: MockPluginSurface;
  let releaseSandbox: () => void;
  let releaseImages: () => void;

  beforeEach(() => {
    surface = createMockPluginSurface();
    releaseSandbox = sandboxApi.install(surface);
    releaseImages = imagesApi.install(surface);
  });

  afterEach(() => {
    releaseSandbox();
    releaseImages();
  });

  async function renderWithObservations(
    observations: ImageCacheObservation[],
    images: ImageDescriptor[],
  ): Promise<void> {
    render(<SandboxDistributionPanel sessionId="a1:s1" />);
    surface.resolveNext('server.image.list', {
      images,
      total: images.length,
    });
    await waitFor(() =>
      expect(
        surface.requests.some(
          (request) => request.type === 'server.session.sandbox.context',
        ),
      ).toBe(true),
    );
    const context = surface.requests.find(
      (request) => request.type === 'server.session.sandbox.context',
    );
    expect(context?.payload).toEqual({
      session_id: 'a1:s1',
      cache_digests: images.map((entry) => entry.digest),
    });
    surface.resolveNext('server.session.sandbox.context', {
      success: true,
      cache_observations: observations,
    });
    await waitFor(() => {
      const phases = screen.getAllByTestId('sandbox-distribution-phase');
      expect(phases).toHaveLength(observations.length);
      expect(phases.some((phase) => phase.textContent === 'Not observed')).toBe(false);
    });
  }

  it('offers only the eligible action for each observed phase', async () => {
    const absent = image(1);
    const resumable = image(2);
    const failed = image(3);
    const verified = image(4);
    const unavailable = image(5);
    await renderWithObservations(
      [
        observation(absent.digest as string, 'absent'),
        observation(resumable.digest as string, 'resumable'),
        observation(failed.digest as string, 'failed'),
        observation(verified.digest as string, 'verified'),
        observation(unavailable.digest as string, 'unavailable'),
      ],
      [absent, resumable, failed, verified, unavailable],
    );

    expect(screen.getAllByTestId('sandbox-distribution-prepare')).toHaveLength(1);
    expect(screen.getAllByTestId('sandbox-distribution-resume')).toHaveLength(1);
    expect(screen.getAllByTestId('sandbox-distribution-retry')).toHaveLength(1);
    // Verified and unavailable rows offer no action at all.
    expect(screen.getAllByTestId('sandbox-distribution-row')).toHaveLength(5);
  });

  it('runs an explicit Prepare and reflects the Agent observation', async () => {
    const target = image(1);
    await renderWithObservations(
      [observation(target.digest as string, 'absent')],
      [target],
    );

    await userEvent.click(screen.getByTestId('sandbox-distribution-prepare'));
    const prepare = surface.requests.find(
      (request) => request.type === 'server.session.sandbox.image-prepare',
    );
    expect(prepare?.payload).toEqual({
      session_id: 'a1:s1',
      digest: target.digest,
      intent: 'prepare',
    });

    // While the explicit action is in flight, another action cannot race it.
    expect(screen.getByTestId('sandbox-distribution-prepare')).toBeDisabled();

    surface.resolveNext('server.session.sandbox.image-prepare', {
      success: true,
      observation: observation(target.digest as string, 'downloading'),
      observations: [observation(target.digest as string, 'downloading')],
    });
    await waitFor(() =>
      expect(
        surface.requests.some(
          (request) => request.type === 'server.session.sandbox.context',
        ),
      ).toBe(true),
    );
    surface.resolveNext('server.session.sandbox.context', {
      success: true,
      cache_observations: [observation(target.digest as string, 'downloading')],
    });
    await waitFor(() =>
      expect(screen.getByTestId('sandbox-distribution-phase')).toHaveTextContent(
        'Downloading',
      ),
    );
    expect(screen.queryByTestId('sandbox-distribution-prepare')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sandbox-distribution-active')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('sandbox-distribution-refresh'));
    await waitFor(() =>
      expect(
        surface.requests.some(
          (request) => request.type === 'server.session.sandbox.context',
        ),
      ).toBe(true),
    );
    surface.resolveNext('server.session.sandbox.context', {
      success: true,
      cache_observations: [observation(target.digest as string, 'verified')],
    });
    await waitFor(() =>
      expect(screen.getByTestId('sandbox-distribution-phase')).toHaveTextContent(
        'Verified',
      ),
    );
    expect(screen.queryByTestId('sandbox-distribution-active')).not.toBeInTheDocument();
  });

  it('keeps a recoverable explanation and Retry when the action is refused', async () => {
    const target = image(1);
    await renderWithObservations(
      [observation(target.digest as string, 'failed')],
      [target],
    );

    await userEvent.click(screen.getByTestId('sandbox-distribution-retry'));
    surface.resolveNext('server.session.sandbox.image-prepare', {
      success: false,
      error: 'the authorization grant has expired',
      error_kind: 'invalid',
      observations: [],
    });
    await screen.findByTestId('sandbox-distribution-action-error');
    expect(screen.getByTestId('sandbox-distribution-action-error')).toHaveTextContent(
      'expired',
    );
    expect(screen.getByTestId('sandbox-distribution-retry')).toBeEnabled();
    expect(screen.getByTestId('sandbox-distribution-phase')).toHaveTextContent(
      'Cache failed',
    );
  });

  it('never reads or mutates the Agent cache without a Session', () => {
    render(<SandboxDistributionPanel sessionId={null} />);
    surface.resolveNext('server.image.list', { images: [image(1)], total: 1 });
    expect(
      surface.requests.filter(
        (request) => request.type === 'server.session.sandbox.context',
      ),
    ).toHaveLength(0);
    expect(
      surface.requests.filter(
        (request) => request.type === 'server.session.sandbox.image-prepare',
      ),
    ).toHaveLength(0);
  });
});
