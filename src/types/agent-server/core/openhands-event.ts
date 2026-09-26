// Import all event types
import {
  ACPCommandResultEvent,
  ACPToolCallEvent,
  ACPMetadataEvent,
  ActionEvent,
  MessageEvent,
  ObservationEvent,
  UserRejectObservation,
  AgentErrorEvent,
  SystemPromptEvent,
  CondensationEvent,
  CondensationRequestEvent,
  CondensationSummaryEvent,
  ConversationStateUpdateEvent,
  ConversationErrorEvent,
  HookExecutionEvent,
  PauseEvent,
  ServerErrorEvent,
  StreamingDeltaEvent,
} from "./events/index";

/**
 * Union type representing all possible OpenHands events.
 * This includes all main event types that can occur in the system.
 */
export type OpenHandsEvent =
  // Core action and observation events
  | ActionEvent
  | MessageEvent
  | ObservationEvent
  | UserRejectObservation
  | AgentErrorEvent
  | SystemPromptEvent
  // ACP sub-agent tool call events
  | ACPToolCallEvent
  // ACP per-turn usage metadata (credits, context %)
  | ACPMetadataEvent
  // ACP slash-command output (/context, /usage, /model, …)
  | ACPCommandResultEvent
  // Hook events
  | HookExecutionEvent
  // Conversation management events
  | CondensationEvent
  | CondensationRequestEvent
  | CondensationSummaryEvent
  | ConversationStateUpdateEvent
  | ConversationErrorEvent
  // Control events
  | PauseEvent
  | ServerErrorEvent
  | StreamingDeltaEvent;
