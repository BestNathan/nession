import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationOverlay } from '../../ConversationOverlay';
import type { AIConversationSnapshot } from '@/shared/ai-conversation';

/**
 * The Peek's conversation, which had no test at all before this one.
 *
 * `#1167` requires the Peek and the Workspace to render through the **same**
 * transcript, and `#1120` forbids "one chat visual system for Peek and another
 * for Workspace". Until #1363 that was true by construction — the overlay
 * imported the capability's `ConversationTranscript` — and nothing asserted it,
 * which is the arrangement where a second renderer quietly appears and every
 * existing test still passes.
 *
 * As of #1363 the claim is stronger and cheaper to hold: there is exactly one
 * transcript in the product, it lives in the shared layer, and this test still
 * asserts that the overlay renders *that* one rather than composing its own.
 */

const snapshot: AIConversationSnapshot = {
  listState: 'ready',
  conversations: [],
  bindingId: null,
  openId: 'claude-1',
  state: 'ready',
  conversation: { id: 'claude-1', activity: 'active' },
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
      callId: 'c1',
      name: 'Read',
      category: 'read',
      status: 'success',
      summary: 'src/main.rs',
      output: { text: 'fn main() {}', kind: 'text', truncated: false },
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

const loadOlder = vi.fn(() => false);

// Spied on but still rendered, so the assertions below can be both about the
// composition *and* about what actually reaches the screen. The runtime is
// replaced so the snapshot is the test's rather than a socket's.
vi.mock('@/shared/ai-conversation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/ai-conversation')>();
  return {
    ...actual,
    ConversationTranscript: vi.fn(actual.ConversationTranscript),
    useAIConversation: () => ({
      snapshot,
      select: vi.fn(),
      reload: vi.fn(),
      loadOlder,
    }),
  };
});

describe('ConversationOverlay', () => {
  it('renders through the shared transcript rather than one of its own', async () => {
    const { ConversationTranscript } = await import('@/shared/ai-conversation');

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
