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

## Codex, Copilot CLI, Copilot in VS Code

Not implemented yet (Phase 4). Local log formats were surveyed in [PLAN.md §1](PLAN.md).
