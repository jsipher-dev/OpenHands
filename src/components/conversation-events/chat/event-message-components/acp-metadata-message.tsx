import { useTranslation } from "react-i18next";
import { ACPMetadataEvent } from "#/types/agent-server/core/events/acp-metadata-event";
import { I18nKey } from "#/i18n/declaration";

interface ACPMetadataMessageProps {
  event: ACPMetadataEvent;
}

/**
 * Compact per-turn usage line for ACP providers that report it (e.g. Kiro):
 * "Credits: 0.21 · Context: 12% · 8s". Rendered as a small dim chip beneath
 * the turn rather than a full event card. Values that the provider did not
 * report are omitted. Renders nothing when no metric is present.
 */
export function ACPMetadataMessage({ event }: ACPMetadataMessageProps) {
  const { t } = useTranslation("openhands");
  const parts: string[] = [];

  if (event.credits !== null && event.credits !== undefined) {
    parts.push(
      `${t(I18nKey.ACP_METADATA$CREDITS)}: ${event.credits.toFixed(2)}`,
    );
  }
  if (
    event.context_usage_percentage !== null &&
    event.context_usage_percentage !== undefined
  ) {
    parts.push(
      `${t(I18nKey.ACP_METADATA$CONTEXT)}: ${Math.round(
        event.context_usage_percentage,
      )}%`,
    );
  }
  if (event.turn_duration_ms !== null && event.turn_duration_ms !== undefined) {
    parts.push(`${Math.round(event.turn_duration_ms / 1000)}s`);
  }

  if (parts.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="acp-metadata-message"
      className="px-2 py-0.5 text-[11px] leading-4 text-[var(--oh-text-dim)] select-text"
      title={
        event.provider
          ? `${event.provider} · ${parts.join(" · ")}`
          : parts.join(" · ")
      }
    >
      {parts.join(" · ")}
    </div>
  );
}
