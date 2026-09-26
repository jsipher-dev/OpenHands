import { useMutation, useQueryClient } from "@tanstack/react-query";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import { invalidateConversationQueries } from "./conversation-mutation-utils";
import { acpCommandsQueryKey } from "../query/use-acp-commands";

interface ExecuteAcpCommandVars {
  conversationId: string;
  command: string;
}

/**
 * Executes an ACP slash-command on the live session (POST
 * /execute_acp_command). Used by the chat-input command menu to run things
 * like ``/compact`` (compact the context), ``/usage``, or ``/model``.
 *
 * On success, conversation queries are invalidated so any command that changes
 * conversation state (e.g. ``/compact`` rewriting the context) is reflected,
 * and the command list is refetched in case the set of available commands
 * changed.
 */
export const useExecuteAcpCommand = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ conversationId, command }: ExecuteAcpCommandVars) =>
      AgentServerConversationService.executeAcpCommand(conversationId, command),
    onSuccess: (_success, { conversationId }) => {
      invalidateConversationQueries(queryClient, conversationId);
      queryClient.invalidateQueries({
        queryKey: acpCommandsQueryKey(conversationId),
      });
    },
  });
};
