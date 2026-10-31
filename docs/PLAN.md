# Behind Everything: Architecture & Execution Plan

Working name: **Behind Everything** (product brief: `agent_activity_visualizer_product_concept.docx`).
A local-first observability layer that turns what Claude Code, Codex and Copilot *actually do* into a live,
explorable isometric world, with every signal labelled **observed**, **inferred** or **unavailable**.

Status: v0.7 · 2026-10-31. Phases 0–4 delivered: Claude Code, Codex and Copilot CLI adapters and the opt-in hook bridge (see [CAPABILITIES.md](CAPABILITIES.md)); next: Phase 5 hardening & packaging

---

## 1. What we verified before planning (not assumed)

Inspected on this machine (Windows 11, Claude Code 2.1.251, Copilot CLI 1.0.75, Codex desktop/CLI data present):

| Assistant | Live hook surface (documented) | Local append-only log (zero-config) | What the log gives us |
|---|---|---|---|
| **Claude Code** | Hooks: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification` (permission prompts), `SubagentStart/Stop`, `PreCompact`, `Stop`, `SessionEnd`; JSON on stdin | `~/.claude/projects/<cwd-slug>/<session>.jsonl` | `user` / `assistant` turns with `tool_use` + `tool_result` blocks, `cwd`, `gitBranch`, `version`, `isSidechain` (subagents), `permissionDecision`, `file-history-snapshot`, `ai-title`, thinking *duration* |
| **OpenAI Codex** | `hooks.json` / `[hooks]` in `config.toml`: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Pre/PostCompact`, `SubagentStart/Stop`, `Stop` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `session_meta` (cwd, git, cli_version), `turn_context` (approval & sandbox policy, model), `task_started/complete` (durations), `function_call` / `custom_tool_call` (+ `_output`, linked by `call_id`), `token_count`, reasoning *summary* (content encrypted) |
| **GitHub Copilot CLI** | `.github/hooks/*.json` v1: `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, … | `~/.copilot/session-state/<id>/events.jsonl` | The richest stream: `tool.execution_start/complete`, `permission.requested/completed`, `assistant.turn_start/end`, `subagent.*`, `skill.invoked`, `session.compaction_*`, `session.shutdown` (code-change + token metrics). Every event has `id`, `parentId`, `timestamp` |
| **Copilot in VS Code** | VS Code agent hooks + extension API (to confirm in Phase 0) | `vscode.metadata.json` links CLI sessions to VS Code; chat-panel storage TBD | Phase 0 spike |

**Key architectural consequence:** every target assistant already writes an append-only JSONL event log.
So we ship two complementary capture paths per assistant:

1. **Log tailers (default, zero-config, read-only).** Attach to sessions that are *already running*, backfill history, power replay. No settings change in the agent → nothing to break, nothing to trust. Risk: these files are not a public contract → versioned parsers + fixture contract tests + "unknown event" telemetry.
2. **Hook bridge (opt-in "Live+").** Documented surface. Adds what logs cannot: *pending* approvals (a permission prompt is only written to Claude's transcript once decided), sub-100 ms latency, and an authoritative session-start signal. Hooks **fail open**: forward stdin to the collector and exit 0 within ~50 ms; never block, never decide.

Both paths feed the same normaliser; events are deduplicated by `(assistant, native_id)`.

---

## 2. Non-negotiable principles

1. **Evidence, not imagination.** Every UI signal carries `source_class: observed | inferred | unavailable`. Inferred = dashed outline + "~" prefix + "why" tooltip listing the evidence events.
2. **Reasoning boundary.** Raw thinking/reasoning content is **never** rendered by default. We show that reasoning *happened* (observed: duration, block count). A user toggle may show the *summary the assistant itself displays to the user*; encrypted reasoning stays unavailable.
3. **Read-only observer.** MVP never approves, denies, edits prompts, or executes anything.
4. **Local-first.** Bind to `127.0.0.1` only, per-install random token, no telemetry, no network egress.
5. **Redact before persist.** Secrets scrubbed at ingestion: the database never holds an unredacted value.
6. **Renderer is a pure function of state.** The world never reads provider data; it reads `SessionState`. Replay = same reducer over stored events.
7. **Minimum code that works** (Ponytail ruleset is installed at project scope): stdlib → platform → existing dep → new code.

---

## 3. System architecture

```
 Claude Code ─┬─ transcript.jsonl ──┐
              └─ hooks ─► be-hook ──┤
 Codex ───────┬─ rollout-*.jsonl ───┤        ┌──────────────────── collector (Node, 127.0.0.1) ───────────────────┐
              └─ hooks ─► be-hook ──┼──────► │ discovery → tailer → adapter(raw→Canonical[]) → redactor → dedupe   │
 Copilot ─────┬─ events.jsonl ──────┤        │      → sequencer/correlator → SQLite (append-only)                 │
              └─ hooks ─► be-hook ──┘        │      → state engine (reducer) → WebSocket fan-out (events + deltas)│
 Workspace ── git diff / fs (opt-in) ──────► └────────────────────────────────────────────────────────────────────┘
                                                                  │ ws://127.0.0.1:47821
                                                                  ▼
                                         web client (React + R3F isometric world + timeline + inspector)
