import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessage } from '@/components/ChatMessage';
import { ManagedUsageStatus } from '@/components/ChatStatus';

const bridge = vi.hoisted(() => ({
  getManagedUsage: vi.fn(),
}));

vi.mock('@/services', () => ({
  bridge,
  Events: {},
}));

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('ManagedUsageStatus', () => {
  beforeEach(() => {
    bridge.getManagedUsage.mockReset();
  });

  it('shows remaining subscription quota and details for each available window', async () => {
    bridge.getManagedUsage.mockResolvedValue({
      kind: 'ok',
      quota: {
        usages: {
          limit5h: { usedRatio: 0.618, resetAt: '2026-01-01T12:00:00Z' },
          limit7d: { usedRatio: 0.25 },
          monthTotal: { usedRatio: 0.5 },
        },
        extraUsage: null,
      },
    });

    renderWithQuery(<ManagedUsageStatus />);

    const trigger = await screen.findByRole('button', { name: 'Subscription limits' });
    expect(trigger.textContent).toContain('5h 38% left');

    fireEvent.click(trigger);
    expect(await screen.findByText('Weekly limit')).toBeTruthy();
    expect(screen.getByText('75% left')).toBeTruthy();
    expect(screen.getByText('Monthly limit')).toBeTruthy();
    expect(screen.getByText('50% left')).toBeTruthy();
    expect(screen.getByText(/^Resets /)).toBeTruthy();
  });

  it('stays hidden when managed quota is unavailable', async () => {
    bridge.getManagedUsage.mockResolvedValue({ kind: 'error', message: 'Not managed' });

    const { container } = renderWithQuery(<ManagedUsageStatus />);

    await waitFor(() => expect(bridge.getManagedUsage).toHaveBeenCalledOnce());
    expect(container.firstChild).toBeNull();
  });
});

describe('user message line breaks', () => {
  it('preserves single newlines in the rendered Markdown paragraph', () => {
    const { container } = render(
      <ChatMessage
        message={{
          id: 'message-1',
          role: 'user',
          content: 'First line\nSecond line',
          timestamp: 1,
        }}
      />,
    );

    const paragraph = container.querySelector('p');
    expect(paragraph?.textContent).toBe('First line\nSecond line');
    expect(paragraph?.classList.contains('whitespace-pre-wrap')).toBe(true);
  });
});
