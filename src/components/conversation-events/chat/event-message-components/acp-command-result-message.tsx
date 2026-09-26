import { useTranslation } from "react-i18next";
import { ACPCommandResultEvent } from "#/types/agent-server/core/events/acp-command-result-event";
import { I18nKey } from "#/i18n/declaration";

interface ACPCommandResultMessageProps {
  event: ACPCommandResultEvent;
}

/**
 * Renders the output of an ACP slash-command (e.g. Kiro's ``/context`` or
 * ``/usage``): a small header with the command name followed by the
 * server-provided message. The message is preformatted text (breakdowns,
 * usage tables), so it is rendered in a monospace block that preserves
 * whitespace. Renders a compact "no output" note if the command returned
 * nothing so the user still sees that it ran.
 */
export function ACPCommandResultMessage({
  event,
}: ACPCommandResultMessageProps) {
  const { t } = useTranslation("openhands");
  const header = event.command.startsWith("/")
    ? event.command
    : `/${event.command}`;

  return (
    <div
      data-testid="acp-command-result-message"
      className="my-1 rounded-md border border-[var(--oh-border,#333)] bg-[var(--oh-surface,#1a1a1a)] px-3 py-2 text-sm select-text"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono font-semibold text-[var(--oh-accent,#6cc)]">
          {header}
        </span>
        {!event.success && (
          <span className="text-[11px] text-[var(--oh-error,#e66)]">
            {t(I18nKey.ACP_COMMANDS$FAILED)}
          </span>
        )}
      </div>
      {event.message ? (
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-[var(--oh-text,#ddd)]">
          {event.message}
        </pre>
      ) : (
        <div className="mt-1 text-[12px] text-[var(--oh-text-dim,#999)]">
          {t(I18nKey.ACP_COMMANDS$NO_OUTPUT)}
        </div>
      )}
    </div>
  );
}
