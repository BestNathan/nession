import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvFileMultiSelect } from '@/components/env/EnvFileMultiSelect';
import type { EnvFileInfo, EnvFileRef } from '@/types';

function info(name: string, overrides: Partial<EnvFileInfo> = {}): EnvFileInfo {
  return { name, source: 'server', size: 5, modified: 0, var_count: 2, ...overrides };
}

describe('EnvFileMultiSelect', () => {
  it('shows empty label when no files', () => {
    render(
      <EnvFileMultiSelect files={[]} selected={[]} onChange={vi.fn()} emptyLabel="Nothing here" />,
    );
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('toggles selection on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <EnvFileMultiSelect files={[info('a.env')]} selected={[]} onChange={onChange} />,
    );
    await user.click(screen.getByText('a.env'));
    expect(onChange).toHaveBeenCalledWith([{ name: 'a.env', source: 'server', agent_id: undefined }]);
  });

  it('deselects an already-selected file', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const selected: EnvFileRef[] = [{ name: 'a.env', source: 'server' }];
    render(
      <EnvFileMultiSelect files={[info('a.env')]} selected={selected} onChange={onChange} />,
    );
    await user.click(screen.getByText('a.env'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('filters by search query', async () => {
    const user = userEvent.setup();
    render(
      <EnvFileMultiSelect
        files={[info('staging.env'), info('prod.env')]}
        selected={[]}
        onChange={vi.fn()}
      />,
    );
    await user.type(screen.getByPlaceholderText('Search env files…'), 'prod');
    expect(screen.getByText('prod.env')).toBeInTheDocument();
    expect(screen.queryByText('staging.env')).not.toBeInTheDocument();
  });

  it('shows same-name files from different sources separately (EC6)', () => {
    render(
      <EnvFileMultiSelect
        files={[
          info('staging.env', { source: 'server' }),
          info('staging.env', { source: 'agent', agent_id: 'h1' }),
        ]}
        selected={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('server')).toBeInTheDocument();
    expect(screen.getByText('agent:h1')).toBeInTheDocument();
  });
});
