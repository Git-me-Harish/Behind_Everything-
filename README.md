# Behind Everything

See what your AI coding agent is actually doing.

Behind Everything is a local-first app that watches Claude Code (and later Codex and GitHub Copilot) sessions
as they run and turns their real activity — files read, edits made, commands run, tests, approvals, subagents —
into a live 3D workspace, a searchable timeline and replayable sessions.

Every signal is labelled **observed**, **inferred** or **unavailable**. Nothing leaves your machine.

![Behind Everything — session overview](docs/images/overview.png)

- Product brief: [docs/agent_activity_visualizer_product_concept.docx](docs/agent_activity_visualizer_product_concept.docx)
- Architecture & roadmap: [docs/PLAN.md](docs/PLAN.md)
- What we can and can't see: [docs/CAPABILITIES.md](docs/CAPABILITIES.md)

## Quick start

Requires Node 22+ (Node 20 works but needs a C++ toolchain for SQLite) and pnpm.

```sh
pnpm install
pnpm start
```

Your browser opens at <http://127.0.0.1:47821>. Use Claude Code as usual in any project — its activity appears live.
Nothing to configure in Claude Code. Options: `pnpm start -- --help`.

## What you see

| | |
| --- | --- |
| **Sessions** | Every recent Claude Code session, live ones marked. Pick one to explore. Collapse the list (top-left button or `s`) for a wider workspace; it stays the way you left it. On phones it is a drawer. |
| **Agents** | Claude and any subagents, each with its current phase (exploring, implementing, testing, waiting for you…) and the tool call it is running, with a live timer. |
| **Workspace** | An isometric building with nine rooms — Explorer, Planning, Implementation, Tools, Mission Control, Test & Build Lab, Approval Gate, Review, Repair Bay — each with a live status pill. Claude — its pixel mascot, in voxels — and its subagents (smaller mascots in their own colours) walk the corridors to the room of what they are doing now; they type while a tool runs, wave while waiting for you, and blink now and then. The furniture is data: books are files read, sticky notes are plan items, lit monitors are files changed, test tubes are verdicts, crates are files ready for review; the Approval Gate's barrier drops while something waits for you and the Repair Bay beacon turns while a failure is unfixed. Click a room for its details, a person for what they are doing. Also available as a flat board or a strip. |
| **Needs attention** | Failed tests and commands, blocked actions, questions for you, edit loops, commands running too long. Click to jump to the evidence. |
| **Timeline** | Every action, grouped by turn: tool calls paired with their results, exit codes, durations, diff sizes. Filter by kind, failures, agent or file; search everything. |
| **Details** | The full story of one action: command and output, the actual diff, the plan, the question and your answer, permission decisions — and the raw transcript record it came from. |
| **Replay** | Drag the scrubber or press play: the whole screen shows the session exactly as it was at that moment. |
| **Coverage** | What the collector can and cannot see, how many values were redacted, and any record types it did not recognise. |

![Details panel showing a diff](docs/images/inspector.png)

**Honest by design.** Anything derived rather than read directly is marked *inferred* (dashed outline, `~`) and links to
the events behind it — for example the Repair Bay, or a test run that exited 0 but whose output reports failures
(usually a piped command). The model's private reasoning is never shown; only that it reasoned, and for how long.

### Keyboard

`j`/`k` next/previous · `Esc` close · `/` search · `f` failures only · `Space` play/pause · `[` `]` step · `l` live · `s` sessions list · `?` help

On the map: drag to move · Ctrl/⌘ + scroll, trackpad pinch or two-finger pinch to zoom · with the map focused, arrow keys move, `+`/`−` zoom, `0` fits.
Full screen (⤢) gives the map every gesture; `Esc` returns.

### Devices and browsers

Works on phones, tablets, laptops and large screens, with touch, mouse, pen or keyboard, in Chrome, Edge, Firefox and Safari
(browser tests run on Chromium, Firefox and WebKit at seven screen sizes). The 3D map needs WebGL 2; without it — or if
the graphics driver gives up — the flat board takes over and says why. *Reduce motion* is honoured: agents and the
camera jump instead of moving.

## API

The UI is built on a small local API you can use directly:

| Endpoint | Returns |
| --- | --- |
| `GET /api/health` | Collector status and sources |
| `GET /api/sessions` | Sessions, most recent first |
| `GET /api/sessions/:id/events?after=<seq>` | A session's events in list form (bulky outputs and diffs left out) |
| `GET /api/events/:id` | One event in full |
| `GET /api/events/:id/evidence` | The raw (redacted) transcript record behind an event |
| `WS /ws` | Live `events` and `sessions` messages |

Data lives in `~/.behind-everything/events.sqlite` (override with `BE_HOME`); sessions are kept 30 days (`--retention`).
The server binds to `127.0.0.1` only and refuses requests from other hosts and origins.

## Development

```sh
pnpm dev            # collector + Vite with hot reload on http://localhost:5173
pnpm typecheck
pnpm test           # unit + integration tests on synthetic fixtures
pnpm test:e2e       # browser tests (PW_CHANNEL=msedge or chrome uses an installed browser)
pnpm test:local     # drift check: parses your real ~/.claude transcripts (never leaves your machine)
```

README screenshots come from the synthetic test session: `BE_SCREENSHOTS=1 pnpm test:e2e`.

## Contributing

- `main` is always releasable; work happens on `feat/*`, `fix/*`, `chore/*` branches and lands via pull request.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- CI must be green before merge (typecheck, unit/integration tests, build, browser tests).

## License

Apache-2.0
