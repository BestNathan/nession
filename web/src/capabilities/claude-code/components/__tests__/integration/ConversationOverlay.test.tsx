import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationOverlay } from '../../ConversationOverlay';
import type { ConversationViewState } from '../../../hooks/useConversation';

/**
 * The Peek's conversation, which had no test at all before this one.
 *
 * `#1167` requires the Peek and the Workspace to render through the **same**
 * transcript, and `#1120` forbids "one chat visual system for Peek and another
 * for Workspace". Both were true by construction — the overlay imports
 * `ConversationTranscript` — and nothing asserted it, which is the arrangement
 * where a second renderer quietly appears and every existing test still passes.
 */

const view: ConversationViewState = {
  listState: 'ready',
  conversations: [],
  binding: null,
  messagesState: 'ready',
  openId: 'claude-1',
  conversation: { id: 'claude-1', cwd: '/work' },
  activity: 'active',
  items: [
    {
      id: 'm1',
      kind: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '# Heading\n\nand `inline` code' }],
    },
    {
      id: 't1',
      kind: 'tool',
      tool: {
        call_id: 'c1',
        name: 'Read',
        status: 'success',
        summary: 'src/main.rs',
        output: { text: 'fn main() {}', kind: 'text', truncated: false },
      },
    },
  ],
  hasMore: false,
  partialTail: false,
  skipped: 0,
  loading: false,
  loadingOlder: false,
  olderError: null,
  error: null,
};

vi.mock('../../../hooks/useConversation', () => ({
  useConversation: () => ({ view, loadOlder: vi.fn() }),
}));

// Spied on but still rendered, so the assertions below can be both about the
// composition *and* about what actually reaches the screen.
vi.mock('../../ConversationTranscript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ConversationTranscript')>();
  return { ...actual, ConversationTranscript: vi.fn(actual.ConversationTranscript) };
});

describe('ConversationOverlay', () => {
  it('renders through the shared transcript rather than one of its own', async () => {
    const { ConversationTranscript } = await import('../../ConversationTranscript');

    render(<ConversationOverlay agentId="a" sessionId="a:s" />);

    // The composition itself. Asserting only on rendered markers would pass on
    // a *fork* of the renderer that happened to keep the same testids — which
    // is precisely the drift `#1120` forbids, so the claim worth making is that
    // this component calls that one.
    expect(ConversationTranscript).toHaveBeenCalled();

    // And that what it renders is the full transcript, not a reduced variant:
    // the turn, the Markdown inside it, and the tool activity.
    expect(screen.getByTestId('conversation-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-turn')).toHaveAttribute('data-role', 'assistant');
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByTestId('conversation-tool-name')).toHaveTextContent('Read');
  });
});
