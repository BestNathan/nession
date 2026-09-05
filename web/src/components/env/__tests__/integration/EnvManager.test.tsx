import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvManager } from '@/components/env/EnvManager';
import { envApi } from '@/features/env';
import type { Agent, EnvFileInfo } from '@/types';

vi.mock('@/features/env', () => ({
  envApi: {
    listEnvFiles: vi.fn(),
    getEnvFile: vi.fn(),
    writeEnvFile: vi.fn(),
    deleteEnvFile: vi.fn(),
  },
}));

const mockedEnvApi = vi.mocked(envApi);

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'agent-1',
    hostname: 'host-1',
    ip_address: '1.2.3.4',
    port: 80,
    status: 'online',
    session_count: 0,
    last_heartbeat: new Date().toISOString(),
    ...overrides,
  };
}

function file(name: string, overrides: Partial<EnvFileInfo> = {}): EnvFileInfo {
  return { name, source: 'server', size: 8, modified: 0, var_count: 2, ...overrides };
}

describe('EnvManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnvApi.listEnvFiles.mockResolvedValue({ files: [] });
    mockedEnvApi.getEnvFile.mockResolvedValue({ success: true, content: '', in_use_by: [] });
    mockedEnvApi.writeEnvFile.mockResolvedValue({ success: true });
    mockedEnvApi.deleteEnvFile.mockResolvedValue({ success: true });
  });

  it('shows empty state when no files', async () => {
    render(<EnvManager agents={[agent()]} onBack={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/No env files yet/)).toBeInTheDocument();
    });
  });

  it('lists files with source badge', async () => {
    mockedEnvApi.listEnvFiles.mockResolvedValue({ files: [file('staging.env')] });
    render(<EnvManager agents={[agent()]} onBack={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('staging.env')).toBeInTheDocument();
    });
    expect(screen.getByText('server')).toBeInTheDocument();
  });

  it('calls onBack when Back clicked', async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<EnvManager agents={[agent()]} onBack={onBack} />);
    await waitFor(() => expect(screen.getByText(/No env files yet/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Back/ }));
    expect(onBack).toHaveBeenCalled();
  });

  it('deletes a file after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockedEnvApi.listEnvFiles.mockResolvedValue({ files: [file('gone.env')] });
    const user = userEvent.setup();
    render(<EnvManager agents={[agent()]} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('gone.env')).toBeInTheDocument());
    // Click file to select it and show the editor footer
    await user.click(screen.getByText('gone.env'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Delete/ })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Delete/ }));
    await waitFor(() => expect(mockedEnvApi.deleteEnvFile).toHaveBeenCalled());
    confirmSpy.mockRestore();
  });

  it('opens the clone editor prefilled from the original file', async () => {
    mockedEnvApi.listEnvFiles.mockResolvedValue({ files: [file('staging.env')] });
    mockedEnvApi.getEnvFile.mockResolvedValue({
      success: true,
      content: 'FOO=bar',
      in_use_by: [],
    });
    const user = userEvent.setup();
    render(<EnvManager agents={[agent()]} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('staging.env')).toBeInTheDocument());
    // Click file to select → right panel shows → click Clone in footer
    await user.click(screen.getByText('staging.env'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Clone/ })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Clone/ }));
    await waitFor(() => {
      expect(screen.getByDisplayValue('staging-copy.env')).toBeInTheDocument();
    });
    expect(mockedEnvApi.getEnvFile).toHaveBeenCalledWith({
      name: 'staging.env',
      source: 'server',
      agent_id: undefined,
    });
  });

  it('opens the create editor on New', async () => {
    const user = userEvent.setup();
    render(<EnvManager agents={[agent()]} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/No env files yet/)).toBeInTheDocument());
    // There are two "New File" buttons: empty state center + left panel footer
    const newButtons = screen.getAllByRole('button', { name: /New File/ });
    await user.click(newButtons[0] ?? newButtons[newButtons.length - 1]);
    await waitFor(() => expect(screen.getByText('New Env File')).toBeInTheDocument());
  });
});
