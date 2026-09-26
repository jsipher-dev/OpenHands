import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "test-utils";
import { EventMessage } from "#/components/conversation-events/chat/event-message";
import { useAgentState } from "#/hooks/use-agent-state";
import { AgentState } from "#/types/agent-state";
import { ACPCommandResultEvent } from "#/types/agent-server/core/events/acp-command-result-event";
import { shouldRenderEvent } from "#/components/conversation-events/chat/event-content-helpers/should-render-event";

vi.mock("#/hooks/query/use-config", () => ({
  useConfig: () => ({ data: { APP_MODE: "local" } }),
}));
vi.mock("#/hooks/use-agent-state");
vi.mock("#/hooks/use-conversation-id", () => ({
  useOptionalConversationId: () => ({ conversationId: "test-conversation-id" }),
  useConversationId: () => ({ conversationId: "test-conversation-id" }),
}));

const makeEvent = (
  overrides: Partial<ACPCommandResultEvent> = {},
): ACPCommandResultEvent => ({
  kind: "ACPCommandResultEvent",
  id: "evt-cmd-1",
  timestamp: "2026-04-16T19:32:29.828069",
  source: "agent",
  command: "/context",
  success: true,
  message: "Context breakdown - 3% used",
  data: { contextUsagePercentage: 3.4 },
  provider: "Kiro CLI Agent",
  ...overrides,
});

describe("EventMessage - ACPCommandResultEvent dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAgentState).mockReturnValue({
      curAgentState: AgentState.INIT,
      executionStatus: null,
    });
  });

  it("is renderable by shouldRenderEvent", () => {
    expect(shouldRenderEvent(makeEvent())).toBe(true);
  });

  it("renders the command name and the returned message", () => {
    renderWithProviders(
      <EventMessage
        event={makeEvent()}
        messages={[]}
        isLastMessage={false}
        isInLast10Actions={false}
      />,
    );

    const card = screen.getByTestId("acp-command-result-message");
    expect(card.textContent).toContain("/context");
    expect(card.textContent).toContain("Context breakdown - 3% used");
  });

  it("normalizes a bare command name to a single leading slash", () => {
    renderWithProviders(
      <EventMessage
        event={makeEvent({ command: "usage", message: "Credits 77%" })}
        messages={[]}
        isLastMessage={false}
        isInLast10Actions={false}
      />,
    );

    const card = screen.getByTestId("acp-command-result-message");
    expect(card.textContent).toContain("/usage");
    expect(card.textContent).not.toContain("//usage");
  });

  it("shows a 'no output' note when the command returned no message", () => {
    renderWithProviders(
      <EventMessage
        event={makeEvent({ message: null, data: null })}
        messages={[]}
        isLastMessage={false}
        isInLast10Actions={false}
      />,
    );

    // The card still renders so the user sees the command ran.
    expect(
      screen.getByTestId("acp-command-result-message"),
    ).toBeInTheDocument();
  });
});