```

### Components

| Component | Responsibility | Notes |
|---|---|---|
| `be-hook` | Tiny script registered as a command hook; POSTs stdin JSON + hook name to collector | Fail-open, 300 ms timeout, exit 0 always |
| Discovery | Finds session files under each assistant's home; watches for new ones | `fs.watch` recursive (native on Windows/macOS) + 2 s poll fallback |
| Tailer | Byte-offset tail per file; handles partial lines, truncation, rotation | Offsets persisted → restart resumes exactly |
| Adapter | **Pure** `(rawLine, ctx) => CanonicalEvent[]` per assistant + per format version | 100 % fixture-tested; unknown types → `system.unknown` event (counted, visible in Coverage panel) |
| Redactor | Regex + entropy rules (keys, tokens, JWTs, `.env` values, `Authorization:` headers, URLs with creds) | Records `redactions[]` metadata so the UI can say *"2 values redacted"* |
| Correlator | Links `tool.call` ↔ `tool.result` (by call id), test failure → subsequent edits → re-run (repair chain), subagent ↔ parent | Emits correlation ids, not new facts |
| State engine | Deterministic reducer `(SessionState, CanonicalEvent) => SessionState`; phase state machine; zone metrics; attention cues | Same code runs server-side (live) and client-side (replay/scrub) |
| Store | SQLite (WAL): `sessions`, `events`, `evidence`, `offsets` | Retention policy (default 30 days), export to redacted `.jsonl` |
| Web client | World, timeline, inspector, coverage, replay | Served by collector; also works as `vite dev` |

---

## 4. Canonical event model (the product's real asset)

```ts
type SourceClass = 'observed' | 'inferred' | 'unavailable';
type Assistant   = 'claude-code' | 'codex' | 'copilot-cli' | 'copilot-vscode';

interface CanonicalEvent {
  id: string;                 // ulid
  native_id?: string;         // provider id → dedupe across tailer + hook
  session_id: string;         // ours; maps to provider session
  turn_id?: string;           // one user prompt → agent response cycle
  agent_id: string;           // main agent or subagent (sidechain); drives avatars
  seq: number;                // per-session monotonic, assigned by sequencer
  ts: string;                 // provider timestamp (ISO); ingest_ts kept separately
  assistant: Assistant;
  adapter: { name: string; version: string; capture: 'log' | 'hook' | 'workspace' };
  kind: EventKind;
  status?: 'started' | 'succeeded' | 'failed' | 'pending' | 'cancelled';
  source_class: SourceClass;
  actor: 'user' | 'assistant' | 'tool' | 'system';
  resources?: Array<{ type: 'file' | 'dir' | 'command' | 'test' | 'url' | 'tool' | 'mcp'; ref: string }>;
  summary: string;            // safe, redacted, one line
  payload?: unknown;          // structured, redacted
  duration_ms?: number;
  exit_code?: number;
  error_category?: 'test_failure' | 'build_error' | 'tool_error' | 'permission_denied' | 'timeout' | 'other';
  correlation?: { call_id?: string; caused_by?: string; repair_of?: string; parent_agent?: string };
  redactions?: Array<{ path: string; rule: string }>;
  evidence_ref?: string;      // pointer to raw line (file + byte offset) for drill-through
}

