# Behind Everything

See what your AI coding agent is actually doing.

Behind Everything is a local-first app that watches Claude Code (and later Codex and GitHub Copilot) sessions
as they run and turns their real activity — files read, edits made, commands run, tests, approvals, subagents —
into a live, explorable isometric world, a searchable timeline and replayable sessions.

Every signal is labelled **observed**, **inferred** or **unavailable**. Nothing leaves your machine.

- Product brief: [docs/agent_activity_visualizer_product_concept.docx](docs/agent_activity_visualizer_product_concept.docx)
- Architecture & roadmap: [docs/PLAN.md](docs/PLAN.md)

## Status

Pre-alpha. Phase 1 (event foundation, Claude Code adapter) in progress.

## Contributing

- `main` is always releasable; work happens on `feat/*`, `fix/*`, `chore/*` branches and lands via pull request.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- CI must be green before merge (typecheck + tests).

## License

Apache-2.0
