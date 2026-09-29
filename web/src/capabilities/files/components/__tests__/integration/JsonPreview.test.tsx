import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { JsonPreview } from '@/capabilities/files/components/JsonPreview';
import { JsonlPreview } from '@/capabilities/files/components/JsonlPreview';

describe('JsonPreview', () => {
  it('renders parsed structure as an inspector tree', () => {
    render(<JsonPreview content='{"tags":["a","b"]}' />);
    expect(screen.getByRole('tree')).toBeInTheDocument();
    expect(screen.getByText('"tags"')).toBeInTheDocument();
  });
});

function JsonlPreviewHarness({ content }: { content: string }) {
  return (
    <div style={{ height: 480, display: 'flex', flexDirection: 'column' }}>
      <JsonlPreview content={content} />
    </div>
  );
}

describe('JsonlPreview', () => {
  it('keeps malformed lines local', async () => {
    render(<JsonlPreviewHarness content={'{"ok":true}\n{bad\n{"n":2}'} />);
    await waitFor(() => {
      expect(screen.getByText('Invalid JSON')).toBeInTheDocument();
      expect(screen.getByText('Line 3')).toBeInTheDocument();
    });
  });
});