type EventKind =
  | 'session.start' | 'session.end' | 'session.compaction'
  | 'turn.start' | 'turn.end' | 'user.prompt' | 'assistant.message' | 'assistant.reasoning'
  | 'tool.call' | 'tool.result'
  | 'file.read' | 'file.search' | 'file.edit' | 'file.create' | 'file.delete'
  | 'command.run' | 'test.run' | 'build.run' | 'dependency.change'
  | 'plan.update' | 'permission.request' | 'permission.decision'
  | 'subagent.start' | 'subagent.end' | 'web.fetch' | 'mcp.call'
  | 'usage.tokens' | 'system.unknown';
```

Adapters emit `tool.call`/`tool.result` **plus** a semantic kind (`file.edit`, `test.run` …) derived by a shared
**classifier**: the only place that knows `Edit`/`apply_patch`/`str_replace` all mean "edit", and that
`pnpm vitest`/`pytest`/`go test` mean "test". Classifier output from a command string is `observed`
(it is literally the command); an outcome like *"tests passed"* is `observed` only from the exit code / runner output.

---

## 5. State engine: phases, zones, attention

**Zones** (from the brief) and their event sources:

| Zone | Fed by | Live pill example |
|---|---|---|
| Mission Control | session/turn events, user prompt | `● TURN 4 · 03:12` |
| Repository Explorer | `file.read`, `file.search`, Glob/Grep/LS | `● 23 FILES READ` |
| Planning Desk | `plan.update` (TodoWrite / update_plan / Copilot plan) | `● PLAN 3/7` |
| Implementation Zone | `file.edit/create/delete` + diff stats | `● 6 FILES · +214 −37` |
| Test & Build Lab | `test.run`, `build.run`, lint/typecheck | `● TESTS 41/42` (red dot on fail) |
| Repair Bay | *inferred*: failure → edits on related files → re-run | `~ RETRY 2` (dashed) |
| Dependencies & Tooling | `dependency.change`, `mcp.call`, `web.fetch` | `● 2 INSTALLS` |
| Approval Gate | `permission.request` / `decision` | `● 1 WAITING` (pulses) |
| Review & Delivery | `turn.end`/`session.end` + changed-file set + checks seen | `● READY · 2 RISKS` |

**Phase machine** (per agent): `idle → exploring → planning → implementing → testing → repairing → awaiting_approval → delivering → idle`,
plus `blocked` (no events for N s while a tool is `started`) and `interrupted`. Every transition stores the event ids that justified it → *"why am I in Repair?"* is always answerable.

**Attention cues:** failed command, ≥3 edits to the same file within a turn (loop), command running > 60 s, pending approval, unreviewed changes at session end, `system.unknown` spike (adapter drift).

---

## 6. The world (UI): "gamified but professional"

Reference 2 is the target: pastel isometric rooms, crisp pill labels with status dots, small people moving.

**Rendering choice: React Three Fiber, orthographic camera at true isometric angle, low-poly procedural geometry.**
- Reference-2 style is flat-shaded blocks (desks, shelves, screens) → buildable from primitives; **no art pipeline needed**.
- Real 3D gives free depth-sorting, smooth zoom/pan/focus tweening, and lighting; pills are DOM overlays (`@react-three/drei <Html>`) so text stays crisp, selectable and accessible.
- Alternative considered: PixiJS sprites: lighter, but requires hand-drawn isometric art for every prop and state. Rejected for MVP.

**Living elements**
- **Agents are characters.** Main agent = a coloured figure (Claude orange / Codex green / Copilot purple). It walks to the zone of its current phase; subagents spawn from Mission Control as smaller figures and walk to their own zones; they disappear on `subagent.end`.
- **Props reflect evidence:** files being read appear as glowing books on Explorer shelves; edited files become crates on the Implementation workbench (crate size ∝ diff size); test runs light a rack of test tubes green/red; pending approval raises a gate barrier.
- **Motion only on change** (brief §9). Idle world is calm; `prefers-reduced-motion` → teleport instead of walk.
- **Quest log:** the plan (TodoWrite / update_plan) rendered as quests that tick off. Session end shows a "delivery report" card: files changed, checks observed, unresolved failures, things *you* should verify.

**Around the world**
- Left: session switcher (multiple concurrent sessions/assistants, each with connection + capture badges: `LOG`, `LOG+HOOK`).
- Bottom: **timeline scrubber** (live ↔ pause ↔ replay at 1×/4×/16×); the world replays because it is a pure function of state.
- Right: **inspector** on click: zone → events → event → raw evidence (redacted), diff view (Monaco diff, read-only), command output.
- **Coverage panel:** per-assistant capability matrix + unknown-event counter: "unobserved ≠ didn't happen" made visible.
- **Accessible escape hatch:** full searchable/filterable event table, keyboard navigation across zones, high-contrast theme, screen-reader labels on pills.

---

## 7. Tech stack (and why)

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript everywhere | One schema shared by collector, adapters, reducer, UI |
| Monorepo | pnpm workspaces | Already installed; strict deps |
| Runtime | Node ≥ 22 (20 works, EOL) | Recursive fs.watch on all platforms |
| Validation | zod | Schema → types + runtime validation of adapter output |
| Server | Node `http` + `ws` | Two endpoints (hook POST, WS) don't justify a framework |
| Storage | `better-sqlite3@12` (WAL) | Synchronous, fast; prebuilt binaries for Node 22/24 (Node 20 is EOL and compiles from source) |
| Client | Vite + React 18 + `@react-three/fiber` + `drei` | See §6 |
| Client state | zustand | Tiny, works outside React for the WS stream |
| Tests | vitest; Playwright for UI smoke | Fixture-driven adapter contract tests are the backbone |
| Packaging | `npx behind-everything` (single CLI that starts collector + opens browser) | Matches "install → first live session" metric |

### Repo layout
One package until a second deployable needs its own dependencies (YAGNI over premature workspaces):
```
src/
  core/          schema, classifier, redaction, state engine (shared by collector and UI)
  adapters/      claude-code/ (codex/, copilot-cli/ in Phase 4): pure parsers + discovery
  collector/     tailer, SQLite store, localhost HTTP + WebSocket server
  cli.ts         `behind-everything` entry point
