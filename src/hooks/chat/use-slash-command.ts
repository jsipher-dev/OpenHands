import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useConversationSkills } from "#/hooks/query/use-conversation-skills";
import { SkillInfo } from "#/types/settings";
import { BUILT_IN_COMMANDS, MODEL_COMMAND } from "#/utils/constants";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { useLlmProfiles } from "#/hooks/query/use-llm-profiles";
import { useFreeModels } from "#/hooks/query/use-free-models";
import { formatModelNameForDisplay } from "#/utils/format-model-name";
import { useOptionalConversationId } from "#/hooks/use-conversation-id";
import { useChatInputModelState } from "#/hooks/use-chat-input-model-state";
import { useAcpCommands } from "#/hooks/query/use-acp-commands";
import { useExecuteAcpCommand } from "#/hooks/mutation/use-execute-acp-command";

export type SlashCommandSkill = SkillInfo;

export interface SlashCommandItem {
  skill: SlashCommandSkill;
  /** The slash command string, e.g. "/random-number" */
  command: string;
  /**
   * When true, this command is a live ACP server command (e.g. Kiro's
   * ``/compact``, ``/model``, ``/usage``). Picking it runs the command over
   * the ACP ``_kiro.dev/commands/execute`` RPC (via {@link useExecuteAcpCommand})
   * instead of substituting the text and sending it as a prompt — mirroring the
   * Eclipse reference client, which suppresses the prompt and calls
   * ``executeCommand`` on pick.
   */
  isAcpCommand?: boolean;
}

type SlashCompletionKind = "command" | "model-profile";

/** Get the cursor's character offset within a contentEditable element. */
function getCursorOffset(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return -1;
  const range = selection.getRangeAt(0);
  const preRange = range.cloneRange();
  preRange.selectNodeContents(element);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}

/**
 * Hook for managing slash command autocomplete in the chat input.
 * Detects when user types "/" and provides filtered skill suggestions.
 * Only skills with explicit "/" triggers (TaskTrigger) appear in the menu.
 */
