# Behind Everything

See what your AI coding agent is actually doing.

Behind Everything is a local-first app that watches Claude Code (and later Codex and GitHub Copilot) sessions
as they run and turns their real activity — files read, edits made, commands run, tests, approvals, subagents —
into a live, explorable isometric world, a searchable timeline and replayable sessions.

Every signal is labelled **observed**, **inferred** or **unavailable**. Nothing leaves your machine.

- Product brief: [docs/agent_activity_visualizer_product_concept.docx](docs/agent_activity_visualizer_product_concept.docx)
- Architecture & roadmap: [docs/PLAN.md](docs/PLAN.md)

## Status

Pre-alpha. Phase 1 done for Claude Code: live capture, normalisation, redaction, local storage and a streaming API.
The visual world arrives in Phases 2–3. What we can and can't see: [docs/CAPABILITIES.md](docs/CAPABILITIES.md).

## Quick start

Requires Node 22+ (Node 20 works but needs a C++ toolchain for SQLite) and pnpm.

```sh
pnpm install
pnpm start          # collector on http://127.0.0.1:47821 + live event feed in the terminal
```

Then use Claude Code as usual in any project — its activity streams in. Nothing to configure in Claude Code.

| Endpoint | Returns |
| --- | --- |
| `GET /api/health` | Collector status and sources |
| `GET /api/sessions` | Sessions, most recent first |
| `GET /api/sessions/:id/events?after=<seq>` | Canonical events for a session |
| `GET /api/events/:id/evidence` | The raw (redacted) provider record behind an event |
| `WS /ws` | Live `events` and `sessions` messages |

Data lives in `~/.behind-everything/events.sqlite` (override with `BE_HOME`); sessions are kept 30 days (`--retention`).
The server binds to `127.0.0.1` only and refuses requests from other origins.

## Development

```sh
pnpm typecheck
pnpm test           # unit + integration tests on synthetic fixtures
pnpm test:local     # drift check: parses your real ~/.claude transcripts (never leaves your machine)
```

## Contributing

- `main` is always releasable; work happens on `feat/*`, `fix/*`, `chore/*` branches and lands via pull request.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- CI must be green before merge (typecheck + tests).

## License

Apache-2.0
