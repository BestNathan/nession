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
  conversationKey: 'fixture:claude-1',
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
  listLoading: false,
  threadLoading: false,
  loadingOlder: false,
  olderError: null,
  listError: null,
  threadError: null,
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

  it('hands the transcript the retry its degraded state offers', async () => {
    // #1363 round 3. `ConversationUnavailable` renders a Retry, and the runtime
    // stops refreshing on a non-ready answer — so a surface that does not pass
    // this prop leaves the reader a control that reloads the page and nothing
    // else. The Workspace passed it; the Peek did not, and nothing said so.
    //
    // Asserted on the *composition* for the same reason the test above is: the
    // rendered markers cannot tell "the overlay wired the command" from "the
    // transcript happened to draw a button".
    const { ConversationTranscript } = await import('@/shared/ai-conversation');

    render(<ConversationOverlay agentId="a" sessionId="a:s" />);

    const calls = vi.mocked(ConversationTranscript).mock.calls;
    const props = calls[calls.length - 1]?.[0];
    expect(props?.onReload).toBeTypeOf('function');
  });
});
