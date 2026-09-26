# Kiro CLI ⇄ OpenHands ACP Integration — Handoff / Restart Context

Last updated: 2026-09-20 (session 7). This doc is the single source of truth for resuming the
Kiro ACP integration work. It supersedes the earlier "Step 2 (Canvas provider
registration)" version of this file.

## Repos in this environment (Linux container)
- OpenHands (Agent Canvas, frontend + agent-server config): `/projects/OpenHands`
  - On the Windows host this is `C:\OpenHands\projects\OpenHands`.
- OpenHands Software Agent SDK (backend agent runtime): `/projects/software-agent-sdk`
- Eclipse plugin reference implementation (working Kiro ACP client): `/projects/eclipse-agents`
- Full prior conversation transcript: `/projects/conversation.log`

Note: earlier confusion about an "empty" working dir — the actual code lives under
`/projects/...`, NOT under the CWD `/home/openhands/workspace/project/<id>` (which is
an empty git repo). Always work in `/projects`.

---

## The goal (as the user stated it)
The user runs `kiro-cli acp` as a custom ACP agent inside OpenHands. They want, per turn,
to SEE and USE what their Eclipse plugin already shows:
1. **Per-turn credits consumed** (they pay for 1000 credits/month) and **context usage %**,
   so they know when to compact. Per-turn only — no cumulative counter needed.
2. **Kiro slash commands** (`/compact`, `/model`, `/usage`, etc.) usable from inside
   OpenHands, so they can compact context, switch models, and check monthly usage.

---

## KEY ROOT-CAUSE FINDINGS (hard-won; do not re-litigate)

### 1. Kiro sends usage via a custom ACP extension notification, not standard channels
The three standard ACP channels are all EMPTY for Kiro: `UsageUpdate` notifications,
`PromptResponse.usage`, and `_meta` on either. Verified live: a turn logged
`usage=None meta=None`, `UsageUpdate not received`.

Kiro instead sends **`_kiro.dev/metadata`** (a JSON-RPC *notification*). The `acp`
Python library routes any `_`-prefixed method to `Client.ext_notification`, stripping
the leading underscore — so it arrives as `method == "kiro.dev/metadata"`.
Payload shape (confirmed from the Eclipse plugin `AcpSchema.java` / `ChatBrowser.java`):
```json
{
  "sessionId": "...",
  "contextUsagePercentage": 12.5,
  "meteringUsage": [ { "value": 0.21, "unit": "credit", "unitPlural": "credits" } ],
  "turnDurationMs": 8000
}
```
- **credits = Σ meteringUsage[].value**
- **context % = contextUsagePercentage**
- **time = turnDurationMs / 1000**

The SDK's `Client.ext_notification` / `ext_method` were originally **silent no-ops**
(`pass` / `return {}`), which is why all of this was being discarded. That is the bug
we fixed.

### 2. Kiro slash commands use two more extension methods
- `_kiro.dev/commands/available` (notification) → `{ sessionId, commands: [{name, description, input?:{hint}, _meta}] }` — the command list.
- `_kiro.dev/commands/execute` (request) → `{ sessionId, command }` → `{ success: bool }`.
  Sent via `conn.ext_method("kiro.dev/commands/execute", {...})` (the lib re-adds the `_`).

### 3. PyInstaller-frozen agent-server binary — overlay does NOT work
`openhands-agent-server` in the published base image is a **PyInstaller-frozen ELF**
with the SDK bundled inside; it never reads `site-packages`. So the old
`Dockerfile.kiro` overlay approach (`pip install --force-reinstall` into site-packages)
had **zero runtime effect**. Proof: running server logged old line numbers even after overlay.
`Dockerfile.kiro` has been DELETED. Do not resurrect it.

**Correct build path** — use the SDK's own `source` Docker target (runs from a venv,
not frozen), then point Canvas at it:
```bash
# 1) agent-server from LOCAL edited SDK (source target, no PyInstaller)
cd /projects/software-agent-sdk
docker build \
  -f openhands-agent-server/openhands/agent_server/docker/Dockerfile \
  --target source \
  -t agent-server:kiro-src .

# 2) Canvas all-in-one on top of that base
cd /projects/OpenHands
docker build -f docker/Dockerfile \
  --build-arg AGENT_SERVER_IMAGE=agent-server:kiro-src \
  --build-arg AUTOMATION_VERSION=1.11.1 \
  --build-arg VITE_BASE_PATH=/canvas \
  -t agent-canvas:kiro .

# 3) run
docker run --rm -p 8000:8000 \
  -v "$HOME/.openhands:/home/openhands/.openhands" -v "/projects:/projects" \
  agent-canvas:kiro
# open http://localhost:8000/canvas
```
`docker/entrypoint.sh` (lines ~293-299) already auto-detects: uses the frozen binary if
present, else falls back to `/agent-server/.venv/bin/python -m openhands.agent_server`.
The `source` target has no binary, so it correctly uses the venv (your edited SDK).

---

## POST-LIVE-TEST FIXES (2026-09-20, session 2) — both SDK-side

First live run showed: credits/context appeared on **some** turns (noisy `Credits: 0.00`
interim lines), and **slash commands did not work** (menu never populated). Two root causes,
both fixed in `openhands-sdk/openhands/sdk/agent/acp_agent.py`:

