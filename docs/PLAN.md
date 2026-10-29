# Behind Everything — Architecture & Execution Plan

Working name: **Behind Everything** (product brief: `agent_activity_visualizer_product_concept.docx`).
A local-first observability layer that turns what Claude Code, Codex and Copilot *actually do* into a live,
explorable isometric world — with every signal labelled **observed**, **inferred** or **unavailable**.

Status: v0.1 plan · 2026-10-29

---

## 1. What we verified before planning (not assumed)

Inspected on this machine (Windows 11, Claude Code 2.1.251, Copilot CLI 1.0.75, Codex desktop/CLI data present):

| Assistant | Live hook surface (documented) | Local append-only log (zero-config) | What the log gives us |
|---|---|---|---|
| **Claude Code** | Hooks: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification` (permission prompts), `SubagentStart/Stop`, `PreCompact`, `Stop`, `SessionEnd` — JSON on stdin | `~/.claude/projects/<cwd-slug>/<session>.jsonl` | `user` / `assistant` turns with `tool_use` + `tool_result` blocks, `cwd`, `gitBranch`, `version`, `isSidechain` (subagents), `permissionDecision`, `file-history-snapshot`, `ai-title`, thinking *duration* |
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
5. **Redact before persist.** Secrets scrubbed at ingestion — the database never holds an unredacted value.
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
  agent_id: string;           // main agent or subagent (sidechain) — drives avatars
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
**classifier** — the only place that knows `Edit`/`apply_patch`/`str_replace` all mean "edit", and that
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

## 6. The world (UI) — "gamified but professional"

Reference 2 is the target: pastel isometric rooms, crisp pill labels with status dots, small people moving.

**Rendering choice: React Three Fiber, orthographic camera at true isometric angle, low-poly procedural geometry.**
- Reference-2 style is flat-shaded blocks (desks, shelves, screens) → buildable from primitives; **no art pipeline needed**.
- Real 3D gives free depth-sorting, smooth zoom/pan/focus tweening, and lighting; pills are DOM overlays (`@react-three/drei <Html>`) so text stays crisp, selectable and accessible.
- Alternative considered: PixiJS sprites — lighter, but requires hand-drawn isometric art for every prop and state. Rejected for MVP.

**Living elements**
- **Agents are characters.** Main agent = a coloured figure (Claude orange / Codex green / Copilot purple). It walks to the zone of its current phase; subagents spawn from Mission Control as smaller figures and walk to their own zones; they disappear on `subagent.end`.
- **Props reflect evidence:** files being read appear as glowing books on Explorer shelves; edited files become crates on the Implementation workbench (crate size ∝ diff size); test runs light a rack of test tubes green/red; pending approval raises a gate barrier.
- **Motion only on change** (brief §9). Idle world is calm; `prefers-reduced-motion` → teleport instead of walk.
- **Quest log:** the plan (TodoWrite / update_plan) rendered as quests that tick off. Session end shows a "delivery report" card: files changed, checks observed, unresolved failures, things *you* should verify.

**Around the world**
- Left: session switcher (multiple concurrent sessions/assistants, each with connection + capture badges: `LOG`, `LOG+HOOK`).
- Bottom: **timeline scrubber** (live ↔ pause ↔ replay at 1×/4×/16×) — the world replays because it is a pure function of state.
- Right: **inspector** on click — zone → events → event → raw evidence (redacted), diff view (Monaco diff, read-only), command output.
- **Coverage panel:** per-assistant capability matrix + unknown-event counter — "unobserved ≠ didn't happen" made visible.
- **Accessible escape hatch:** full searchable/filterable event table, keyboard navigation across zones, high-contrast theme, screen-reader labels on pills.

---

## 7. Tech stack (and why)

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript everywhere | One schema shared by collector, adapters, reducer, UI |
| Monorepo | pnpm workspaces | Already installed; strict deps |
| Runtime | Node 20 LTS (22 recommended) | Installed; fs.watch recursive on Windows |
| Validation | zod | Schema → types + runtime validation of adapter output |
| Server | Node `http` + `ws` | Two endpoints (hook POST, WS) don't justify a framework |
| Storage | `better-sqlite3` (WAL) | Synchronous, fast, prebuilt Windows binaries; swap to `node:sqlite` on Node ≥22.5 |
| Client | Vite + React 18 + `@react-three/fiber` + `drei` | See §6 |
| Client state | zustand | Tiny, works outside React for the WS stream |
| Tests | vitest; Playwright for UI smoke | Fixture-driven adapter contract tests are the backbone |
| Packaging | `npx behind-everything` (single CLI that starts collector + opens browser) | Matches "install → first live session" metric |

### Repo layout
```
packages/
  schema/        CanonicalEvent zod schema + types
  classifier/    tool/command → semantic kind
  adapters/      claude-code/  codex/  copilot-cli/   (pure parsers + fixtures/)
  redact/        rules + tests
  state/         reducer, phase machine, zone metrics, attention rules
apps/
  collector/     discovery, tailer, hook endpoint, store, ws, CLI entry
  hook/          be-hook forwarder + `behind-everything hooks install|uninstall`
  web/           world, timeline, inspector, coverage
fixtures/        recorded, redacted real sessions (normal, failing, interrupted, approval, subagents)
docs/
```

---

## 8. Delivery roadmap (each phase ends demoable and tested)

**Phase 0 — Capture spike (1–2 days)**
- Record 5 trace types per assistant (normal, failing test, interrupted, approval-waiting, subagent) → redact → `fixtures/`.
- Confirm Codex hooks on the installed version and Copilot VS Code chat storage; finalise capability matrix in `docs/CAPABILITIES.md`.
- ✅ Exit: fixture set exists; matrix lists every event we can/can't see per assistant.

**Phase 1 — Event foundation**
- `schema`, `classifier`, `redact`, `state` packages; Claude Code adapter first (best documented hooks + local data).
- Collector: discovery → tail → normalise → SQLite → WS. CLI `behind-everything` prints live canonical events.
- ✅ Exit: start a Claude Code session, see correctly ordered, correlated, redacted events stream within 500 ms; restart collector → no loss, no duplicates; adapter tests green against fixtures.

**Phase 2 — First useful UI (timeline-first)**
- Session list, live timeline, inspector with evidence + diffs, search/filter, pause/replay, coverage panel.
- ✅ Exit: brief §15 acceptance criteria pass for Claude Code without the world.

**Phase 3 — The world**
- Isometric scene, 9 zones, pills bound to `SessionState`, agent avatars + pathing, subagents, click-to-focus camera, replay through the world, reduced-motion mode.
- ✅ Exit: 60 fps on integrated GPU with 3 concurrent sessions; event-to-pixel < 250 ms.

**Phase 4 — Codex + Copilot CLI adapters, hook bridge**
- Adapters from fixtures; `hooks install` for all three (writes to user config with backup + clean uninstall); Approval Gate live for all.
- ✅ Exit: same task run in all three assistants renders comparably; coverage differences shown honestly.

**Phase 5 — Hardening & packaging**
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
