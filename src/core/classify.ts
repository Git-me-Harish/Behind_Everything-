import type { EventKind } from './schema.js';

// Patterns are anchored to the start of a single command segment (see `segments`).
// Order is priority: `pnpm install && pnpm test` is a test run.
const COMMAND_RULES: Array<[EventKind, RegExp]> = [
  ['test.run', /^(vitest|jest|mocha|ava|pytest|py\.test|rspec|phpunit|tox|nox|deno test|cargo test|go test|dotnet test|playwright test|cypress run|(npm|pnpm|yarn|bun)( run)? test|mvn\b.*\btest|\.?\/?gradlew?\b.*\btest)\b/],
  ['build.run', /^(tsc|tsgo|vite build|next build|webpack|rollup|esbuild|turbo( run)? (build|lint|typecheck)|cargo (build|check|clippy)|go (build|vet)|dotnet build|make|cmake --build|(npm|pnpm|yarn|bun)( run)? (build|lint|typecheck|type-check|check)|eslint|ruff|flake8|mypy|pyright|biome|golangci-lint|prettier (--check|-c)|mvn|\.?\/?gradlew?)\b/],
  ['dependency.change', /^((npm|pnpm|yarn|bun) (install|i|ci|add|remove|rm|uninstall|update|upgrade|up|rebuild)|pip3? install|poetry (add|install|remove)|uv (add|sync|remove|pip install)|cargo (add|remove)|go (get|mod tidy)|gem install|bundle install|composer (require|install)|dotnet add package)\b/],
];

const WRAPPERS = /^(npx|bunx|pnpm (exec|dlx)|yarn dlx|uv run|poetry run|python3? -m|time|sudo|env|command|exec)\s+/;
const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)+/;

/** Splits a shell line into the commands actually invoked, ignoring heredoc bodies and env prefixes. */
export function segments(command: string): string[] {
  const withoutHeredocs = command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g, '')
    .replace(/<<-?\s*['"]?\w+['"]?[\s\S]*$/, '');
  return withoutHeredocs.split(/&&|\|\||[;|\n()]/).map(s => {
    let seg = s.trim().replace(ENV_ASSIGN, '');
    while (WRAPPERS.test(seg)) seg = seg.replace(WRAPPERS, '').replace(ENV_ASSIGN, '');
    return seg;
  }).filter(Boolean);
}

/** Classifies a shell command line. The command itself is observed; the category is a pattern match on it. */
export function classifyCommand(command: string): EventKind {
  const segs = segments(command);
  for (const [kind, re] of COMMAND_RULES) if (segs.some(s => re.test(s))) return kind;
  return 'command.run';
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** Maps a Claude Code tool call to a semantic event kind. */
export function classifyClaudeTool(name: string, input: Record<string, unknown>): EventKind {
  if (SHELL_TOOLS.has(name)) return classifyCommand(String(input.command ?? ''));
  if (name.startsWith('mcp__')) return 'mcp.call';
  switch (name) {
    case 'Read': return 'file.read';
    case 'Glob': case 'Grep': case 'LS': return 'file.search';
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return 'file.edit';
    case 'WebFetch': case 'WebSearch': return 'web.fetch';
    case 'Agent': case 'Task': return 'subagent.start';
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': case 'EnterPlanMode': case 'ExitPlanMode': return 'plan.update';
    case 'AskUserQuestion': return 'user.question';
    default: return 'tool.call';
  }
}
