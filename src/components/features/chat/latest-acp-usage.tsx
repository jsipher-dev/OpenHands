import { useEventStore } from "#/stores/use-event-store";
import { isACPMetadataEvent } from "#/types/agent-server/type-guards";
import { ACPMetadataEvent } from "#/types/agent-server/core/events/acp-metadata-event";
import { ACPMetadataMessage } from "#/components/conversation-events/chat/event-message-components/acp-metadata-message";

/**
 * Renders the most recent per-turn ACP usage chip (credits / context % /
 * duration) pinned at the end of the message flow, read directly from the
 * event store.
 *
 * Why a dedicated store-derived element instead of the in-stream event:
 * the settled ACPMetadataEvent arrives mid-turn and can end up buried dozens
 * of events deep once the agent keeps working, and its survival as a
 * middle-of-list event was fragile across streaming reconciliation, timestamp
 * re-sorts, the Messages render memo, and the 50-event REST tail refetch —
 * which is why the chip intermittently vanished on turn-settle. Selecting the
 * latest metadata event straight from the store and rendering it in one stable
 * position makes its visibility independent of all that machinery: as long as
 * the event is in the store (verified to survive merges/refetches), the chip
 * shows.
 */
export function LatestACPUsage() {
  const latest = useEventStore((state) => {
    for (let i = state.events.length - 1; i >= 0; i -= 1) {
      const event = state.events[i];
      if (isACPMetadataEvent(event)) {
        return event as ACPMetadataEvent;
      }
    }
    return null;
  });

  if (!latest) {
    return null;
  }

  return <ACPMetadataMessage event={latest} />;
}
