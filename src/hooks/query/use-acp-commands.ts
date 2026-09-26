import { useQuery } from "@tanstack/react-query";
import AgentServerConversationService, {
  type AcpCommand,
} from "#/api/conversation-service/agent-server-conversation-service.api";

export const acpCommandsQueryKey = (conversationId: string | null) => [
  "acp-commands",
  conversationId,
];

/**
 * Lists the ACP slash-commands the server advertises for a conversation
 * (populated from the ``commands/available`` notification, e.g. Kiro's
 * ``/compact``, ``/usage``, ``/model``).
 *
 * Timing matters: the commands live on the *running* ACP session, which the
 * agent-server only registers once the conversation's event service is up. If
 * the ACP session is still (re)initializing — e.g. after a
 * ``load_session failed; starting a fresh session`` — the endpoint returns
 * 404 (``get_event_service`` → ``None``). Observed live: the very first
 * poll 404'd, the old ``staleTime: 60s`` + focus-only refetch then cached the
 * failure, and the command menu stayed permanently empty even after the
 * session came up.
 *
 * So this query is resilient to that startup window: it retries the transient
 * 404 and keeps polling at a modest interval until the server advertises at
 * least one command, then stops polling (the list is stable within a session,
 * and a mid-session ``commands/available`` change is still picked up on focus).
 */
export const useAcpCommands = (
  conversationId: string | null,
  enabled: boolean,
) =>
  useQuery<AcpCommand[]>({
    queryKey: acpCommandsQueryKey(conversationId),
    queryFn: () =>
      AgentServerConversationService.listAcpCommands(conversationId as string),
    enabled: enabled && Boolean(conversationId),
    // The ACP session may not be registered yet when we first ask (404), so
    // retry the transient failure a few times with a short backoff.
    retry: 5,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    // Until the server advertises commands, keep polling so the menu populates
    // once the ACP session finishes initializing. Stop once we have any.
    refetchInterval: (query) =>
      (query.state.data?.length ?? 0) > 0 ? false : 3000,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
