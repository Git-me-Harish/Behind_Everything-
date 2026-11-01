# Capability matrix

What Behind Everything can and cannot see, per assistant and capture path. Updated whenever an adapter changes.
"Verified" means checked against real transcripts on a developer machine, not only documentation.

## Claude Code: transcript log (`claude-code-log` v3)

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
| **Pending** permission prompt (not yet answered) | `permission.decision` `pending` | observed (hook) | ✅ opt-in | Not in the transcript until decided → [hook bridge](#hook-bridge-opt-in-claude-code-and-codex) |
| Session end / process exit | n/a | unavailable | ❌ | Transcript has no end marker → needs `SessionEnd` hook |
| Unrecognised record types | `system.unknown` | n/a | ✅ | Counted and shown as drift |

Derived (state engine, `inferred` where noted): agent phase per agent, *repairing* (failure → edits → rerun, **inferred**),
edit-loop warnings (**inferred**), piped test/check failures (**inferred**), attention list, zone labels.
Long-running commands (> 60 s) are flagged in the UI against the wall clock while following live.

## Codex: rollout log (`codex-log` v1)

Source: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`CODEX_HOME` respected). Verified on the Codex VS Code
extension, CLI versions 0.142 – 0.162 (19 local sessions, ~8,500 events: no unknown records, no duplicates, every
call that starts also ends). Zero configuration, read-only.

