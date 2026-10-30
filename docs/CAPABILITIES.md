# Capability matrix

What Behind Everything can and cannot see, per assistant and capture path. Updated whenever an adapter changes.
"Verified" means checked against real transcripts on a developer machine, not only documentation.

## Claude Code — transcript log (`claude-code-log` v3)

Source: `~/.claude/projects/<cwd-slug>/<session>.jsonl` (+ `<session>/subagents/*.jsonl`). Verified on Claude Code 2.1.251.
Zero configuration, read-only. Latency ≈ the time Claude Code takes to flush a line (typically < 1 s).

| Signal | Event kind | Class | Status | Notes |
|---|---|---|---|---|
| Session id, cwd, git branch, CLI version, model | `session.start` / session row | observed | ✅ verified | |
| Session title | `session.meta` | observed | ✅ verified | From `ai-title`; emitted only on change |
| Human prompt / turn start | `user.prompt`, `turn.start` | observed | ✅ verified | Background-task notifications excluded via `origin.kind`; IDE context tags (`<ide_opened_file>`, `<ide_selection>`, `<system-reminder>`) stripped and listed in `payload.context` |
| Turn end | `turn.end` | observed | ✅ verified | `stop_reason: end_turn` |
| Assistant text | `assistant.message` | observed | ✅ verified | |
| Reasoning happened + duration | `assistant.reasoning` | observed | ✅ verified | **Content never captured** (`unavailable`) |
| File read / search | `file.read`, `file.search` | observed | ✅ verified | Read, Glob, Grep |
| File edit + diff | `file.edit` | observed | ✅ verified | Edit/Write/MultiEdit; unified diff lines (≤ 400) and `+/−` from `structuredPatch` |
| Files changed by shell commands | `file.edit` (op `command`) | observed | ✅ verified | Claude Code's own `bashEditDiff` |
| Shell commands, exit code, output | `command.run` | observed | ✅ verified | Exit code parsed from `Exit code N`; success ⇒ 0 |
| Test / build / dependency commands | `test.run`, `build.run`, `dependency.change` | observed command, pattern-classified | ✅ verified | Classifier anchored to invoked program |
| Test / check verdict hidden by a pipe | failure on a `succeeded` run | **inferred** | ✅ verified | Exit 0 but output reports failures (`3 failed`, `error TS…`); see `src/core/verdict.ts` |
| Plan / todos | `plan.update` | observed | ✅ verified | TodoWrite, TaskCreate/Update, Enter/ExitPlanMode |
| Question to the user | `user.question` (pending → answered) | observed | ✅ verified | AskUserQuestion |
| Human approval / any rejection | `permission.decision` | observed | ✅ verified | From `permissionDecision`; routine auto-accepts not emitted |
| Web fetch / search, MCP calls | `web.fetch`, `mcp.call` | observed | ✅ verified | |
| Token usage | `usage.tokens` | observed | ✅ verified | Per API message |
| API errors / retries | `system.error` | observed | ✅ verified | |
| Context compaction | `session.compaction` | observed | ✅ verified | |
| Subagents | `subagent.start/end`, per-agent events | observed (pairing inferred) | ⚠️ synthetic only | No local trace yet; agent ↔ spawning call paired FIFO |
| **Pending** permission prompt (not yet answered) | — | unavailable | ❌ | Written only after the decision → needs hooks (Phase 4) |
| Session end / process exit | — | unavailable | ❌ | Transcript has no end marker → needs `SessionEnd` hook |
| Unrecognised record types | `system.unknown` | — | ✅ | Counted and shown as drift |

Derived (state engine, `inferred` where noted): agent phase per agent, *repairing* (failure → edits → rerun, **inferred**),
edit-loop warnings (**inferred**), piped test/check failures (**inferred**), attention list, zone labels.
Long-running commands (> 60 s) are flagged in the UI against the wall clock while following live.

## Codex — rollout log (`codex-log` v1)

Source: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`CODEX_HOME` respected). Verified on the Codex VS Code
extension, CLI versions 0.142 – 0.162 (19 local sessions, ~8,500 events: no unknown records, no duplicates, every
call that starts also ends). Zero configuration, read-only.

A rollout holds two streams: what the model asked for (`response_item`: messages, reasoning, tool calls and raw
outputs) and what Codex did (`event_msg`: turns, tokens and — in newer versions — `item_completed` records with
exact exit codes, durations, parsed commands and file changes). Calls open activities; whichever report arrives
first closes them. Event ids come from Codex's own ids, so a thread continued in a second file adds nothing twice.

| Signal | Event kind | Class | Status | Notes |
|---|---|---|---|---|
| Session id, cwd, git branch, CLI version, model | `session.start` / session row | observed | ✅ verified | Forked threads are their own sessions |
| Title | `session.meta` | observed | ✅ verified | Codex has no titles: the first prompt, shortened |
| Turns (start, end, duration, interrupted) | `turn.start`, `turn.end` | observed | ✅ verified | `task_started` / `task_complete` / `turn_aborted` |
| Prompt | `user.prompt` | observed | ✅ verified | `UserMessage` items (or `user_message`); injected context is not a prompt |
| Assistant messages | `assistant.message` | observed | ✅ verified | Commentary and final answers |
| Reasoning happened | `assistant.reasoning` | observed | ✅ verified | **Content never captured** (Codex stores it encrypted) |
| Shell commands, exit code, duration, output | `command.run` | observed | ✅ verified | `shell` / `shell_command` / `exec_command`, background processes (`write_stdin`), code-mode cells (`exec` + `wait`) |
| File reads and searches | `file.read`, `file.search` | observed command, pattern-classified | ✅ verified | Codex reads through the shell (`Get-Content`, `cat`, `rg`…); Codex's own `parsed_cmd` names the files when present |
| Test / build / dependency commands | `test.run`, `build.run`, `dependency.change` | observed command, pattern-classified | ✅ verified | Same classifier as Claude Code |
| File edits with diffs | `file.edit` | observed | ✅ verified | `apply_patch` + `FileChange` items (unified diff or new content) |
| Plan | `plan.update` | observed | ⚠️ synthetic only | `update_plan` — not in the local logs yet |
| Approval of a command outside the sandbox | `permission.decision` | **inferred** (approved) / observed (refused) | ✅ verified | `sandbox_permissions: require_escalated`; it ran ⇒ approved (by you or a rule you saved) |
| MCP tool calls, web search | `mcp.call`, `web.fetch` | observed | ✅ verified | |
| Token usage, compaction | `usage.tokens`, `session.compaction` | observed | ✅ verified | |
| Calls whose end was never logged | result `cancelled` | **inferred** | ✅ verified | Closed when their turn ends |
| Subagents | — | unavailable | ❌ | Not seen in Codex logs yet |
| **Pending** approval prompt | — | unavailable | ❌ | Not written until answered → hooks (planned) |
| Unrecognised records | `system.unknown` | — | ✅ | Counted and shown as drift |

Local drift checks for both assistants: `pnpm test:local` (never runs in CI, never writes your content anywhere).

## Copilot CLI, Copilot in VS Code

Not implemented yet. Local log formats were surveyed in [PLAN.md §1](PLAN.md).
