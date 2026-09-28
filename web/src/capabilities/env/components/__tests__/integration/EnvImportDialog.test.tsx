import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EnvWriteResponse } from '@/types';

const envApi = vi.hoisted(() => ({
  writeEnvFile: vi.fn(),
}));

vi.mock('@/capabilities/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/capabilities/env')>()),
  envApi,
}));

import { EnvImportDialog } from '@/capabilities/env/components/EnvImportDialog';

function renderDialog(onImported = vi.fn()) {
  render(
    <EnvImportDialog isOpen onClose={vi.fn()} agents={[]} onImported={onImported} />,
  );
  return { onImported };
}

function pickFile(name = 'staging.env', body = 'A=1\n') {
  const input = document.querySelector('input[type="file"]');
  expect(input).toBeTruthy();
  return { input: input as HTMLInputElement, file: new File([body], name, { type: 'text/plain' }) };
}

describe('EnvImportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envApi.writeEnvFile.mockResolvedValue({ success: true } as EnvWriteResponse);
  });

  it('imports a picked file to the Server and hands the ref over', async () => {
    const user = userEvent.setup();
    const { onImported } = renderDialog();
    const { input, file } = pickFile();
    await user.upload(input, file);

    await user.click(screen.getByTestId('env-import-submit'));
    await waitFor(() =>
      expect(envApi.writeEnvFile).toHaveBeenCalledWith(
        { name: 'staging.env', source: 'server', agent_id: undefined },
        'A=1\n',
        false,
        false,
      ),
    );
    expect(onImported).toHaveBeenCalledWith({
      name: 'staging.env',
      source: 'server',
      agent_id: undefined,
    });
  });

  it('appends .env when the file name lacks it', async () => {
    const user = userEvent.setup();
    renderDialog();
    const { input, file } = pickFile('staging', 'A=1\n');
    await user.upload(input, file);
    await user.click(screen.getByTestId('env-import-submit'));
    await waitFor(() =>
      expect(envApi.writeEnvFile).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'staging.env' }),
        expect.any(String),
        false,
        false,
      ),
    );
  });

  it('stays unsavable until a file is picked', () => {
    renderDialog();
    expect(screen.getByTestId('env-import-submit')).toBeDisabled();
  });

  it('an existing target escalates to an in-dialog Replace, never window.confirm', async () => {
    envApi.writeEnvFile
      .mockResolvedValueOnce({ success: false, exists: true } as EnvWriteResponse)
      .mockResolvedValueOnce({ success: true } as EnvWriteResponse);
    const user = userEvent.setup();
    const { onImported } = renderDialog();
    const { input, file } = pickFile();
    await user.upload(input, file);
    await user.click(screen.getByTestId('env-import-submit'));

    const notice = await screen.findByTestId('env-import-overwrite');
    expect(notice).toHaveTextContent('already exists at this location');

    await user.click(screen.getByTestId('env-import-overwrite-confirm'));
    await waitFor(() => expect(envApi.writeEnvFile).toHaveBeenCalledTimes(2));
    expect(envApi.writeEnvFile).toHaveBeenLastCalledWith(
      expect.anything(),
      'A=1\n',
      true,
      false,
    );
    expect(onImported).toHaveBeenCalled();
  });

  it('an in-use target names the Session impact before forcing the write', async () => {
    envApi.writeEnvFile
      .mockResolvedValueOnce({ success: false, in_use_by: ['api-tests'] } as EnvWriteResponse)
      .mockResolvedValueOnce({ success: true } as EnvWriteResponse);
    const user = userEvent.setup();
    renderDialog();
    const { input, file } = pickFile();
    await user.upload(input, file);
    await user.click(screen.getByTestId('env-import-submit'));

    const notice = await screen.findByTestId('env-import-impact');
    expect(notice).toHaveTextContent('used by 1 running session (api-tests)');

    await user.click(screen.getByTestId('env-import-impact-confirm'));
    await waitFor(() => expect(envApi.writeEnvFile).toHaveBeenCalledTimes(2));
    expect(envApi.writeEnvFile).toHaveBeenLastCalledWith(
      expect.anything(),
      'A=1\n',
      true,
      true,
    );
  });

  it('a plain failure shows the error and keeps the dialog open', async () => {
    envApi.writeEnvFile.mockResolvedValue({ success: false, error: 'disk full' } as EnvWriteResponse);
    const user = userEvent.setup();
    const { onImported } = renderDialog();
    const { input, file } = pickFile();
    await user.upload(input, file);
    await user.click(screen.getByTestId('env-import-submit'));

    expect(await screen.findByText('disk full')).toBeInTheDocument();
    expect(onImported).not.toHaveBeenCalled();
  });
});
