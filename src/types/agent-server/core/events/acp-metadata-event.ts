import { BaseEvent } from "../base/event";

/**
 * ACPMetadataEvent — per-turn usage metadata reported by an ACP server
 * extension (e.g. Kiro's ``_kiro.dev/metadata``). Surfaces the credits
 * consumed and the percentage of the context window used so the GUI can show
 * "Credits: 0.21 | Context: 12%" after each turn.
 *
 * Credits and context percentage are provider-defined units, kept distinct
 * from the LLM cost (USD) and token counts so they are never mislabeled.
 */
export interface ACPMetadataEvent extends BaseEvent {
  /** Discriminator for the V1 event union. */
  kind: "ACPMetadataEvent";

  /** ACP sub-agent is the source; kept as ``"agent"`` in the SDK. */
  source: "agent";

  /** Credits consumed for the turn (provider unit). ``null`` if not reported. */
  credits: number | null;

  /** Percentage of the context window used (0-100), if reported. */
  context_usage_percentage: number | null;

  /** Wall-clock duration of the turn in milliseconds, if reported. */
  turn_duration_ms: number | null;

  /** Provider label (e.g. the ACP agent name) for display/attribution. */
  provider: string | null;
}
