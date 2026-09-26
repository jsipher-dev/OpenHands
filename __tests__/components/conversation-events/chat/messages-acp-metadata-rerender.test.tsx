import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "test-utils";
import { Messages } from "#/components/conversation-events/chat/messages";
import { MessageEvent } from "#/types/agent-server/core";
import { StreamingDeltaEvent } from "#/types/agent-server/core/events/streaming-delta-event";
import { ACPMetadataEvent } from "#/types/agent-server/core/events/acp-metadata-event";

/**
 * Regression for the live "credits/context chip vanishes on turn-settle" bug
 * (screenshots 2026-09-20 17:32 → 17:33). The store keeps the ACPMetadataEvent
 * (proven in the store integration test), but `Messages` is wrapped in
 * `React.memo` with a custom comparator that only looked at array length + the
 * LAST event. On settle the metadata chip settles into a NON-last position (the
 * final agent message sorts after it), so a frame where only that middle
 * element changed — same length, same last event — was skipped by the
 * comparator and the chip never rendered. The fix folds a metadata-id signature
 * into the comparator.
 */

const user: MessageEvent = {
  id: "u1",
  timestamp: "2024-03-01T00:00:00Z",
  source: "user",
  llm_message: { role: "user", content: [{ type: "text", text: "hi" }] },
  activated_skills: [],
  extended_content: [],
};

const finalMessage: MessageEvent = {
  id: "final-1",
  timestamp: "2024-03-01T00:00:09Z",
  source: "agent",
  llm_message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  activated_skills: [],
  extended_content: [],
};

const delta: StreamingDeltaEvent = {
  id: "delta-1",
  timestamp: "2024-03-01T00:00:05Z",
  source: "agent",
  kind: "StreamingDeltaEvent",
  content: "done",
  reasoning_content: null,
};

const metadata: ACPMetadataEvent = {
  id: "acp-meta-1",
  timestamp: "2024-03-01T00:00:08Z",
  source: "agent",
  kind: "ACPMetadataEvent",
  credits: 2.6,
  context_usage_percentage: 10,
  turn_duration_ms: 79000,
  provider: "Kiro CLI Agent",
};

describe("Messages ACP metadata chip re-renders on settle", () => {
  it("shows the chip when it settles into a non-last position (same length + last event)", () => {
    // Pre-settle frame: [user, delta, finalMessage] — no metadata yet, length 3,
    // last = finalMessage. (The delta stands in for streamed text of the turn.)
    const before = [user, delta, finalMessage];
    // Settled frame: the streamed delta is superseded and the metadata chip
    // sorts into the middle → [user, metadata, finalMessage]. SAME length (3)
    // and SAME last event (finalMessage) as `before`, differing only in the
    // middle element. The old comparator skipped this update.
    const after = [user, metadata, finalMessage];

    const { rerender } = renderWithProviders(
      <Messages messages={before} allEvents={before} />,
    );
    expect(
      screen.queryByTestId("acp-metadata-message"),
    ).not.toBeInTheDocument();

    rerender(<Messages messages={after} allEvents={after} />);

    // With the fix, the metadata-id signature changed, so Messages re-renders
    // and the chip appears. Without it, this assertion fails (chip missing).
    expect(screen.getByTestId("acp-metadata-message")).toBeInTheDocument();
    expect(screen.getByTestId("acp-metadata-message")).toHaveTextContent(
      "2.60",
    );
  });
});
