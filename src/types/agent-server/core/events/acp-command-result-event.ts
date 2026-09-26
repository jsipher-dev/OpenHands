import { BaseEvent } from "../base/event";

/**
 * ACPCommandResultEvent — the output of an ACP slash-command (e.g. Kiro's
 * ``/context``, ``/usage``, ``/model``). The ACP server executes the command
 * and returns a human-readable ``message`` plus an optional structured
 * ``data`` payload; this event carries that output into the chat so the user
 * sees the result. Previously the SDK collapsed the response to a bare
 * ``success`` boolean and discarded the message/data, so output-only commands
 * appeared to do nothing.
 */
export interface ACPCommandResultEvent extends BaseEvent {
  /** Discriminator for the V1 event union. */
  kind: "ACPCommandResultEvent";

  /** ACP sub-agent is the source; kept as ``"agent"`` in the SDK. */
  source: "agent";

  /** The executed slash-command, normalized with a single leading slash. */
  command: string;

  /** The ACP server's success flag for the command. */
  success: boolean;

  /** Human-readable output produced by the command. ``null`` if none. */
  message: string | null;

  /** Optional structured payload returned by the command. ``null`` if none. */
  data: Record<string, unknown> | null;

  /** Provider label (e.g. the ACP agent name) for display/attribution. */
  provider: string | null;
}