web/             UI (Phase 2+)
test/            unit, integration and fixture builders; local-transcripts drift test
docs/            PLAN, CAPABILITIES
```

---

## 8. Delivery roadmap (each phase ends demoable and tested)

**Phase 0: Capture spike (1–2 days)**
- Record 5 trace types per assistant (normal, failing test, interrupted, approval-waiting, subagent) → redact → `fixtures/`.
- Confirm Codex hooks on the installed version and Copilot VS Code chat storage; finalise capability matrix in `docs/CAPABILITIES.md`.
- ✅ Exit: fixture set exists; matrix lists every event we can/can't see per assistant.

**Phase 1: Event foundation**
- `schema`, `classifier`, `redact`, `state` packages; Claude Code adapter first (best documented hooks + local data).
- Collector: discovery → tail → normalise → SQLite → WS. CLI `behind-everything` prints live canonical events.
- ✅ Exit: start a Claude Code session, see correctly ordered, correlated, redacted events stream within 500 ms; restart collector → no loss, no duplicates; adapter tests green against fixtures.

**Phase 2: First useful UI (timeline-first)**
- Session list, live timeline, inspector with evidence + diffs, search/filter, pause/replay, coverage panel.
- ✅ Exit: brief §15 acceptance criteria pass for Claude Code without the world.

**Phase 2: delivered notes**
- Shipped beyond the original list: 2D workspace board (zones, live pills, agent avatars) as the bridge to Phase 3; attention list; delivery report; coverage dialog; keyboard shortcuts; light/dark; URL deep links.
- List/detail split: the session list endpoint serves a precomputed light form; the inspector fetches full events. 10k-event session: 15.5 MB → 8.5 MB, server 1.3 s → 0.34 s, reducer 1.3 s → 0.25 s (running totals instead of rescanning files).
- Truthfulness fix found in real use: piped test runs exit 0, so failures in their output are now counted as *inferred* failures.
- Tests: view-model unit tests, replay equivalence across snapshot boundaries, Playwright end-to-end against the real CLI (live WebSocket, replay, keyboard, dialogs, zero console errors).

**Phase 3: The world**
- Isometric scene, 9 zones, pills bound to `SessionState`, agent avatars + pathing, subagents, click-to-focus camera, replay through the world, reduced-motion mode.
- ✅ Exit: 60 fps on integrated GPU with 3 concurrent sessions; event-to-pixel < 250 ms.

**Phase 3: delivered notes**
- **Renderer:** plain three.js (no React Three Fiber), lazy-loaded as its own chunk (~150 kB gzip) so the rest of the screen never waits for it. Orthographic isometric camera; render-on-demand (0 fps when nothing moves; gentle idle motion capped at 30 fps; paused when the map is off-screen or the tab is hidden).
- **Pure core, thin renderer:** `web/src/world/` splits into pure, unit-tested modules: `layout` (3×3 building, corridor graph, Dijkstra routes, stations), `model` (room props and agents derived from `SessionState` only), `motion` (walking, re-routing mid-walk without teleporting, snapping), `camera` (fit, pan, pinch, zoom-around-cursor, clamping), and `build`/`engine`, which only draw. The whole building is one merged draw call; data-bound props are two instanced meshes.
- **Props are real counts:** books = files read, sticky notes = plan items (by status), lit monitors = files changed, server LEDs = commands (running / failed / ok), test tubes = verdict share (newest first), decision lamps = approvals / blocks / waiting, crates = files for review, Repair Bay lamps = failures and reruns. The Approval Gate barrier is down while something waits for the user; the Repair Bay beacon turns while a failure is unfixed. Status bars on every back wall; a ripple crosses a room's floor when an event lands in it.
- **Where agents are is now part of the deterministic state** (`AgentState.zone`): thinking happens wherever the agent already is; only a new prompt calls it back to Mission Control. This removed the agent bouncing between rooms on every reasoning block, and the 2D board uses the same field.
- **Labels are DOM, not WebGL:** room pills/badges and agent tags are real buttons positioned each frame: sharp at any DPI, keyboard-focusable, screen-reader named, and the existing tests run against the 3D map unchanged. Four label densities (tiny icon-only on phones → full detail up close).
- **Input:** one pointer-event path for mouse, pen and touch; drag to pan (a drag never selects), Ctrl/⌘+wheel or trackpad pinch to zoom around the cursor, two-finger pinch on touch, arrows / + / − / 0 on the focused map. Embedded in the page, a plain wheel or one-finger drag scrolls the page and a hint explains how to move the map; full-screen mode takes every gesture. Click a room (or its label) for its details; click a person for what they are doing now. Follow-Claude camera.
- **Resilience:** WebGL 2 detected up front; no WebGL, a failed chunk, a render crash or a context that does not come back within 4 s all fall back to the 2D board with the reason shown. Reduced motion: agents and camera jump, no ripples, no idle motion. Themes re-read from the same CSS tokens.
- **Responsive app-wide:** phone layout for the top bar, stats, timeline rows, replay bar and details panel; tested with no sideways scrolling at 360×740, 390×844, 844×390, 768×1024, 1024×768, 1366×768 and 1920×1080, with touch where applicable. Browser tests run on Chromium, Firefox and WebKit in CI.
- **Bugs found while building it:** re-inserting into a `Map` while iterating it froze the page on theme change with an agent on screen; fixed and covered by a browser test.
- **Measured** (Windows 11, Intel HD Graphics 400 (a low-end integrated GPU), Edge, continuous panning): **60.3 fps at 1440×900, 57.8 fps at 2560×1440**, 11 draw calls, ~7.4k triangles. Idle: 0 fps; ambient motion: 30 fps. Event-to-pixel (WebSocket message → frame on screen): asserted < 250 ms in the browser tests. Only the selected session is drawn, so the cost does not grow with the number of sessions the collector is tailing (measured with one live session).
- Found by measuring: the 30 fps idle-motion cap was also throttling frames requested by input, so dragging ran at 22 fps whenever an agent was busy; input and data changes now always draw on the next frame.

**Phase 3.1: delivered notes**
- **Claude's mascot as the agent.** The pixel creature from Claude Code's banner, sampled from the original (17×5 pixels, each 4:9), is one drawing (`web/src/world/clawd.ts`) used twice: extruded into a voxel figure in the map, and as a crisp SVG wherever Claude appears in the 2D UI. In 3D its front and back legs step in turn, the body rocks, the arms type while a tool runs and wave while it waits for you, it blinks every few seconds (a timer wakes the otherwise idle render loop for ~5 frames, so idle still costs nothing), and at rest it turns to face the viewer. Subagents are smaller mascots in their own colours; other assistants keep people (`AgentModel.avatar`). Every figure now turns smoothly instead of snapping.
- **Collapsible sessions list.** One button (and `s`): the column slides shut on wide screens and the choice is remembered; on narrow screens it is a drawer with a tap-to-close backdrop and `Esc`. The closed list is `inert`, so it leaves the tab order.

**Phase 4: Codex + Copilot CLI adapters, hook bridge**
- Adapters from fixtures; `hooks install` for all three (writes to user config with backup + clean uninstall); Approval Gate live for all.
- ✅ Exit: same task run in all three assistants renders comparably; coverage differences shown honestly.

**Phase 4: delivered notes (Codex)**
- Surveyed 19 real rollouts across Codex 0.142 – 0.162 before writing a line: the tool surface changed three times in that range (`shell_command` → `exec_command` with background processes → code-mode `exec` cells that call tools from a script), and structured `item_completed` records appeared alongside the raw calls. The adapter handles all of them: calls open activities, the first report (raw output or structured item) closes them, and items run inside cells are matched to their call by command text. Result over the local data: ~8,500 events, 0 unknown, 0 duplicates, every started call finished.
- Codex reads files through the shell, so the shared classifier now also recognises read/search commands (`classifyShell`), anchored to every invoked program like the test/build rules.
- Approvals: Codex logs no approval events, but a command that asked to leave the sandbox and then ran was approved, shown as **inferred**; a refusal is observed from the output.
- A thread continued in a second rollout file shares the session id: event ids come from Codex's own ids, so nothing is counted twice.
- The collector runs one tailer per assistant; the UI is assistant-aware (names, colours, coverage, session marks). Codex appears as a person in Codex green; Claude keeps its mascot.

**Phase 4: delivered notes (Copilot CLI)**
- Built against the CLI's own event schema, which ships with it (`copilot-sdk/generated/session-events.d.ts`, 110+ event types, each marked persisted or ephemeral), and checked on the two local sessions (~9,200 records, Copilot CLI 1.0.75 and a VS Code-hosted session). Result: ~2,500 events, 0 unknown, 0 duplicates, every started call finished, 11 turns opened and closed.
- A Copilot "turn" is one model call (504 of them for 9 prompts in one session). Our turn runs from the prompt to the first model call that requests no tools, the only persisted signal, since `session.idle` is ephemeral. An empty model call followed by `session.error` fails the turn (seen: quota exhausted).
- **Approvals are observed, and live.** Copilot logs `permission.requested` when it asks and `permission.completed` (with `decisionSource`) when it is decided: 1,083 requests in one session, 3 answered by a human. Routine policy approvals stay hidden. To show a request that is *waiting*, the tailer now asks each parser what is still open once it has caught up with the file (`idle()`): a request open at that moment is shown as pending until its decision arrives: no flicker for the millisecond policy approvals, and no hooks needed. The reducer parks the agent at the Approval Gate and returns it to its work afterwards; a decision no longer ends the call it belongs to.
- Todos live in a per-session SQL table edited through the `sql` tool; inserts and id-targeted updates/deletes are applied (13 todos tracked in the local session). Commands Copilot stops waiting for (`<command with shellId: N is still running…>`) stay running until a later `read_powershell` or notification reports the exit code; the local session has one finishing after 11 h 54 m.
- Subagents get their own agent id (the spawning call id), so the reducer now pairs a subagent with its call by id before falling back to order.
- The real data exposed a classifier gap that affected every assistant on Windows: `& 'C:\…\python3.12.exe' -m pytest` and versioned Pythons were plain commands. Program paths, the PowerShell call operator and `.exe`/`.cmd` suffixes are now normalised: the local Copilot session went from 6 to 68 test runs and 0 to 49 checks.
- Token usage is shown as unavailable for Copilot (only shutdown totals, repeated across resumes) instead of as zero.

**Phase 4: delivered notes (hook bridge)**
- Verified the surfaces on the installed versions before building: Claude Code 2.1.251 and Codex 0.164 both have a `PermissionRequest` hook; neither sends the call id with it. Claude Code also has HTTP hooks, but a failed one prints a "hook error" in your transcript whenever Behind Everything is not running, so both use a command hook that runs in the background, never decides and exits 0 silently.
- The hook names the tool and input, not the call: the collector matches it to the call the log already shows running by the one-line summary the adapters compute (shared functions, so both sides agree exactly), waiting up to 30 s for a log line that lags. The answer still comes from the log (approval, refusal, or the call finishing), so the hook only ever adds "waiting".
- `hooks install | uninstall | status`: writes to the user config with a backup, keeps the user's own hooks, is idempotent, follows port changes and refuses to touch an unparsable file. Codex's per-hook trust (a hash in `config.toml`) is internal, so the installer explains the `/hooks` step instead of writing it.
- Alerts across sessions: the collector tracks what each session waits on (approvals from hooks or Copilot, questions from any assistant) and sends it with the session list; the UI shows it in the list, the tab title and, opt-in, as desktop notifications.
- Found on the way: the UI could miss events that arrived between its first load and its live connection (only reconnects backfilled); it now catches up on every connection. The top bar now fits a 390 px phone with touch-size buttons.
- Not possible headlessly: a real `PermissionRequest` (`claude -p` refuses without asking). The path is tested end to end with the installed forwarder against a running collector and the browser.

**Phase 4.1: delivered notes (mascots, sessions list, map hardening)**
- Every assistant walks the map as its mascot. Codex: the plush blue cloud in a beret, with the heart, the frog and the triangle as its subagents (each in its own colour, everywhere in the UI). Copilot: its goggled head, hovering. One pixel drawing per mascot makes both the voxel figure (rounded like a plush toy: depth grows with the distance from the outline; face details are plates on the front) and the flat icon. Plush toys hop and squash, bounce while waiting and wobble at work; Copilot glides and rocks; all blink and face the viewer at rest. Idle still costs 0 fps.
- Sessions list: two quiet lines per session (mascot, title, short time or Live; then project and a non-default branch, or what it waits for), grouped Today / Yesterday / This week / Earlier, with the details one hover away. The footer shows what is watched as mascot marks with counts.
- Map hardening: labels never cover a room's name (room labels are placed back to front and nudged; an agent tag that would cover one drops below the agent), and the renderer lowers its pixel ratio while motion stutters on a weak GPU, restoring it slowly once frames are quick again.
- Writing: no em dashes anywhere in the UI, CLI, code or docs.

**Phase 5: Hardening & packaging**
- Retention + redacted export with preview, performance budgets (collector < 1 % CPU idle, < 120 MB RAM), onboarding, `npx` package, troubleshooting docs, Copilot-in-VS-Code adapter if Phase 0 found a supported surface.

---

## 9. Testing strategy

- **Adapter contract tests:** every fixture line → snapshot of canonical events; schema-validated. New provider version = new fixture + diff review.
- **Reducer property tests:** replaying any prefix of events is deterministic; seq-ordered and arrival-ordered inputs converge.
- **Redaction tests:** corpus of synthetic secrets must never reach SQLite or WS (asserted by scanning the DB in CI).
- **Tailer tests:** partial lines, truncation, rotation, concurrent writers, Windows path quirks.
- **E2E:** Playwright drives the web UI against a replayed fixture stream.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Log formats change silently (not a public contract) | Versioned parsers, `system.unknown` counter surfaced in UI, hooks as documented fallback |
| Showing private reasoning by accident | Reasoning content excluded at adapter level by default; test asserts it |
| Hook slows the agent | Fail-open forwarder, 300 ms cap, async POST, exit 0 |
| Secrets in tool output | Redact-before-persist + CI DB scan |
| World is pretty but not useful | Timeline-first in Phase 2; Phase 3 measured against it (time-to-answer the brief's 5 questions) |
| Multiple concurrent sessions in same repo | Session identity from provider id, never from cwd alone |

---

## 11. Decisions taken (change here if you disagree)

1. Form factor: **localhost web app + local collector**, launched by one CLI. Desktop shell (Tauri) later if needed.
2. First adapter: **Claude Code** (documented hooks + rich transcripts present locally). Copilot CLI second (richest log), Codex third.
3. Visual: **R3F isometric low-poly**, DOM pills.
4. Capture default: **log tailing only**; hooks opt-in via explicit `hooks install`.
5. Retention: 30 days local, configurable; export is redacted `.jsonl`.
