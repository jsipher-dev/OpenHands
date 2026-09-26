import React from "react";
import { useTranslation } from "react-i18next";
import { useOptionalConversationId } from "#/hooks/use-conversation-id";
import { useChatInputModelState } from "#/hooks/use-chat-input-model-state";
import { useAcpCommands } from "#/hooks/query/use-acp-commands";
import { useExecuteAcpCommand } from "#/hooks/mutation/use-execute-acp-command";
import { useClickOutsideElement } from "#/hooks/use-click-outside-element";
import { ComboboxCaretInline } from "#/ui/combobox-caret";
import { ContextMenu } from "#/ui/context-menu";
import { ContextMenuListItem } from "#/components/features/context-menu/context-menu-list-item";
import { Typography } from "#/ui/typography";
import { I18nKey } from "#/i18n/declaration";
import { chatInputPillButtonClassName } from "#/utils/form-control-classes";

/**
 * Chat-input pill exposing the ACP server's slash-commands (Kiro's
 * ``/compact``, ``/usage``, ``/model``, …). Populated from the
 * ``commands/available`` notification via {@link useAcpCommands} and executed
 * through {@link useExecuteAcpCommand} (POST /execute_acp_command).
 *
 * Rendered only for a started ACP conversation that advertises at least one
 * command; returns ``null`` otherwise so non-ACP surfaces are unaffected.
 */
export function ChatInputAcpCommands() {
  const { t } = useTranslation("openhands");
  const modelState = useChatInputModelState();
  const { conversationId } = useOptionalConversationId();
  const [isOpen, setIsOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const popoverRef = useClickOutsideElement<HTMLUListElement>(
    () => setIsOpen(false),
    triggerRef,
  );

  // Only fetch/show for a started ACP conversation.
  const enabled = modelState.isAcpContext && Boolean(conversationId);
  const { data: commands } = useAcpCommands(conversationId ?? null, enabled);
  const executeCommand = useExecuteAcpCommand();

  if (!enabled || !commands || commands.length === 0) {
    return null;
  }

  const handleSelect = (name: string) => {
    if (conversationId) {
      executeCommand.mutate({ conversationId, command: name });
    }
    setIsOpen(false);
  };

  return (
    <div className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        className={chatInputPillButtonClassName}
        title={t(I18nKey.ACP_COMMANDS$MENU_LABEL)}
        data-testid="chat-input-acp-commands"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setIsOpen((open) => !open);
        }}
      >
        <span>{t(I18nKey.ACP_COMMANDS$MENU_LABEL)}</span>
        <ComboboxCaretInline isOpen={isOpen} />
      </button>

      {isOpen && (
        <ContextMenu
          ref={popoverRef}
          testId="chat-input-acp-commands-popover"
          position="top"
          alignment="left"
          spacing="none"
          className="z-[60] mb-2 min-w-[220px] max-w-[360px] max-h-[60vh] overflow-y-auto"
        >
          {commands.map((command) => {
            // Kiro may advertise command names already prefixed with a slash
            // (e.g. "/context"). Strip a single leading slash for display so we
            // render "/context", not "//context" (the double-slash bug seen in
            // the Commands dropdown). The SDK re-adds exactly one slash on
            // execute, so pass the bare name.
            const bareName = command.name.replace(/^\/+/, "");
            return (
              <ContextMenuListItem
                key={command.name}
                testId={`acp-command-option-${bareName}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  handleSelect(bareName);
                }}
                className="flex flex-col items-start gap-0.5"
              >
                <span className="text-sm leading-5 text-[var(--oh-foreground)]">
                  /{bareName}
                </span>
                {command.description && (
                  <Typography.Text className="text-[11px] leading-4 text-[var(--oh-text-dim)]">
                    {command.description}
                  </Typography.Text>
                )}
              </ContextMenuListItem>
            );
          })}
        </ContextMenu>
      )}
    </div>
  );
}
