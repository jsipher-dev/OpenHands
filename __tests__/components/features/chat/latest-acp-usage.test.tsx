import { describe, expect, it, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "test-utils";
import { LatestACPUsage } from "#/components/features/chat/latest-acp-usage";
import { useEventStore } from "#/stores/use-event-store";
import type { OHEvent } from "#/stores/use-event-store";

const ts = (sec: number) =>
  new Date(Date.UTC(2026, 8, 21, 0, 0, sec)).toISOString();

const meta = (id: string, credits: number, sec: number): OHEvent =>
  ({
    kind: "ACPMetadataEvent",
    id,
    timestamp: ts(sec),
    source: "agent",
    credits,
    context_usage_percentage: 22,
    turn_duration_ms: 2025390,
    provider: "Kiro CLI Agent",
  }) as unknown as OHEvent;

const tool = (n: number): OHEvent =>
  ({
    kind: "ACPToolCallEvent",
    id: `tc-${n}`,
    timestamp: ts(100 + n),
    source: "agent",
    tool_call_id: `tc-${n}`,
    title: `tool ${n}`,
    status: "completed",
    tool_kind: "execute",
    raw_input: null,
    raw_output: null,
    content: null,
    is_error: false,
  }) as unknown as OHEvent;

describe("LatestACPUsage", () => {
  beforeEach(() => {
    useEventStore.getState().clearEvents();
  });

  it("renders nothing when there is no metadata event", () => {
    renderWithProviders(<LatestACPUsage />);
    expect(screen.queryByTestId("acp-metadata-message")).toBeNull();
  });

  it("shows the latest metadata even when it is buried by later events", () => {
    const store = useEventStore.getState();
    store.addEvent(meta("m1", 5.15, 1));
    // Latest metadata settles, then many later events bury it in the store.
    store.addEvent(meta("m2", 38.27, 2));
    for (let i = 1; i <= 60; i += 1) store.addEvent(tool(i));

    renderWithProviders(<LatestACPUsage />);

    const chip = screen.getByTestId("acp-metadata-message");
    // The newest metadata (38.27), not the older one (5.15).
    expect(chip.textContent).toContain("38.27");
    expect(chip.textContent).not.toContain("5.15");
  });

  it("survives a 50-event tail refetch that omits the metadata event", () => {
    const store = useEventStore.getState();
    store.addEvent(meta("m2", 38.27, 2));
    for (let i = 1; i <= 60; i += 1) store.addEvent(tool(i));
    // Settle refetch returns only the newest tool events (no metadata).
    const tail: OHEvent[] = [];
    for (let i = 11; i <= 60; i += 1) tail.push(tool(i));
    useEventStore.getState().addEvents(tail);

    renderWithProviders(<LatestACPUsage />);
    expect(screen.getByTestId("acp-metadata-message").textContent).toContain(
      "38.27",
    );
  });
});
