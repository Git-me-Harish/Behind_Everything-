# Capability matrix

What Behind Everything can and cannot see, per assistant and capture path. Updated whenever an adapter changes.
"Verified" means checked against real transcripts on a developer machine, not only documentation.

## Claude Code — transcript log (`claude-code-log` v1)

Source: `~/.claude/projects/<cwd-slug>/<session>.jsonl` (+ `<session>/subagents/*.jsonl`). Verified on Claude Code 2.1.251.
Zero configuration, read-only. Latency ≈ the time Claude Code takes to flush a line (typically < 1 s).

| Signal | Event kind | Class | Status | Notes |
|---|---|---|---|---|
| Session id, cwd, git branch, CLI version, model | `session.start` / session row | observed | ✅ verified | |
| Session title | `session.meta` | observed | ✅ verified | From `ai-title`; emitted only on change |
| Human prompt / turn start | `user.prompt`, `turn.start` | observed | ✅ verified | Background-task notifications excluded via `origin.kind` |
| Turn end | `turn.end` | observed | ✅ verified | `stop_reason: end_turn` |
| Assistant text | `assistant.message` | observed | ✅ verified | |
| Reasoning happened + duration | `assistant.reasoning` | observed | ✅ verified | **Content never captured** (`unavailable`) |
| File read / search | `file.read`, `file.search` | observed | ✅ verified | Read, Glob, Grep |
| File edit + diff stats | `file.edit` | observed | ✅ verified | Edit/Write/MultiEdit; `+/−` from `structuredPatch` |
| Files changed by shell commands | `file.edit` (op `command`) | observed | ✅ verified | Claude Code's own `bashEditDiff` |
| Shell commands, exit code, output | `command.run` | observed | ✅ verified | Exit code parsed from `Exit code N`; success ⇒ 0 |
| Test / build / dependency commands | `test.run`, `build.run`, `dependency.change` | observed command, pattern-classified | ✅ verified | Classifier anchored to invoked program |
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
edit-loop warnings (**inferred**), attention list, zone labels.

## Codex, Copilot CLI, Copilot in VS Code

Not implemented yet (Phase 4). Local log formats were surveyed in [PLAN.md §1](PLAN.md).