A rollout holds two streams: what the model asked for (`response_item`: messages, reasoning, tool calls and raw
outputs) and what Codex did (`event_msg`: turns, tokens and (in newer versions) `item_completed` records with
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
| Plan | `plan.update` | observed | ⚠️ synthetic only | `update_plan`, not in the local logs yet |
| Approval of a command outside the sandbox | `permission.decision` | **inferred** (approved) / observed (refused) | ✅ verified | `sandbox_permissions: require_escalated`; it ran ⇒ approved (by you or a rule you saved) |
| MCP tool calls, web search | `mcp.call`, `web.fetch` | observed | ✅ verified | |
| Token usage, compaction | `usage.tokens`, `session.compaction` | observed | ✅ verified | |
| Calls whose end was never logged | result `cancelled` | **inferred** | ✅ verified | Closed when their turn ends |
| Subagents | n/a | unavailable | ❌ | Not seen in Codex logs yet |
| **Pending** approval prompt | `permission.decision` `pending` | observed (hook) | ✅ opt-in | Not written until answered → [hook bridge](#hook-bridge-opt-in-claude-code-and-codex) |
| Unrecognised records | `system.unknown` | n/a | ✅ | Counted and shown as drift |

Local drift checks for every assistant: `pnpm test:local` (never runs in CI, never writes your content anywhere).

## Copilot CLI: session log (`copilot-log` v1)

Source: `~/.copilot/session-state/<session>/events.jsonl` (`COPILOT_HOME` respected), written by the Copilot CLI and
by VS Code when it hosts the same agent runtime. Built against the CLI's own event schema
(`copilot-sdk/generated/session-events.d.ts`, shipped with the CLI) and verified on Copilot CLI 1.0.75 (2 local
sessions, ~9,200 records → ~2,500 events: no unknown records, no duplicates, every call that starts also ends).
Zero configuration, read-only.

Every line is one typed event. Streaming deltas, idle, title and todo-change events are *ephemeral* in the schema and
never reach the file. A Copilot "turn" is one model call, so a user interaction runs from the prompt to the first
model call that requests no tools. Event ids come from Copilot's own ids.

| Signal | Event kind | Class | Status | Notes |
|---|---|---|---|---|
| Session id, cwd, git branch, CLI version, model | `session.start` / session row | observed | ✅ verified | VS Code-hosted sessions log version 0.0.0: shown as unknown |
| Title | `session.meta` | observed | ✅ verified | The first prompt, shortened (Copilot's own title event is ephemeral) |
| Turns (start, end, interrupted, failed) | `turn.start`, `turn.end` | observed | ✅ verified | Prompt → first model call without tool requests; `abort` = interrupted; an empty model call followed by `session.error` = failed |
| Prompt, steering messages | `user.prompt` | observed | ✅ verified | Messages injected by skills/extensions (`source`) are not prompts |
| Assistant messages | `assistant.message` | observed | ✅ verified | |
| Reasoning happened | `assistant.reasoning` | observed | ✅ verified | Once per model call. **Content never captured** |
| File reads, searches, edits with diffs | `file.read`, `file.search`, `file.edit` | observed | ✅ verified | `view`, `rg`/`grep`/`glob`, `apply_patch`, `edit`, `create` (edit diffs have no line numbers: Copilot does not log them) |
| Shell commands, exit code, output | `command.run` | observed | ✅ verified | `powershell`/`bash`; a command Copilot stopped waiting for stays running until `read_*` or a notification reports its exit code |
| Test / build / dependency commands | `test.run`, `build.run`, `dependency.change` | observed command, pattern-classified | ✅ verified | Same classifier as the others, plus VS Code's `runTests` |
| Todo list | `plan.update` | observed | ✅ verified | Copilot keeps todos in a SQL table; inserts and id-targeted updates/deletes made through the `sql` tool are applied |
| Questions to you | `user.question` | observed | ✅ verified | `ask_user` |
| Your approvals and refusals | `permission.decision` | observed | ✅ verified | `permission.completed` with `decisionSource: human_response`, session/location approvals, refusals by you, rules, hooks or policy |
| Routine approvals by Copilot's policy | n/a | n/a | ✅ | Not shown (like Claude Code's auto-accepts) |
| **Pending** approval prompt | `permission.decision` `pending` | observed | ✅ verified | Live: a request still open once the log is caught up is waiting, shown until its decision arrives |
| Subagents | `subagent.start`/`end` + own agent | observed | ⚠️ synthetic only | `task` tool, `subagent.started/completed/failed`; the subagent's events carry its call id |
| MCP tool calls, web | `mcp.call`, `web.fetch` | observed | ✅ verified | |
| Compaction, truncation, errors | `session.compaction`, `system.error` | observed | ✅ verified | |
| Token usage | n/a | unavailable | ❌ | Only session totals at shutdown, repeated across resumes: not shown rather than shown wrong |
| Calls whose end was never logged | result `cancelled` | **inferred** | ✅ verified | Closed when the turn ends, or when the session process ends (shutdown, resume) |
| Unrecognised records | `system.unknown` | n/a | ✅ | Counted and shown as drift |

## Hook bridge (opt-in): Claude Code and Codex

`pnpm hooks install` (or `behind-everything hooks install`) adds one `PermissionRequest` hook to `~/.claude/settings.json`
and `~/.codex/hooks.json` (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` respected). Your config is backed up first and your own
hooks are kept; `hooks uninstall` removes exactly what was added; `hooks status` shows whether calls are arriving.

The hook is a dependency-free forwarder (`~/.behind-everything/behind-everything-hook.mjs`) that runs in the background
(`async`), posts the request to the collector on 127.0.0.1, gives up after a second and always exits 0 without
output. It **never decides** an approval and does nothing when Behind Everything is not running.

| Signal | Event kind | Class | Status | Notes |
|---|---|---|---|---|
| Approval prompt waiting for you | `permission.decision` `pending` (capture `hook`) | observed | ✅ end-to-end on synthetic data | Neither assistant sends the call id with the request: it is matched to the call the log shows running, by the same one-line summary the adapter computes. Requests that arrive before their log line wait up to 30 s; the rest are counted as unmatched (Coverage shows the counts) |
| How it was answered | from the log, as before | observed / inferred | ✅ | The approval or refusal in the transcript, or the call simply finishing, clears the wait |
| Codex | | | ⚠️ trust step | Codex runs a new hook only after you trust it (`/hooks` in the Codex CLI); install warns if hooks are switched off in `config.toml` |

A real `PermissionRequest` cannot be produced headlessly: `claude -p` refuses without asking (checked on 2.1.251), so
the payload follows the documented schema and the bridge is tested with the installed forwarder against a live collector.
The UI marks sessions waiting for you in the list, counts them in the tab title, and can send a desktop notification
(opt-in bell in the top bar), for approvals from the hook bridge or Copilot's log, and questions from any assistant.

## Shared sessions

A session can be saved as a file (Share in the session header) and opened by anyone in their own Behind Everything
(Open a shared session, a dropped file, or `behind-everything open <file>`).

| | In the file |
|---|---|
| Events (the whole timeline, map and replay) | Yes |
| Secrets | Redacted when captured, and again when exported |
| Your home folder | Shortened to `~` |
| The project folder | Only its name |
| Prompts and assistant messages, command output, file diffs | Your choice, shown before you download |
| The model's reasoning | Never captured |
| Raw log records, log file locations | Never |

Shared sessions are read-only, marked "Shared", and removable; they never mix with live ones (their ids are prefixed
`shared:`). The format is versioned (`behind-everything/session` v1): a file from a newer version says so instead of
opening wrong.

## Copilot Chat in VS Code

Not implemented yet. VS Code's own chat history (workspace storage) is a different format; sessions where VS Code hosts
the Copilot CLI runtime are already covered above.
