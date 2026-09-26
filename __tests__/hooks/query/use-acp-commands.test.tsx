import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAcpCommands } from "#/hooks/query/use-acp-commands";

// Mock the service method the hook calls.
const listAcpCommands = vi.hoisted(() => vi.fn());
vi.mock(
  "#/api/conversation-service/agent-server-conversation-service.api",
  () => ({
    default: {
      listAcpCommands: (...args: unknown[]) => listAcpCommands(...args),
    },
  }),
);

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      // Honor the hook's own retry config, but with no delay so the test is
      // fast (the hook sets retry: 5 + a backoff we override here to 0).
      queries: { retryDelay: 0 },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

class HttpError extends Error {
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useAcpCommands", () => {
  it("does not query when disabled (non-ACP conversation)", () => {
    renderHook(() => useAcpCommands("conv-1", false), {
      wrapper: makeWrapper(),
    });
    expect(listAcpCommands).not.toHaveBeenCalled();
  });

  it("recovers from a transient 404 during ACP session startup and populates commands", async () => {
    // The ACP session isn't registered yet: first call 404s (get_event_service
    // -> None). Once the session comes up, the endpoint returns the commands.
    listAcpCommands
      .mockRejectedValueOnce(new HttpError(404))
      .mockRejectedValueOnce(new HttpError(404))
      .mockResolvedValue([
        { name: "compact", description: "Compact the conversation" },
        { name: "context", description: "Manage context" },
      ]);

    const { result } = renderHook(() => useAcpCommands("conv-1", true), {
      wrapper: makeWrapper(),
    });

    await waitFor(
      () =>
        expect(result.current.data?.map((c) => c.name)).toEqual([
          "compact",
          "context",
        ]),
      // The hook's own retryDelay (1s, then 2s backoff) applies to the two
      // 404s before the success, so allow past the cumulative backoff.
      { timeout: 8000 },
    );
    // It retried past the two 404s rather than caching an empty menu.
    expect(listAcpCommands.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
