import { describe, expect, it, beforeEach } from "vitest";
import { useEventStore } from "#/stores/use-event-store";
import type { OHEvent } from "#/stores/use-event-store";
import { isACPMetadataEvent } from "#/types/agent-server/type-guards";

/**
 * Reproduction: in a LONG turn the settled ACPMetadataEvent arrives mid-turn,
 * then 70+ more events stream after it. The REST history refetch only returns
 * the newest 50 events (limit:50, TIMESTAMP_DESC), so the metadata event is
 * NOT in the refetched page. This test checks whether the store's addEvents
 * merge keeps the already-present metadata event when a tail page that omits
 * it is merged in at settle.
 */

const ts = (sec: number) =>
  new Date(Date.UTC(2026, 8, 21, 0, 0, sec)).toISOString();

const meta = (): OHEvent =>
  ({
    kind: "ACPMetadataEvent",
    id: "meta-1",
    timestamp: ts(1),
    source: "agent",
    credits: 38.27,
    context_usage_percentage: 22,
    turn_duration_ms: 2025390,
    provider: "Kiro CLI Agent",
  }) as unknown as OHEvent;

const toolEvent = (n: number): OHEvent =>
  ({
    kind: "ACPToolCallEvent",
    id: `tc-${n}`,
    timestamp: ts(2 + n),
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

describe("ACPMetadataEvent survives the 50-event-tail settle refetch", () => {
  beforeEach(() => {
    useEventStore.getState().clearEvents();
  });

  it("keeps the metadata chip after a tail refetch that omits it", () => {
    const store = useEventStore.getState();
    // Live: metadata arrives, then 70 more events stream after it.
    store.addEvent(meta());
    for (let i = 1; i <= 70; i += 1) {
      store.addEvent(toolEvent(i));
    }
    expect(
      useEventStore.getState().uiEvents.some(isACPMetadataEvent),
    ).toBe(true);

    // Settle: REST refetch returns only the newest 50 events (no metadata).
    const tail: OHEvent[] = [];
    for (let i = 21; i <= 70; i += 1) tail.push(toolEvent(i));
    useEventStore.getState().addEvents(tail);

    const metasInUi = useEventStore
      .getState()
      .uiEvents.filter(isACPMetadataEvent);
    expect(metasInUi.length).toBe(1);
  });
});
