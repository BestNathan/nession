import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvVariablesView } from '@/capabilities/env/components/EnvVariablesView';
import { MASKED_VALUE } from '@/capabilities/env/model/sensitive';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from 'sonner';

function vars(...entries: [string, string][]): [string, string][] {
  return entries;
}

describe('EnvVariablesView', () => {
  it('renders key and value in mono rows', () => {
    render(<EnvVariablesView vars={vars(['NODE_ENV', 'production'])} warnings={[]} />);
    const row = screen.getByTestId('env-var-row-NODE_ENV');
    expect(row).toHaveTextContent('NODE_ENV');
    expect(row).toHaveTextContent('production');
  });

  it('an empty value says (empty) — masked and empty never look alike', () => {
    render(
      <EnvVariablesView
        vars={vars(['EMPTY_VAR', ''], ['API_KEY', 'supersecret'])}
        warnings={[]}
      />,
    );
    expect(screen.getByTestId('env-var-row-EMPTY_VAR')).toHaveTextContent('(empty)');
    const masked = screen.getByTestId('env-var-masked-API_KEY');
    expect(masked).toHaveTextContent(MASKED_VALUE);
    expect(masked).not.toHaveTextContent('(empty)');
  });

  it('masks sensitive-looking keys by default and reveals per row, ephemerally', async () => {
    const user = userEvent.setup();
    render(
      <EnvVariablesView
        vars={vars(['API_KEY', 'supersecret'], ['PLAIN_VAR', 'visible'])}
        warnings={[]}
      />,
    );
    expect(screen.queryByText('supersecret')).not.toBeInTheDocument();
    expect(screen.getByText('visible')).toBeInTheDocument();

    await user.click(screen.getByTestId('env-var-reveal-API_KEY'));
    expect(screen.getByText('supersecret')).toBeInTheDocument();
    expect(screen.queryByTestId('env-var-masked-API_KEY')).not.toBeInTheDocument();

    // And hides again — the reveal is a per-row toggle, not a mode.
    await user.click(screen.getByTestId('env-var-reveal-API_KEY'));
    expect(screen.queryByText('supersecret')).not.toBeInTheDocument();
  });

  it('reveal-all discloses every sensitive value at once', async () => {
    const user = userEvent.setup();
    render(
      <EnvVariablesView
        vars={vars(['API_KEY', 'k1'], ['DB_PASSWORD', 'p1'], ['PLAIN', 'v'])}
        warnings={[]}
      />,
    );
    await user.click(screen.getByTestId('env-reveal-all'));
    expect(screen.getByText('k1')).toBeInTheDocument();
    expect(screen.getByText('p1')).toBeInTheDocument();
    expect(screen.queryByTestId('env-reveal-all')).not.toBeInTheDocument();
  });

  it('copy of a masked row carries the real value, never the bullets', async () => {
    const user = userEvent.setup();
    // userEvent.setup() installs its own clipboard stub, so the mock goes in
    // after it, not before.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<EnvVariablesView vars={vars(['API_KEY', 'supersecret'])} warnings={[]} />);

    await user.click(screen.getByTestId('env-var-copy-API_KEY'));
    expect(writeText).toHaveBeenCalledWith('supersecret');
    expect(writeText).not.toHaveBeenCalledWith(MASKED_VALUE);
    expect(toast.success).toHaveBeenCalledWith('Copied API_KEY');
  });

  it('a clipboard failure says so instead of pretending', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    render(<EnvVariablesView vars={vars(['PLAIN', 'v'])} warnings={[]} />);
    await user.click(screen.getByTestId('env-var-copy-PLAIN'));
    expect(toast.error).toHaveBeenCalledWith(
      'Copy failed — the browser denied clipboard access',
    );
  });

  it('offers a filter field only past the threshold, and filters key and value', async () => {
    const user = userEvent.setup();
    const few = render(
      <EnvVariablesView vars={vars(['A', '1'], ['B', '2'])} warnings={[]} />,
    );
    expect(screen.queryByTestId('env-var-search')).not.toBeInTheDocument();
    few.unmount();

    render(
      <EnvVariablesView
        vars={vars(
          ['NODE_ENV', 'production'],
          ['PORT', '8080'],
          ['LOG_LEVEL', 'debug'],
          ['REGION', 'us-east-1'],
          ['API_KEY', 'secret'],
          ['DATABASE_URL', 'postgres://x'],
        )}
        warnings={[]}
      />,
    );
    await user.type(screen.getByTestId('env-var-search'), 'postgres');
    expect(screen.queryByTestId('env-var-row-NODE_ENV')).not.toBeInTheDocument();
    expect(screen.getByTestId('env-var-row-DATABASE_URL')).toBeInTheDocument();

    await user.clear(screen.getByTestId('env-var-search'));
    await user.type(screen.getByTestId('env-var-search'), 'zzz');
    expect(screen.getByText('No variables match “zzz”')).toBeInTheDocument();
  });

  it('names the skipped lines instead of hiding them', () => {
    render(
      <EnvVariablesView vars={vars(['A', '1'])} warnings={['line 3: no equals sign']} />,
    );
    const section = screen.getByTestId('env-var-warnings');
    expect(section).toHaveTextContent('1 line skipped');
    expect(section).toHaveTextContent('line 3: no equals sign');
  });
});