export const useSlashCommand = (
  chatInputRef: React.RefObject<HTMLDivElement | null>,
) => {
  // Scope the skill catalog to this conversation's attached workspace so the
  // slash menu lists the same project skills that were loaded into it.
  const { data: skills, isLoading: isSkillsLoading } = useConversationSkills();
  const isCloud = useActiveBackend().backend.kind === "cloud";
  const { data: profilesData, isLoading: isProfilesLoading } = useLlmProfiles();
  const freeModels = useFreeModels();

  // Live ACP server commands (Kiro's /compact, /model, /usage, …). Only
  // populated for a started ACP conversation; empty otherwise so non-ACP
  // surfaces (every normal OpenHands chat) are unaffected.
  const { conversationId } = useOptionalConversationId();
  const { isAcpContext } = useChatInputModelState();
  const acpEnabled = isAcpContext && Boolean(conversationId);
  const { data: acpCommands } = useAcpCommands(
    conversationId ?? null,
    acpEnabled,
  );
  const executeAcpCommand = useExecuteAcpCommand();

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [completionKind, setCompletionKind] =
    useState<SlashCompletionKind>("command");
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Build slash command items from built-in commands + skills:
  // - Built-in commands (like /new) are included for V1 conversations
  // - /new is cloud-only — local backends don't surface it
  // - /model lists/switches LLM profiles; both local and cloud support them
  // - Skills with explicit "/" triggers use those triggers
  // - AgentSkills without "/" triggers get a derived "/<name>" command
  const slashItems = useMemo(() => {
    // Live ACP server commands come first so a Kiro command (e.g. /context,
    // /compact) takes precedence over a same-named workspace skill and is what
    // the typeahead resolves to. Mirrors the Eclipse reference client, which
    // lists session.getAvailableCommands() alongside ~/.kiro/skills.
    const acpItems: SlashCommandItem[] = (acpCommands ?? []).map((cmd) => {
      const name = cmd.name.startsWith("/") ? cmd.name.slice(1) : cmd.name;
      return {
        isAcpCommand: true,
        command: `/${name}`,
        skill: {
          name,
          type: "agentskills",
          source: null,
          content: cmd.description || undefined,
          triggers: [`/${name}`],
        },
      };
    });

    const items: SlashCommandItem[] = [
      ...acpItems,
      ...BUILT_IN_COMMANDS.filter((cmd) => {
        if (cmd.command === "/new") return isCloud;
        return true;
      }),
    ];

    // Wait for skills to finish initial load so all commands appear together
    if (isSkillsLoading) return items;

    if (!skills) return items;
    skills.forEach((skill) => {
      const triggers = skill.triggers || [];
      const slashTriggers = triggers.filter((t) => t.startsWith("/"));

      if (slashTriggers.length > 0) {
        // Skill has explicit slash triggers
        slashTriggers.forEach((trigger) => {
          items.push({ skill, command: trigger });
        });
      } else if (skill.type === "agentskills") {
        // AgentSkills without slash triggers get a derived command
        items.push({ skill, command: `/${skill.name}` });
      }
    });
    return items;
  }, [acpCommands, skills, isSkillsLoading, isCloud]);

  const modelProfileItems = useMemo<SlashCommandItem[]>(() => {
    return (profilesData?.profiles ?? []).map((profile) => {
      const command = `${MODEL_COMMAND} ${profile.name}`;
      return {
        command,
        skill: {
          name: profile.name,
          type: "agentskills",
          source: null,
          content: profile.model
            ? `Switch to ${formatModelNameForDisplay(profile.model, freeModels)}`
            : "Switch to this LLM profile",
          triggers: [command],
        },
      };
    });
  }, [profilesData?.profiles, freeModels]);

  // Filter items based on user input after "/"
  const filteredItems = useMemo(() => {
    const sourceItems =
      completionKind === "model-profile" ? modelProfileItems : slashItems;
    if (!filterText) return sourceItems;
    const lower = filterText.toLowerCase();

    // A match can occur on the command, the skill name, or the description
    // (content). Description matches keep unrelated-but-related commands
    // discoverable, but they must NOT outrank a command whose *name* matches
    // what was typed. Otherwise typing a full command like "/usage" resolves to
    // a command whose description merely mentions "usage" (e.g. Kiro's
    // "/context" — description "…or show usage") because ACP items are
    // prepended and selectedIndex defaults to 0 → Enter runs the wrong command.
    //
    // Rank each match so name matches win over description-only matches:
    //   0 = command/name is exactly the typed text (best)
    //   1 = command/name starts with the typed text
    //   2 = command/name contains the typed text
    //   3 = only the description contains the typed text (weakest)
    // Ties preserve source order (stable sort) so the existing
    // ACP-before-built-ins-before-skills ordering is kept within a rank.
    const rank = (item: SlashCommandItem): number => {
      const command = item.command.toLowerCase();
      const name = item.skill.name.toLowerCase();
      const slashLower = `/${lower}`;
      if (command === slashLower || name === lower) return 0;
      if (command.startsWith(slashLower) || name.startsWith(lower)) return 1;
      if (command.includes(lower) || name.includes(lower)) return 2;
      return 3; // description-only match
    };

    return sourceItems
      .map((item, index) => ({ item, index, rank: rank(item) }))
      .filter(
        ({ item, rank: r }) =>
          r < 3 || Boolean(item.skill.content?.toLowerCase().includes(lower)),
      )
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(({ item }) => item);
  }, [completionKind, modelProfileItems, slashItems, filterText]);

  // Keep refs in sync so handleSlashKeyDown always reads the latest values,
  // avoiding stale closures from React's batched state updates.
  const isMenuOpenRef = useRef(isMenuOpen);
  isMenuOpenRef.current = isMenuOpen;
  const filteredItemsRef = useRef(filteredItems);
  filteredItemsRef.current = filteredItems;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  // Reset selected index when the filter text changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filterText]);

  // Track the character range of the current slash word so selectItem can
  // replace only that portion instead of wiping the entire input.
  const slashRangeRef = useRef<{ start: number; end: number } | null>(null);

  // Detect a slash word at the cursor position.
  // Returns the filter text (characters after "/") and the range of the
  // slash word within the full input text, or null if no slash word found.
  const getSlashText = useCallback((): {
    kind: SlashCompletionKind;
    text: string;
    start: number;
    end: number;
  } | null => {
    const element = chatInputRef.current;
    if (!element) return null;

    // Strip trailing newlines that contentEditable can produce, but preserve
    // spaces so "/command " (after selection) won't re-trigger the menu.
    const text = (element.innerText || "").replace(/[\n\r]+$/, "");
    const cursor = getCursorOffset(element);
    if (cursor < 0) return null;

    const textBeforeCursor = text.slice(0, cursor);

    const modelMatch = textBeforeCursor.match(/(^|\s)(\/model(?:\s+\S*)?)$/);
    if (modelMatch) {
      const modelCommand = modelMatch[2];
      const start = textBeforeCursor.length - modelCommand.length;
      const afterCursor = text.slice(cursor);
      const trailing = afterCursor.match(/^\S*/);
      const end = cursor + (trailing ? trailing[0].length : 0);

      return {
        kind: "model-profile",
        text: modelCommand.replace(/^\/model(?:\s+)?/, ""),
        start,
        end,
      };
    }

    // Match a "/" preceded by whitespace or at position 0, followed by
    // non-whitespace characters, ending right at the cursor.
    const match = textBeforeCursor.match(/(^|\s)(\/\S*)$/);
    if (!match) return null;

    const slashWord = match[2]; // e.g. "/hel"
    const start = textBeforeCursor.length - slashWord.length;
    // The end of the slash word extends past the cursor to include any
    // contiguous non-whitespace characters (covers the case where the
    // cursor sits in the middle of a word).
    const afterCursor = text.slice(cursor);
    const trailing = afterCursor.match(/^\S*/);
    const end = cursor + (trailing ? trailing[0].length : 0);

    return { kind: "command", text: slashWord.slice(1), start, end }; // strip leading "/"
  }, [chatInputRef]);

  // Update the menu state based on current input
  const updateSlashMenu = useCallback(() => {
    const result = getSlashText();
    const hasItems =
      result?.kind === "model-profile"
        ? modelProfileItems.length > 0 || isProfilesLoading
        : slashItems.length > 0;

    if (result !== null && hasItems) {
      setCompletionKind(result.kind);
      setFilterText(result.text);
      slashRangeRef.current = { start: result.start, end: result.end };
      setIsMenuOpen(true);
    } else {
      setIsMenuOpen(false);
      setFilterText("");
      setCompletionKind("command");
      slashRangeRef.current = null;
    }
  }, [
    getSlashText,
    isProfilesLoading,
    modelProfileItems.length,
    slashItems.length,
  ]);

  // Select an item and replace only the slash word with the command
  const selectItem = useCallback(
    (item: SlashCommandItem) => {
      const element = chatInputRef.current;
      if (!element) return;

      // ACP commands (Kiro's /compact, /model, /usage, …) are NOT sent as a
      // prompt. Mirroring the Eclipse reference client (which sets
      // skipNextPrompt + clears the input, then calls executeCommand), run the
      // command over the ACP execute RPC, clear the input, and return without
      // substituting text so Enter never forwards "/context" as a message.
      if (item.isAcpCommand && conversationId) {
        executeAcpCommand.mutate({ conversationId, command: item.command });
        element.textContent = "";
        setIsMenuOpen(false);
        setFilterText("");
        setCompletionKind("command");
        setSelectedIndex(0);
        slashRangeRef.current = null;
        element.dispatchEvent(new InputEvent("input", { bubbles: true }));
        element.focus();
        return;
      }

      const slashRange = slashRangeRef.current;
      const currentText = (element.innerText || "").replace(/[\n\r]+$/, "");
      const replacement = `${item.command} `;

      if (slashRange) {
        // Splice the command into the text, replacing only the slash word
        element.textContent =
          currentText.slice(0, slashRange.start) +
          replacement +
          currentText.slice(slashRange.end);

        // Position cursor right after the inserted command + space
        const cursorPos = slashRange.start + replacement.length;
        const textNode = element.firstChild;
        if (textNode) {
          const range = document.createRange();
          const sel = window.getSelection();
          const offset = Math.min(cursorPos, textNode.textContent!.length);
          range.setStart(textNode, offset);
          range.collapse(true);
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      } else {
        // Fallback: replace everything (e.g. if range tracking failed)
        element.textContent = replacement;
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(element);
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }

      setIsMenuOpen(false);
      setFilterText("");
      setCompletionKind("command");
      setSelectedIndex(0);
      slashRangeRef.current = null;

      // Trigger a native InputEvent so React's onInput fires (for smartResize etc.)
      element.dispatchEvent(new InputEvent("input", { bubbles: true }));

      // Restore focus so keyboard events (Enter to submit) work after selection
      element.focus();
    },
    [chatInputRef, conversationId, executeAcpCommand],
  );

  // Handle keyboard navigation in the menu.
  // Uses refs to always read the latest state, avoiding stale closures.
  const handleSlashKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      const items = filteredItemsRef.current;
      if (!isMenuOpenRef.current || items.length === 0) return false;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => (prev < items.length - 1 ? prev + 1 : 0));
          return true;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : items.length - 1));
          return true;
        case "Enter":
        case "Tab": {
          const item = items[selectedIndexRef.current];
          if (!item) return false;
          e.preventDefault();
          selectItem(item);
          return true;
        }
        case "Escape":
          e.preventDefault();
          setIsMenuOpen(false);
          return true;
        // Cursor-movement keys: close the menu to avoid acting on a stale
        // slash-word range, but don't consume the event so the cursor moves.
        case "ArrowLeft":
        case "ArrowRight":
        case "Home":
        case "End":
          setIsMenuOpen(false);
          return false;
        default:
          return false;
      }
    },
    [selectItem],
  );

  const closeMenu = useCallback(() => setIsMenuOpen(false), []);

  return {
    isMenuOpen,
    filteredItems,
    selectedIndex,
    updateSlashMenu,
    selectItem,
    handleSlashKeyDown,
    closeMenu,
  };
};
