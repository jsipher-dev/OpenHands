import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "test-utils";
import { EventMessage } from "#/components/conversation-events/chat/event-message";
import { useAgentState } from "#/hooks/use-agent-state";
import { AgentState } from "#/types/agent-state";
import { ACPMetadataEvent } from "#/types/agent-server/core/events/acp-metadata-event";

vi.mock("#/hooks/query/use-config", () => ({
  useConfig: () => ({ data: { APP_MODE: "local" } }),
}));
vi.mock("#/hooks/use-agent-state");
vi.mock("#/hooks/use-conversation-id", () => ({
  useOptionalConversationId: () => ({ conversationId: "test-conversation-id" }),
  useConversationId: () => ({ conversationId: "test-conversation-id" }),
}));

const makeEvent = (
  overrides: Partial<ACPMetadataEvent> = {},
): ACPMetadataEvent => ({
  kind: "ACPMetadataEvent",
  id: "evt-meta-1",
  timestamp: "2026-04-16T19:32:29.828069",
  source: "agent",
  credits: 0.21,
  context_usage_percentage: 12.5,
  turn_duration_ms: 8000,
  provider: "Kiro CLI Agent",
  ...overrides,
});

describe("EventMessage - ACPMetadataEvent dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAgentState).mockReturnValue({
      curAgentState: AgentState.INIT,
      executionStatus: null,
    });
  });

  it("renders credits, context %, and duration in a compact chip", () => {
    renderWithProviders(
      <EventMessage
        event={makeEvent()}
        messages={[]}
        isLastMessage={false}
        isInLast10Actions={false}
      />,
    );

    const chip = screen.getByTestId("acp-metadata-message");
    // i18n falls back to the key literal in the test bundle, so assert on the
    // numeric values that are locale-independent.
    expect(chip.textContent).toContain("0.21");
    expect(chip.textContent).toContain("13%");
    expect(chip.textContent).toContain("8s");
  });

  it("omits metrics the provider did not report", () => {
    renderWithProviders(
      <EventMessage
        event={makeEvent({
          credits: 0.15,
          context_usage_percentage: null,
          turn_duration_ms: null,
        })}
        messages={[]}
        isLastMessage={false}
        isInLast10Actions={false}
      />,
    );

    const chip = screen.getByTestId("acp-metadata-message");
    expect(chip.textContent).toContain("0.15");
    expect(chip.textContent).not.toContain("%");
    expect(chip.textContent).not.toMatch(/\ds/);
  });

  it("renders nothing when no metric is present", () => {
    renderWithProviders(
      <EventMessage
        event={makeEvent({
          credits: null,
          context_usage_percentage: null,
          turn_duration_ms: null,
        })}
        messages={[]}
        isLastMessage={false}
        isInLast10Actions={false}
      />,
    );

    expect(screen.queryByTestId("acp-metadata-message")).toBeNull();
  });
});