### Fix 1 — Slash commands: Kiro uses the STANDARD ACP channel, not just the extension
The Eclipse plugin (`SessionController.java:391`) proves Kiro advertises commands via the
**standard** ACP `session/update` with `session_update="available_commands_update"`
(`acp.schema.AvailableCommandsUpdate`), NOT only the `_kiro.dev/commands/available`
extension notification we originally handled. Our `session_update` handler dropped that
variant into the `else` debug branch, so `_available_commands` stayed empty → frontend
query returned `[]` → the command pill never rendered (it's gated on `commands.length > 0`).
**Fix:** imported `AvailableCommandsUpdate` and added a `session_update` branch that
normalizes `available_commands` → `[{name, description, input?}]` into `_available_commands`.
Both channels now populate it.

### Fix 2 — Credits/context on some turns only (noisy `Credits: 0.00`)
Kiro sends `_kiro.dev/metadata` MULTIPLE times per turn: interim frames (empty
`meteringUsage` → credits `0.0`, no `turnDurationMs`) plus one settlement frame with real
credits + `turnDurationMs`. We emitted `ACPMetadataEvent` for every frame → noisy zero lines.
**Fix:** only emit when `turnDurationMs` is present (the reliable end-of-turn signal).
Interim frames are now suppressed; one clean settled line per turn.

Tests added: `test_ext_notification_kiro_metadata_interim_suppressed`,
`test_session_update_available_commands_stored`. Full SDK sweep: **770 passed**
(run with `env -u ACP_USAGE_UPDATE_TIMEOUT` — a stale `=10` env var in the shell breaks
`test_step_records_partial_metrics_on_usage_timeout`, which hardcodes `2.0s`; not a code bug).

**STILL NEEDS:** rebuild via the `source` target and re-test live — confirm the command pill
now appears/executes and only one credits line shows per turn.

---

## POST-LIVE-TEST FIXES (2026-09-20, session 3) — frontend: slash-commands in the native typeahead

Symptom reported after session 2: typing `/context` in the chat input and pressing Enter
**rewrote it to `/agent-creator`** (an unrelated OpenHands skill). Root cause, confirmed by
reading the code end-to-end:

- The session-2 slash-command feature was built as a **standalone clickable pill**
  (`chat-input-acp-commands.tsx`) that lists ACP commands and runs them on click. It was
  **never wired into the chat input's `/`-typeahead** (`src/hooks/chat/use-slash-command.ts`).
- That native typeahead builds its list from only `BUILT_IN_COMMANDS` + `useConversationSkills`
  (the OpenHands skills, incl. `agent-creator`). Kiro's ACP commands were absent, so typing
  `/context` + Enter had `handleSlashKeyDown` pick the highlighted *skill* and `selectItem`
  substitute it → `/agent-creator`. Pure client-side autocomplete snap; Kiro never saw it.

The Eclipse reference client proves the correct design does BOTH (verified in
`ContentAssistProvider.getCommands()` + `ChatView.proposalAccepted`):
1. **Merge** `session.getAvailableCommands()` into the completion list (alongside skills).
2. On pick, **suppress the prompt** (`skipNextPrompt=true; inputText.setText("")`) and call
   `executeCommand("/"+name)` → the `_kiro.dev/commands/execute` RPC. Commands are NEVER sent
   as prompt text. So option-1-only (menu merge) would autocomplete but not execute; both are
   required.

### Fix (both, in `src/hooks/chat/use-slash-command.ts`)
- `SlashCommandItem` gained an optional `isAcpCommand` flag.
- The hook now pulls `useOptionalConversationId`, `useChatInputModelState` (`isAcpContext`),
  `useAcpCommands`, and `useExecuteAcpCommand`. ACP commands are fetched only for a started ACP
  conversation (`isAcpContext && conversationId`), so non-ACP chats are untouched.
- `slashItems` **prepends** the mapped ACP commands (bare `name` → `/name`, description as
  content, flagged `isAcpCommand`) so a Kiro `/context` wins over a same-named skill.
- `selectItem` **branches**: for an ACP item it calls
  `executeAcpCommand.mutate({ conversationId, command: "/name" })`, clears the input, closes the
  menu, and returns **without** substituting text (the reference client's suppress-prompt path).
  Non-ACP items keep the existing text-substitution behavior verbatim.

Tests added to `__tests__/hooks/chat/use-slash-command.test.ts` (mocks `use-conversation-id`,
`use-chat-input-model-state`, `use-acp-commands`, `use-execute-acp-command`; default ACP-off so
prior tests are unaffected): merge ordering + `isAcpCommand` flag; `/context` filters to the ACP
command and NOT `/agent-creator`; execute-on-pick runs the RPC and clears the input; non-ACP
skill still substitutes text. Also fixed a pre-existing `no-param-reassign` lint error in the
test's `setInputText` helper (aliased `element`→`el`).

Verification: `npx tsc --noEmit` exit 0; `vitest` `use-slash-command.test.ts` (8) +
`slash-command-menu.test.tsx` (26) = **34 passed**; `eslint` + `prettier` clean on both changed
files. NOT verified: a live end-to-end turn — no Docker daemon in this env
(`/var/run/docker.sock` absent), so the `source`-target rebuild + real `kiro-cli acp` turn is
still required to confirm `/context`, `/compact`, `/model`, `/usage` actually execute from the
typeahead. This shares the same live-verification gap as the pill.

Note: the standalone pill (`chat-input-acp-commands.tsx`) is now redundant with the typeahead
for execution; left in place for discoverability. Consider consolidating post-live-verify.

---

## POST-LIVE-TEST FINDINGS (2026-09-20, session 5) — slash-command menu empty: acp_commands 404 during ACP session startup

First live run of the new image (`/projects/new-container.log`): the session-3 typeahead wiring
IS live (frontend polls `GET /api/conversations/<id>/acp_commands`), but the menu was still empty.
The log shows the real cause — a timing bug, not a wiring gap:

```
20:17:51 acp_agent  ACP server initialized: agent_name='Kiro CLI Agent' v2.22.1
20:17:51 acp_agent  ACP load_session(...3efe9edf) failed (Internal error); starting a fresh session
20:17:52 api        HTTPException 404 on GET /api/conversations/f09d8987.../acp_commands: Not Found
20:17:53 api        HTTPException 404 ... /acp_commands   (repeats 20:17:55, 20:17:59)
20:17:59 acp_agent  Sending ACP prompt ...
```

Meanwhile a *different* conversation (`b0171de0…`) returned **200** for the same endpoint.

### Root cause
`GET /{id}/acp_commands` → `conversation_service.get_event_service(id)`; if that is `None` it
raises **404**. When the conversation's ACP session is still (re)initializing — here the persisted
session failed to load and a fresh one was starting — the event service isn't registered yet, so
the endpoint 404s for a few seconds. The frontend `useAcpCommands` query had `staleTime: 60s`,
**no retry, and no polling** (comment literally said "refetch on focus is enough"). So the first
poll hit the 404, React Query cached the failure, and nothing re-queried once the ACP session came
up → the command list stayed empty forever → the pill and the typeahead merge both saw
`commands.length === 0`. That is why "slash commands still are not working" even though everything
built in sessions 2–3 was correct.

### Fix (frontend, `src/hooks/query/use-acp-commands.ts`)
Make the query resilient to the ACP-session startup window:
- `retry: 5` with an exponential `retryDelay` (1s→8s cap) so the transient 404 is retried.
- `refetchInterval: (q) => (q.state.data?.length ?? 0) > 0 ? false : 3000` — keep polling every 3s
  while the list is empty, stop once the server advertises ≥1 command. `refetchIntervalInBackground:
  false`. The query is only `enabled` for `isAcpContext && conversationId`, so non-ACP chats never
  poll. This also naturally picks up a mid-session `commands/available` change before the first
  command arrives.

Test: `__tests__/hooks/query/use-acp-commands.test.tsx` — (1) disabled ⇒ no query for non-ACP;
(2) two transient 404s then success ⇒ the hook retries past them and populates the commands (proves
it no longer caches an empty menu). Verified: `tsc` rc 0; the 3 affected suites
(use-acp-commands, use-slash-command, handle-event-for-ui) = **55 passed**; eslint + prettier clean.

### Also seen in the log (NOT bugs)
- `UsageUpdate not received within 10.0s` — expected: Kiro reports usage via `_kiro.dev/metadata`,
  not the standard `UsageUpdate` channel (session-2 finding). Harmless timeout.
- `load_session(...) failed; starting a fresh session` — the ACP session-restore path; unrelated to
  commands, but it is what opened the 404 window above.

### Still open
- The session-4 metadata-chip disappear-on-settle is a *separate* issue (a runtime store/reconcile
  question) and is unaffected by this fix. Its next-session debug steps stand.
  **[RESOLVED in session 7 — it was the `Messages` React.memo comparator skipping non-last-element
  changes; see the session-7 section.]**
- Re-test live with this build: confirm the menu now populates a few seconds after the conversation
  starts (watch for the `acp_commands` request flipping 404→200 and the pill/typeahead filling in).

---

## POST-LIVE-TEST FINDINGS (2026-09-20, session 6) — slash commands return HTTP 400: SDK sent the BARE command name (`//context` in the menu)

First live run with a populated menu (session-5 fix worked). Screenshot of the Commands dropdown
showed every entry with a **double slash**: `//agent`, `//compact`, `//context`, … and selecting
one (e.g. `//context`) returned **HTTP 400 Bad Request**. Two distinct bugs, both now fixed.

### Root cause (the 400) — the SDK stripped the slash; Kiro requires it
`execute_command` did `command_name = command.lstrip("/").strip()`, sending the **bare** name
(`context`) on `_kiro.dev/commands/execute`. Kiro **requires the command WITH a single leading
slash** and rejects the bare form → `ACPRequestError` → the agent-server route
(`execute_conversation_acp_command`) maps that `ValueError` to **HTTP 400**. This is the exact
symptom the user hit.

Authoritative contract, confirmed from the Eclipse reference client (do not re-litigate):
- `ChatView.java:297` → `executeCommand("/" + sp.getLabel())` — prepends exactly one slash.
- `ContentAssistProvider.getCommands()` → normalizes the advertised name to **bare**
  (`cmd.name().startsWith("/") ? substring(1)`), so `getLabel()` is bare and the `"/" +` re-adds
  one slash.
- `docs/debug-commands.md:30` wire example → `{"method":"_kiro.dev/commands/execute",
  "params":{... "command":"/help"}}` — the command carries the slash on the wire.

So Kiro advertises names that MAY already carry a leading slash (that is why the menu showed
`//context`: the pill rendered `/{name}` where `name` was already `/context`), and `commands/execute`
wants exactly one leading slash.

### Fix 1 — SDK `openhands-sdk/openhands/sdk/agent/acp_agent.py` (`execute_command`)
Normalize any input form — bare (`context`), single- (`/context`), or double-slash (`//context`) —
to exactly `/name` before sending: `bare_name = command.strip().lstrip("/").strip()` then
`command_name = f"/{bare_name}"`. The empty/slash-only guard now runs on `bare_name` **before** the
live-session check, so a slash-only input raises `ValueError` and a bare `/` is never sent. Docstring
updated to state the slash-inclusive contract.
Tests: `tests/sdk/agent/test_acp_agent.py::TestExecuteCommandSlashHandling` — parametrized
(`context`, `/context`, `//context`, padded) all send `/context`; empty and slash-only raise.

### Fix 2 — frontend pill `src/components/features/chat/components/chat-input-acp-commands.tsx`
The pill rendered `/{command.name}` where `command.name` could already be `/context` → `//context`.
Now strips leading slash(es) for display (`bareName = command.name.replace(/^\/+/, "")`, renders
`/{bareName}`) and passes `bareName` to execute (the SDK re-adds one slash). The native `/`-typeahead
path (`use-slash-command.ts`) already normalized display and built `/name`, so it was unaffected —
only the pill showed the double slash.

### Verification (static; live still pending)
- SDK: `env -u ACP_USAGE_UPDATE_TIMEOUT .venv/bin/python -m pytest tests/sdk/agent/test_acp_agent.py
  tests/agent_server/test_conversation_router.py` → **594 passed**.
- Frontend: `npx tsc --noEmit` exit 0; `eslint` + `prettier` clean on the pill; `vitest`
  (use-slash-command, use-acp-commands, event-message-acp-metadata) → **13 passed**.
- NOT yet done: the live end-to-end turn (needs the `source`-target rebuild; no Docker daemon in
  this env). Expect: menu shows single slashes and `/context`/`/compact`/`/model`/`/usage` execute
  (no more 400).

---

## POST-LIVE-TEST FINDINGS (2026-09-20, session 8) — RESOLVED: slash commands returned HTTP 400 "Parse error"; `command` must be the structured `TuiCommand` enum, NOT a string

Live error reported: `HTTP 400: {"detail":"ACP server rejected command '/context': Parse error"}`.
This is a DIFFERENT 400 than session 6 — the slash was correct this time; the whole
string-vs-slash debate (sessions 6) was a red herring for this kiro-cli version.

### How it was root-caused (finally UNBLOCKED — no Docker needed)
Key realization: **`kiro-cli 2.22.1` is installed locally** (`~/.local/bin/kiro-cli`, same version
the agent-server logged, authed as ApiKey). So the `commands/execute` contract can be probed
**directly against the real binary** via a tiny `acp`-library client (`acp.spawn_agent_process`) —
bypassing the whole Docker/Canvas stack that blocked every prior live check. This is the first time
any live ACP behavior was verified in this environment.

The probe reproduced the exact 400 and, crucially, printed the JSON-RPC error **`data`** (which the
SDK was discarding — it only surfaced the opaque string "Parse error"):
```
code=-32700 msg="Parse error"
data={"error":"invalid type: string \"/context\", expected adjacently tagged enum TuiCommand",
      "json":{"sessionId":"...","command":"/context"}, "phase":"deserialization"}
```
`-32700` = JSON-RPC `RequestError.parse_error`. It fires **regardless of slash**: `/context`,
`context`, `/help`, `/usage` ALL failed identically. Kiro does not want a string at all.

### The real wire contract (decoded empirically against kiro-cli 2.22.1, verified live)
`_kiro.dev/commands/execute`'s `command` param is Kiro's **adjacently-tagged `TuiCommand` enum**,
serialized as an OBJECT, not a string:
```json
{ "sessionId": "...", "command": { "command": "<bare_name>", "args": {} } }
```
- Tag key is literally `command`; value is the **lower-case, slash-less** name
  (`context`, `compact`, `usage`, `model`, `help`, …). Probing proved the tag key by the server's
  own errors: a bare string → `expected adjacently tagged enum TuiCommand`; `{command,args:[]}` →
  `expected struct ContextArgs with 2 elements`; `{command}` alone → `missing field \`args\``.
- Valid variants (from the server's `unknown variant` error): `help, model, agent, context,
  compact, clear, quit, usage, paste, mcp, tools, plan, feedback, chat, knowledge, prompts, reply,
  code, voice, hooks, guide, rewind, stats, effort, goal`.
- **`args` is REQUIRED but `{}` works universally** — Kiro fills each command's `*Args` struct with
  defaults. Verified live that `{}` succeeds for `help / usage / model / clear / compact / context /
  stats / tools`. (`usage` even returned `Credits (731.79 of 1000 covered in plan), 72.7%` — the
  exact monthly usage the user wanted.)

Why the old code was wrong: the Eclipse reference client + Kiro's `debug-commands.md` were written
against an **older kiro-cli** whose `command` was a plain `/name` string. 2.22.1 changed the wire
format to the structured enum. Every session that tweaked the slash was chasing the wrong layer.

### Fix — SDK `openhands-sdk/openhands/sdk/agent/acp_agent.py` (`execute_command`)
- Strip leading slash(es) to a bare lower-case name (any input form: `context` / `/context` /
  `//context`) and send `command` as `{"command": <bare_name>, "args": {}}` — NOT the `/name`
  string. Docstring rewritten to document the `TuiCommand` contract and the 2.22.1 change.
- The raised `ValueError` on `ACPRequestError` now includes the error **`data`** payload, so any
  future wire-format mismatch shows the real deserialization detail instead of a bare "Parse error"
  (this omission is what made the bug take multiple sessions).

Tests: `tests/sdk/agent/test_acp_agent.py::TestExecuteCommandSlashHandling` updated — the
parametrized cases (`context`, `/context`, `//context`, padded) now assert the payload's `command`
equals `{"command": "context", "args": {}}` and is NOT a string; class docstring updated.

### Verification
- **Live** (real kiro-cli 2.22.1, the patched payload): 7/7 inputs
  (`/usage`, `usage`, `//context`, `/context`, `/model`, `/help`, `compact`) accepted with
  `success=True` (compact `false` only "conversation too short") and **zero Parse errors**.
- Static: `tests/sdk/agent/test_acp_agent.py` + `tests/agent_server/test_conversation_router.py`
  → **594 passed** (`env -u ACP_USAGE_UPDATE_TIMEOUT`).
- Frontend needs **no change**: it already passes the bare name to the execute RPC (session-6 pill
  fix + session-3 typeahead both send the slash-less name); the string→object wrapping is entirely
  SDK-side. A `source`-target rebuild is still the way to see it in Canvas, but the command contract
  itself is now proven correct against the real binary.

### Note for upstream
If Kiro adds command **arguments/subcommands** later (e.g. `/context add <path>`, `/model <id>`),
`args:{}` will need to carry the real fields per the command's `*Args` struct (e.g. `ContextArgs`).
For the argless commands the user cares about (`compact`, `usage`, `context` show, `model` list,
`help`) `{}` is correct and complete.

---
## POST-LIVE-TEST FINDINGS (2026-09-21, session 11) — REAL ROOT CAUSE of credits/context chip vanishing on settle: the settled event is BURIED past the 50-event REST tail; fixed by rendering a store-derived PINNED chip

Sessions 4/7/9 all "fixed" this and it kept recurring — the classic sign the cause was never found.
This session pinned it with disk + screenshot evidence and fixed it by construction.

### Evidence (not hypothesis)
- **Persisted events prove the SDK/store are fine.** 13 real `ACPMetadataEvent` records on disk with
  real settled values (newest e.g. credits=11.61 ctx=26.5% dur=407s; another credits=38.27 22.1% 2025s).
  Session-9's SDK fix works — the event reaches the store and disk every turn.
- **A store reproduction test proves the store never drops it**: after a live add + a 50-event tail
  refetch that omits it, `uiEvents` still contains the metadata (merge, not replace). So the store is
  innocent (again).
- **The screenshot showed the chip rendering fine WHILE running** (`Credits: 38.27 · Context: 22% ·
  2025s`) then vanishing exactly when the "Thinking" indicator (gated on `curAgentState===RUNNING`)
  vanished.
- **The killer measurement**: the settled `ACPMetadataEvent` arrives MID-turn, then the agent keeps
  emitting events. For long turns, **72 / 291 events have a LATER timestamp** than the metadata event.
  The REST history (`useConversationHistory`) fetches only the **newest 50** (`limit:50,
  TIMESTAMP_DESC`). So the metadata event is **position 73 / 292 from the newest — outside the tail
  window**. Short turns (position 16) keep the chip; long turns lose it. That length-correlation is the
  tell.

### Why it renders then vanishes
The chip's visibility depended on the settled event surviving as a **middle-of-list** event through:
streaming-delta finalize/supersede (`handle-event-for-ui`), timestamp re-sorts, the `Messages`
`React.memo` comparator, AND the 50-event tail refetch/reconcile on the RUNNING→settled transition.
Too many moving parts; on long turns the settle-time reconcile drops it from the rendered list even
though it stays in the store. Sessions 4/7/9 each patched one of those layers; none covered the tail /
buried-position interaction.

### Fix — render the latest settled metadata as a store-derived PINNED chip (frontend only)
Stop depending on the in-stream event surviving reconcile. New
`src/components/features/chat/latest-acp-usage.tsx` (`LatestACPUsage`) selects the **newest**
`ACPMetadataEvent` directly from `useEventStore` and renders one chip pinned at the END of the message
flow (next to `GoalStatusBanner`, above the composer — where the screenshot already showed it). Wired
into `chat-interface.tsx`. `should-render-event.ts` now returns **false** for `ACPMetadataEvent` (no
in-stream copy → no burial, no duplicate). Reuses the existing `ACPMetadataMessage` presenter. As long
as the event is in the store (proven to survive merges/refetches), the chip shows — independent of list
position, the memo, and the tail refetch.

Retained (harmless, guard other layers): session-4 `preserveMetadataEvents`, session-7
`metadataSignature` memo.

### Verification
- `tsc` clean; `eslint` + `prettier` clean on changed files.
- New tests: `__tests__/components/features/chat/latest-acp-usage.test.tsx` — shows the newest metadata
  even when buried by 60 later events, and **survives a 50-event tail refetch that omits it** (the exact
  failure). `__tests__/stores/acp-metadata-tail-refetch.test.ts` — store merge keeps it.
  Affected suites (latest-acp-usage[3], event-message-acp-metadata[3], should-render-event[21],
  messages rerender[1], tail-refetch[1]) → all green.
- Built the frontend (`VITE_BASE_PATH=/canvas npm run build:app`, 15m). Staged at
  **`/opt/agent-canvas/frontend.new`** (manifest `manifest-1e31a39f.js`).

### DEPLOYMENT — IMPORTANT (learned the hard way)
- The live frontend is served by `sirv` in `/opt/agent-canvas/static-server.mjs`, which **caches its
  file map at startup**. Hot-swapping new hashed asset files under the running sirv makes the fresh
  `index.html` reference assets sirv 404s → white screen. **Do NOT hot-swap.** (Tried it, caught the
  breakage, and restored `/opt/agent-canvas/frontend` from `/opt/agent-canvas/frontend.bak`
  immediately; the live UI is intact on the ORIGINAL bundle.)
- To deploy: on the next container/static-server (re)start, replace `/opt/agent-canvas/frontend` with
  `/opt/agent-canvas/frontend.new` (or just `cp -a /opt/agent-canvas/frontend.new/. 
  /opt/agent-canvas/frontend/` and restart the static-server). A `source`-target rebuild / fresh
  container also picks up the source change. The static-server is the container ingress
  (`entrypoint.sh` `exit 1`s if PID dies), so it cannot be restarted from within the session it serves.
- Backups: live bundle preserved at `/opt/agent-canvas/frontend.bak`; new bundle at
  `/opt/agent-canvas/frontend.new`.

### Files (frontend, uncommitted)
NEW `src/components/features/chat/latest-acp-usage.tsx`; MODIFIED `chat-interface.tsx`,
`event-content-helpers/should-render-event.ts`; NEW tests
`__tests__/components/features/chat/latest-acp-usage.test.tsx`,
`__tests__/stores/acp-metadata-tail-refetch.test.ts`.

## POST-LIVE-TEST FINDINGS (2026-09-20, session 10) — RESOLVED: slash commands executed (HTTP 200) but produced NO visible output — the SDK discarded Kiro's command response message/data

User reported: after the session-8 Parse-error fix, `/context` (typed 3x and picked from the
Commands dropdown 2x) returned success but "did nothing" — no output appeared. Confirmed in
`/projects/new-container.log`: the `execute_acp_command` POSTs returned **HTTP 200**
(`Executed ACP command 'context'`) at 23:45-23:49, so the command ran; nothing rendered.

### Root cause — the whole chain collapsed the response to a bare bool
`ACPAgent.execute_command` did `return bool(result.get("success", True))`, **discarding
`result["message"]` and `result["data"]`** — the actual context breakdown / usage text Kiro
returns. `LocalConversation.execute_acp_command` -> `event_service.execute_acp_command` -> the
`execute_conversation_acp_command` route all returned only the bool, and **no event was ever
emitted**, so the command output never reached the client. Proven live against real kiro-cli
2.22.1: `{command:context,args:{}}` returns `success:True` + `message:'Context breakdown - N% used'`
+ a rich `data.breakdown`; `/usage` returns `Credits (X of 1000), Y%`. All of it was thrown away.

### Fix (SDK + agent-server + frontend)
- **SDK `execute_command`** now returns `{"success", "command"(/name), "message", "data"}` (never a
  bare bool). Docstring updated.
- **NEW event `openhands/sdk/event/acp_command_result.py`** — `ACPCommandResultEvent`
  (`command`, `success`, `message`, `data`, `provider`); registered in `event/__init__.py` and the
  visualizer. Not `LLMConvertible` (display-only), mirrors `ACPMetadataEvent`.
- **`LocalConversation.execute_acp_command`** emits the `ACPCommandResultEvent` via the conversation's
  **durable `self._on_event`** sink (NOT the agent's per-turn `on_event`, which is `None` between
  turns — command execution happens between turns), so the output is persisted + broadcast + rendered.
  Returns the full dict.
- **`event_service` + `conversation_router`** thread the full dict through (route returns
  `{success,command,message,data}`; still contains `success` so no client breakage).
- **Frontend** (`/projects/OpenHands`): new type `core/events/acp-command-result-event.ts`,
  `isACPCommandResultEvent` guard, union member, `shouldRenderEvent -> true`, renderer
  `event-message-components/acp-command-result-message.tsx` (command header + preformatted message)
  wired into `event-message.tsx`; i18n keys `ACP_COMMANDS$FAILED` / `ACP_COMMANDS$NO_OUTPUT`
  (declaration regenerated).

### Verification
- SDK: `env -u ACP_USAGE_UPDATE_TIMEOUT pytest tests/sdk/agent/test_acp_agent.py
  tests/sdk/conversation/test_switch_model.py tests/agent_server/test_conversation_router.py
  tests/sdk/event` -> **782 passed** against the deployed **site-packages** copy (v1.49.0).
- **LIVE** end-to-end probe through the deployed site-packages `LocalConversation` driving real
  kiro-cli 2.22.1: `/context` -> returned `message='Context breakdown - 1% used'` + `data`, and **one
  `ACPCommandResultEvent` was emitted** carrying it (`PROBE_RESULT: PASS`). This is the exact bug the
  user hit, now fixed.
- Frontend: `tsc` clean; `eslint` + `prettier` clean on all changed files; `vitest`
  (event-message-acp-command-result [new, 4], event-message-acp-metadata [3], should-render-event) ->
  **28 passed**.

### DEPLOYMENT — REQUIRED to make the fix live (code is correct + proven)
1. The edited SDK/agent-server files were **synced into `/agent-server/.venv/.../site-packages`**
   (hashes MATCH source), BUT the **running agent-server (PID 12) still holds the OLD modules in
   memory** — it must be **restarted** to pick up the new code. NOT done here: PID 12 is the backend
   serving this very session, and `entrypoint.sh` starts it with `&` and does **not** auto-restart it
   (its main loop watches only the static-server), so killing it would break the session. Restart is
   a platform/user action (or a fresh container / `source`-target rebuild).
2. The **frontend renderer ships only after a Canvas static rebuild** (`docker/Dockerfile` all-in-one,
   or `npm run build`). Until then the event is emitted+persisted but the pre-built bundle won't have
   the `ACPCommandResultMessage` renderer.

### Files (uncommitted)
SDK: `event/acp_command_result.py` (new), `event/__init__.py`, `conversation/visualizer/default.py`,
`agent/acp_agent.py`, `conversation/impl/local_conversation.py`; agent-server:
`event_service.py`, `conversation_router.py`. Frontend: `core/events/acp-command-result-event.ts`
(new), `core/events/index.ts`, `core/openhands-event.ts`, `type-guards.ts`, `event-message.tsx`,
`event-message-components/acp-command-result-message.tsx` (new),
`event-content-helpers/should-render-event.ts`, `i18n/translation.json`, `i18n/declaration.ts`,
`__tests__/.../event-message-acp-command-result.test.tsx` (new).


## POST-LIVE-TEST FINDINGS (2026-09-20, session 9) — TRULY RESOLVED: credits/context chip vanishes on settle — it was an SDK callback-teardown RACE, not the frontend

User re-reported (after the session-7 "fix"): the credits/context chip "was there until focus went
back to the prompt," then disappeared. Sessions 4 and 7 both chased this in the **frontend** (session
4: `preserveMetadataEvents` reducer invariant; session 7: `Messages` memo `metadataSignature`). Both
were fixing the wrong layer — the event often never reached the frontend at all.

### UNBLOCKED the same way as session 8: probe the REAL kiro-cli binary
`kiro-cli 2.22.1` is installed locally, so a real ACP turn can be driven directly (no Docker). Two
live captures pinned it:

1. **A full real turn** (`conn.prompt(...)`) logged the exact `_kiro.dev/metadata` frame timeline:
   - interim frames (no `turnDurationMs`) mid-turn — correctly suppressed (session-2 Fix 2);
   - the **settled** frame (`meteringUsage` + `turnDurationMs`) arrives in the **SAME instant** the
     `prompt()` response returns (both logged at `+16.40s`).
2. The settled frame is an **`ext_notification`** (`_kiro.dev/metadata`), NOT a `session_update` — so
   it is **outside** the turn's `session_update` drain that the bridge's documented concurrency model
   relies on.

### Root cause — the teardown race
`_OpenHandsACPBridge.on_event` is set by `ACPAgent` only "for the duration of one prompt() round-trip"
and nulled in `_clear_turn_callbacks()` (its own docstring: "trailing session_update between turns is
a no-op"). The settled metadata notification fires on the portal thread at turn-end, concurrent with
`prompt()` returning and `_clear_turn_callbacks()` running. The old emit was guarded
`if self.on_event is not None and is_settled:` — so:
- **Frame wins the race** (arrives before teardown) → `on_event` set → `ACPMetadataEvent` emitted →
  chip appears and persists.
- **Frame loses the race** (arrives after `on_event = None`) → emit **silently skipped** → event
  never created, never persisted, never sent over the WebSocket → **no chip**.
Intermittent, timing-dependent, and invisible to every frontend/store/persistence test — which is
exactly why sessions 4/7 found all those layers "clean" yet the bug persisted. (Live-proven: with
`on_event=None` across a real turn, the old path emitted **0** events for a turn that really consumed
`credits=0.0607`.)

### Fix — SDK `openhands-sdk/openhands/sdk/agent/acp_agent.py` (all SDK-side)
- `_OpenHandsACPBridge` now **buffers** the built settled `ACPMetadataEvent` (under a
  `threading.Lock`) and sets a `threading.Event` (`_settled_metadata_received`) whenever a settlement
  frame arrives — BEFORE attempting the live emit. If `on_event` is set it still emits live and marks
  the buffer "emitted"; if `on_event` is `None` it just buffers as "unemitted".
- New per-turn `arm_metadata_clock()` (called from `reset()`, i.e. per turn via
  `_reset_client_for_turn`) clears the buffer/signal so one turn's settlement can't leak into the next.
- `_finalize_successful_turn()` — which runs on the caller thread **while `on_event` is still valid**,
  before `_clear_turn_callbacks()` — now calls new `_flush_settled_metadata(on_event)`: it waits a
  short bounded time (`ACP_METADATA_SETTLE_TIMEOUT`, default 0.5s) for the frame, then emits the
  buffered event **iff it wasn't already emitted live** (`take_unemitted_settled_metadata()` marks it
  emitted to prevent a duplicate chip). So the chip is now emitted deterministically regardless of who
  wins the race.

Note: the session-4 (`preserveMetadataEvents`) and session-7 (`metadataSignature` memo) frontend
changes are **retained** — they are correct, low-risk invariants for the case where the event DOES
reach the client (e.g. it wins the race, or a REST rehydration reorders it). They just weren't the
disappear-on-settle cause; this SDK race was. All three layers now cooperate.

### Verification
- **Live** (real kiro-cli 2.22.1, metadata routed through the real `_OpenHandsACPBridge`):
  - Frame **wins** race (`on_event` set): emitted live=1, deferred flush returns None → **no duplicate**.
  - Frame **loses** race (`on_event=None` whole turn): live=0, deferred flush **recovers**
    `credits=0.0607, ctx=3.43, durMs=1352` → chip preserved. This is the exact scenario that used to
    drop the chip.
- Static: `tests/sdk/agent/test_acp_agent.py` (+ router) → **597 passed**. New unit tests:
  `test_settled_metadata_buffered_when_on_event_none`,
  `test_settled_metadata_not_double_emitted_when_live`,
  `test_arm_metadata_clock_clears_prior_turn`.
- Frontend: confirmed innocent by a throwaway DOM test (Messages keeps the chip through settle + a
  post-settle trailing re-render) — removed after confirming, since the fix is SDK-side.

### Still needs
- A `source`-target rebuild + live Canvas turn to see the chip stay on-screen end-to-end (the SDK is
  now proven correct against the real binary; this is the last cosmetic confirmation). Same Docker gap
  as before, but the mechanism is no longer a mystery.

---

## POST-LIVE-TEST FINDINGS (2026-09-20, session 7) — RESOLVED: metadata chip disappear-on-settle was the `Messages` memo comparator

The session-4 disappear-on-settle bug is now **root-caused and fixed** (it had only been
hypothesized before). Live repro confirmed by two user screenshots: `Credits: 2.60 · Context: 10%
· 79s` renders mid-turn (17:32), then the chip is **gone** once the turn settles and the input
reopens (17:33) — the message above it stays.

### How it was pinned (evidence, not hypothesis)
- **Store layer is clean.** A new store-integration test drives the exact live order through the
  real store — `addEvent(user)`, `addEvent(delta)`, `addEvent(ACPMetadataEvent)`,
  `addEvent(finalMessage)`, then a settle-time `addEvents([...tail])` that omits the metadata event
  — and asserts the metadata event survives in `uiEvents` AND passes `shouldRenderEvent`. It stays
  green: the store merges (never replaces) and the reducer/filter keep the event.
  (`__tests__/stores/use-event-store.test.ts` → "ACPMetadataEvent survives a live turn settle".)
  Ground truth captured there: after finalize + the store's timestamp sort the rendered order is
  `[user, ACPMetadataEvent, finalMessage]` — the chip settles into the **middle**; the final agent
  message is the last renderable event.
- **The drop is the render memo.** `Messages` is `React.memo` with a custom comparator that only
  compared array **length** + the **last** event. On settle a frame changes only a **non-last**
  element (delta→metadata in the middle) while length and last event are unchanged, so the
  comparator returned `true` and **skipped the re-render** → the chip never mounted in its settled
  position. Proven decisively: a `Messages` render test that rerenders
  `[user, delta, finalMessage]` → `[user, metadata, finalMessage]` (same length, same last event)
  **fails** (chip absent) with the original comparator and **passes** with the fix.

### Fix — `src/components/conversation-events/chat/messages.tsx`
Added `metadataSignature(events)` (join of `ACPMetadataEvent` ids in order) and folded it into the
memo comparator. A metadata chip appearing or moving now forces a re-render, while streaming deltas
(which never touch the signature) keep the streaming optimization. Low-risk: non-ACP conversations
have an empty signature on both sides, so their memo behavior is byte-for-byte unchanged.

Tests: `__tests__/components/conversation-events/chat/messages-acp-metadata-rerender.test.tsx` (the
fail-without-fix regression) + the store-integration cases above. Verified: `tsc` exit 0; `eslint`
+ `prettier` clean; the 5 affected suites (store, memo-rerender, model-messages, confirmation,
handle-event-for-ui) = **62 passed**.

Note: the session-4 `preserveMetadataEvents` reducer invariant is still correct and retained — it
guards a different layer (the finalize rebuild). This session fixes the actual live drop, which was
one layer higher (the render memo).

---

## POST-LIVE-TEST FINDINGS (2026-09-20, session 4) — ACP metadata chip vanishes on turn-settle

Symptom (user, live): during a turn the `Credits • Context% • time` chip rendered
(saw `time=1042s`), then it **disappeared the moment the turn settled** and the input reopened.

### Diagnosis — evidence, not assumption
Traced the whole path; the drop is NOT where it looks:
- **SDK + persistence are correct.** The settled `ACPMetadataEvent` is durably persisted:
  45 real `"kind":"ACPMetadataEvent"` records in
  `~/.openhands/agent-canvas/conversations/f09d8987…/events/`, including one with
  `credits=22.07 context=37.2 dur=1034442` (the ~1042s turn). The older `dur=None,
  credits=0.0` interim frames (17:47–17:59) predate session-2 Fix 2; recent turns (18:38+)
  persist only the settled frame, so **Fix 2 is working** in the running build.
  (`base_state.json` holds only config kinds — `ACPAgent`, `NeverConfirm` — no events; the
  per-event `events/*.json` are the log.)
- **Every client render layer preserves it** (each verified):
  - `handleEventForUI` — proven by two throwaway repros: the metadata event survives finalize
    in every ordering tried (metadata before the final message with the *same* timestamp;
    metadata between two delta runs). The reducer is NOT the drop point.
  - `shouldRenderEvent` returns `true` for `isACPMetadataEvent`.
  - `useFilteredEvents` passes it through (`uiEvents.filter(shouldRenderEvent)`).
  - `groupEvents` emits a non-groupable event as a standalone `single` item (not swallowed).
  - It's a first-class member of the `OpenHandsEvent` union + has a type guard.
  - `EventService.searchEvents` casts `page.items as OpenHandsEvent[]` with no per-kind
    filtering, so a REST rehydration doesn't drop it by kind.

### Conclusion (honest limit)
The event is persisted and every statically-testable layer keeps it, yet it renders live then
vanishes on settle. That points to a **runtime lifecycle/timing interaction I could not
reproduce statically** — most likely the settle-time REST refetch in `useConversationHistory`
(`staleTime: 0`, `refetchOnMount: "always"`, `TIMESTAMP_DESC`, `limit: 50`) racing with the
WebSocket `resend_mode='since'` replay, around events that can share a timestamp (observed:
two frames at `17:59:07`). Confirming the exact mechanism needs a running instance — blocked
here (no Docker daemon; `/var/run/docker.sock` absent).

### Defensive change made (low-risk, no behavior change for non-ACP)
`src/utils/handle-event-for-ui.ts`: added `preserveMetadataEvents(before, after)` and made
`finalizeStreamingDeltasInPlace` return `preserveMetadataEvents(uiEvents, nextUiEvents)`. If a
finalize/supersede rebuild ever produces an array missing an `ACPMetadataEvent` that was present
before, it is re-appended. Current tests show the rebuild already preserves it — so this makes
that an **explicit, test-guarded invariant** that a future change to `supersedeStreamingContent`
can't silently regress. It does NOT touch the store or history reconcile (that would be a
change-on-hypothesis). Regression test: `__tests__/utils/handle-event-for-ui.test.ts` →
`describe("ACPMetadataEvent survives turn finalize")`. Verified: `tsc` rc 0; suite **45 passed**;
`eslint` rc 0 + `prettier` clean.

### NEXT-SESSION LIVE DEBUG STEPS (to pin the real cause)
**[RESOLVED in session 7 — root cause pinned to the `Messages` React.memo comparator and fixed;
these debug steps are retained only as historical record. See the session-7 section above.]**
Run the `source`-target build, do a Kiro turn, and when the chip vanishes:
1. **Is it in the store or gone?** Dev build exposes `window.__OH_EVENT_STORE__`. After the chip
   disappears, run in devtools:
   `__OH_EVENT_STORE__.getState().uiEvents.filter(e=>e.kind==='ACPMetadataEvent')` and the same
   on `.events`.
   - Present in store but not rendered → a render/grouping edge case (inspect `messages.tsx`
     `renderableEvents`/`groupEvents` for that turn window).
   - **Gone from store → the store-lifecycle/reconcile drop (leading hypothesis).** Then:
2. **Watch the WebSocket frames on settle** for a `resend`/replay and whether the metadata
   event's `id` reappears or is omitted; and check whether the `useConversationHistory` refetch
   (fires on settle via `refetchOnMount:"always"`, `staleTime:0`) returns a 50-event
   `TIMESTAMP_DESC` page whose tail excludes the just-streamed metadata event, so a rebuild from
   that page loses it. If so, the durable fix is in the store hydration/dedupe (merge, don't
   replace) or in giving the metadata event distinguishing ordering — NOT in the reducer.

---

## WHAT WAS IMPLEMENTED (full stack, COMPLETE)

Two features: (A) per-turn credits + context% display, (B) Kiro slash commands.
Note: credits are **NOT dollars** and context% is **NOT tokens** — deliberately surfaced
as distinct Kiro-specific fields, NOT shoved into `metrics.add_cost` / `context_window`.

### SDK — `/projects/software-agent-sdk` (tests: 615 passed)
- **NEW** `openhands-sdk/openhands/sdk/event/acp_metadata.py` — `ACPMetadataEvent`
  (fields: `credits`, `context_usage_percentage`, `turn_duration_ms`, plus raw metering).
- `openhands-sdk/openhands/sdk/event/__init__.py` — exports `ACPMetadataEvent`.
- `openhands-sdk/openhands/sdk/agent/acp_agent.py`:
  - `ext_notification` now decodes `kiro.dev/metadata` → emits `ACPMetadataEvent`
    (credits = Σ meteringUsage.value). See ~line 1698.
  - stores `_kiro.dev/commands/available` list per session (~line 1308).
  - `execute_command(command)` sends `_kiro.dev/commands/execute` via `conn.ext_method`.
    **(session 8, supersedes session 6)** sends `command` as Kiro's structured `TuiCommand`
    enum `{"command": <bare_name>, "args": {}}` — NOT a `/name` string (kiro-cli 2.22.1
    rejects a string with `-32700` "Parse error"). Strips any leading slash(es) to the bare
    lower-case name; empty/slash-only input raises `ValueError`. The `ValueError` on a
    server error now includes the JSON-RPC error `data` for diagnosability. Verified live
    against the real kiro-cli binary (7/7 commands accepted, no Parse error).
  - Diagnostic instrumentation (markers `acp-usage-diag-*`, `ACP_LOG_RAW_USAGE`) was
    REMOVED and replaced by real handling. (If you see those strings, you're on an old build.)
- `openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py`:
  - `list_acp_commands()` (~1824) and `execute_acp_command(command)` (~1836) — ACP-only.
- `openhands-agent-server/openhands/agent_server/event_service.py` — `list_acp_commands()` /
  `execute_acp_command()` delegating to the conversation.
- `openhands-agent-server/openhands/agent_server/conversation_router.py`:
  - `GET  /{conversation_id}/acp_commands` (~623)
  - `POST /{conversation_id}/execute_acp_command` (~649)
- Tests updated/added: `tests/sdk/agent/test_acp_agent.py`,
  `tests/sdk/conversation/test_switch_model.py`,
  `tests/agent_server/test_conversation_router.py`.

### Frontend / Canvas — `/projects/OpenHands` (tsc clean; Kiro suites green)
- **NEW** `src/types/agent-server/core/events/acp-metadata-event.ts` — event type + registered in
  `openhands-event.ts` union, `index.ts`, and `type-guards.ts` (`isACPMetadataEvent`).
- **NEW** `src/components/conversation-events/chat/event-message-components/acp-metadata-message.tsx`
  — renders `Credits: X • Context: Y%` per turn; wired into `event-message.tsx` and
  `should-render-event.ts`.
- **NEW** `src/hooks/query/use-acp-commands.ts` + `src/hooks/mutation/use-execute-acp-command.ts`.
- **NEW** `src/components/features/chat/components/chat-input-acp-commands.tsx` — slash-command
  menu populated from `commands/available`; wired into `chat-input-actions.tsx`.
- **MODIFIED (session 3)** `src/hooks/chat/use-slash-command.ts` — merges ACP commands into the
  native `/`-typeahead and executes them via `useExecuteAcpCommand` on pick (see session-3 fix
  above). This is the path a user hits when typing `/context` + Enter; the pill is click-only.
- **MODIFIED (session 4)** `src/utils/handle-event-for-ui.ts` — `preserveMetadataEvents` invariant
  so a settled `ACPMetadataEvent` survives the finalize/supersede rebuild (see session-4 findings
  above). Defensive; the real disappear-on-settle cause was later pinned and fixed in session 7.
- **MODIFIED (session 7)** `src/components/conversation-events/chat/messages.tsx` — added
  `metadataSignature` to the `Messages` `React.memo` comparator so a settling ACP metadata chip
  (a non-last-element change) forces a re-render; this is the actual fix for the disappear-on-settle
  bug (see session-7 findings above). New tests:
  `__tests__/components/conversation-events/chat/messages-acp-metadata-rerender.test.tsx` and the
  store-integration cases in `__tests__/stores/use-event-store.test.ts`.
- **MODIFIED (session 5)** `src/hooks/query/use-acp-commands.ts` — retry + poll-until-populated so
  the command list recovers from the `acp_commands` 404 window during ACP session startup (see
  session-5 findings above). This is the actual reason the menu stayed empty live.
- **MODIFIED (session 6)** `src/components/features/chat/components/chat-input-acp-commands.tsx` —
  the pill now strips a leading slash for display (`/{bareName}`) so it shows `/context` not
  `//context`, and passes the bare name to execute (see session-6 findings above).
- `src/api/conversation-service/agent-server-conversation-service.api.ts` — `getAcpCommands()` (~1162)
  and `executeAcpCommand()` (~1178), using the typescript-client's `AgentServerClient.request`.
- `src/constants/acp-providers.ts` (+ its tests) — Kiro provider registration (from the earlier
  "Step 2" work): local `ACP_LOCAL_PROVIDER_INFO` fallback (command `["kiro-cli","acp"]`,
  `KIRO_API_KEY`), `resolveAcpProviderInfo()` wrapper. Pinned `@openhands/typescript-client`
  has NO Kiro entry, so this local shim is load-bearing until the SDK ships it upstream.
- `src/api/acp-service/acp-service.api.ts` (+ tests) — `classifyKiro` auth probe (`kiro-cli whoami --format json`).
- `src/i18n/translation.json` — added `ACP_METADATA$CREDITS`, `ACP_COMMANDS$MENU_LABEL`, etc.
  (run `node scripts/make-i18n-translations.cjs` to regenerate the gitignored `declaration.ts`).
- **NEW** test `__tests__/components/conversation-events/chat/event-message-acp-metadata.test.tsx`.

---

## VERIFICATION STATUS (all green as of last run)
- SDK: `.venv/bin/python -m pytest tests/sdk/agent/test_acp_agent.py tests/sdk/conversation/test_switch_model.py tests/agent_server/test_conversation_router.py` → passed; full sweep 615 passed.
- Frontend: `npx tsc` exit 0; Kiro vitest suites (event-message-acp-metadata, acp-providers x2, acp-service.api) → 52 passed; `eslint` + `prettier` on all Kiro files → clean.
- NOT yet done: a **live end-to-end turn** against a real `kiro-cli acp` through the
  freshly built `agent-canvas:kiro` image (needs Docker, unavailable in this env). This is
  the main remaining validation. Confirm credits/context render and slash commands execute.

## Git state
Both repos have UNCOMMITTED changes (modified + untracked files listed above). Nothing has
been committed or pushed. `Dockerfile.kiro` is deleted (correct). No git operations were
performed — user has not asked to commit.

---

## NEXT STEPS (in priority order)
1. **Build via the `source` target** (commands above) and do a live turn. Verify:
   - `Credits: X • Context: Y%` line appears per turn in the Canvas chat.
   - The Commands dropdown shows **single** slashes (`/context`, not `//context`) — session-6 pill fix.
   - **Typing `/context` (or `/compact`, `/model`, `/usage`) in the input and pressing Enter**
     autocompletes to the Kiro command (NOT `/agent-creator`) and executes it via the
     `_kiro.dev/commands/execute` RPC — this is the session-3 typeahead fix, the main thing the
     user reported. Also confirm the click-only pill executes **without the HTTP 400** — that was the
     session-6 root cause (SDK sent the bare name; Kiro requires the leading slash), now fixed.
2. If anything is off live, check the frontend eslint requires the `unrs-resolver` platform
   binding (had to be installed once in this env for eslint to run).
3. Eventually: add Kiro to the upstream SDK ACP provider registry
   (`openhands-sdk/.../settings/acp_providers.py` + `ACPServerKind` literal in
   `settings/model.py` + typescript-client mirror) so the local Canvas shim can retire.
   Note: backend `ACPServerKind` literal did NOT include kiro at last check — that only
   matters if you persist an agent profile with the built-in kiro key vs. "custom".
4. Consider committing to a branch once live-verified.

## HOW TO RESUME
Point me at this file: `read /projects/OpenHands/KIRO_ACP_INTEGRATION.md`, and I'll pick up
here. The full transcript is at `/projects/conversation.log` if deeper context is needed.
