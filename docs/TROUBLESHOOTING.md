# Troubleshooting

Start here:

```sh
npx behind-everything doctor
```

It checks your Node.js version, the data folder and SQLite, whether Behind Everything is running (or something else
holds its port), where each assistant's logs are and how recent they are, and the optional hook. Every problem it finds
comes with the command that fixes it.

## Nothing shows up

**A session I am running does not appear.**
Behind Everything reads the logs the assistants already write:

| Assistant | Logs | Set this if they live elsewhere |
|---|---|---|
| Claude Code (CLI and IDE extensions) | `~/.claude/projects` | `CLAUDE_CONFIG_DIR` |
| Codex (CLI and VS Code extension) | `~/.codex/sessions` | `CODEX_HOME` |
| GitHub Copilot CLI (terminal, and VS Code when it hosts the CLI) | `~/.copilot/session-state` | `COPILOT_HOME` |

Run `doctor`: it says whether each folder exists and how many sessions it holds. A session appears once the assistant
has written its first line, usually as soon as you send a prompt.

**Older sessions are missing.** On startup it loads sessions active in the last 7 days. Use
`npx behind-everything --since 30` for more. Stored sessions are kept for 30 days (`--retention <days>`).

**Copilot Chat in VS Code is missing.** Only the Copilot CLI agent is supported (including when VS Code hosts it).
VS Code's own chat history uses a different, undocumented format.

## It will not start

**"Port 47821 is already in use".** Another copy of Behind Everything, or another program, is using the port.
`doctor` tells you which. Start on another port with `npx behind-everything --port 47822`; if you use the hook, run
`npx behind-everything hooks install --port 47822` too.

**Installing fails with errors about `better-sqlite3`, `node-gyp` or a C++ compiler.** You are on Node.js 20 or
older, for which no prebuilt SQLite binary exists. Install Node.js 22 or 24 LTS from <https://nodejs.org>, then run
`npx clear-npx-cache` and try again.

**Installing hangs or fails behind a company proxy.** npm needs to reach the registry and GitHub (for the prebuilt
SQLite binary). Configure npm's proxy (`npm config set proxy ...` and `https-proxy`) and retry.

## In the browser

**"Can't reach the collector".** The terminal running Behind Everything was closed or stopped. Start it again; the
page reconnects by itself.

**The map is a flat board instead of 3D.** The 3D view needs WebGL 2. The page says why it fell back. Turn on
hardware acceleration in your browser settings (Chrome and Edge: Settings, System), update your graphics driver, or
try another browser. Everything else works the same on the board.

**The map is slow.** On weak graphics it lowers its resolution by itself while things move. Closing other GPU-heavy
tabs helps. When nothing moves it draws nothing.

**Desktop notifications do not appear.** Turn them on with the bell in the top bar. If the bell is crossed out and
disabled, notifications are blocked for the page in your browser's site settings. Your operating system's focus or
do-not-disturb mode can also hide them.

## Approvals

**Claude Code or Codex approval prompts only show after I answer them.** That is all their logs contain. To see
prompts while they wait, install the optional hook: `npx behind-everything hooks install`, then start a new Claude Code
session. Copilot shows waiting prompts without a hook.

**I installed the hook but nothing changed.**
- Run `npx behind-everything hooks status`: it shows whether the hook is installed for the right port and whether the
  running Behind Everything has received calls from it.
- Claude Code reads hooks when a session starts: start a new one.
- Codex runs a new hook only after you trust it. Start Codex in a terminal, type `/hooks`, and trust the Behind
  Everything hook. Also check `config.toml` does not set `hooks = false` under `[features]`.
- "Unmatched" hook calls are usually harmless (the call finished before its log line arrived). If they keep growing,
  please report it.

**Removing the hook.** `npx behind-everything hooks uninstall` removes exactly what was added. Your settings were
backed up next to the file when it was installed (`settings.json.bak-<date>`).

## Sharing sessions

**What is in a shared file?** The Share dialog shows it before you download: the session's events, with secrets
redacted, your home folder shortened to `~` and the project folder reduced to its name. You choose whether prompts,
command output and diffs are included. The model's reasoning, raw log records and file locations on your machine are
never included. Read the file before you send it if you are unsure: it is plain JSON.

**Opening one.** Use "Open a shared session" in the sessions list, drop the file on the window, or run
`npx behind-everything open <file>`. Shared sessions are read-only and marked "Shared"; remove them from the session
header.

**"This is not a Behind Everything session file."** The file is something else, or was changed. Ask for it to be
exported again.

## Performance

Measured on a heavy week of history (30 sessions, 90,000 events, 56 MB of logs) with `pnpm perf`:

| | Measured | Budget |
|---|---|---|
| Idle CPU | 0.3 % of one core | under 1 % |
| Memory after loading | 78 MB | under 120 MB |
| Reading that history on first start | about 15 s, briefly up to about 150 MB | |

Quiet logs are checked every 15 seconds and live ones every second; new lines normally arrive within a moment through
the operating system's file notifications. If it uses more than this, run `doctor` and report it with the output.

## Starting over

Stop it with Ctrl+C. Its data lives in `~/.behind-everything` (or `BE_HOME`): delete that folder to start fresh. Run
`npx behind-everything hooks uninstall` first if you installed the hook. `npx clear-npx-cache` removes the downloaded
package.

## Reporting a problem

Open an issue at <https://github.com/Git-me-Harish/Behind_Everything-/issues> with the output of
`npx behind-everything doctor` and what you expected to see. Never attach session logs: they contain your code. A
session shared from the Share dialog, with prompts and output left out, is safe to attach when it helps.
