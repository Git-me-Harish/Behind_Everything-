import type { EventKind } from './schema.js';

// Patterns are anchored to the start of a single command segment (see `segments`).
// Order is priority: `pnpm install && pnpm test` is a test run.
const COMMAND_RULES: Array<[EventKind, RegExp]> = [
  ['test.run', /^(vitest|jest|mocha|ava|pytest|py\.test|rspec|phpunit|tox|nox|deno test|cargo test|go test|dotnet test|playwright test|cypress run|(npm|pnpm|yarn|bun)( run)? test|mvn\b.*\btest|\.?\/?gradlew?\b.*\btest)\b/],
  ['build.run', /^(tsc|tsgo|vite build|next build|webpack|rollup|esbuild|turbo( run)? (build|lint|typecheck)|cargo (build|check|clippy)|go (build|vet)|dotnet build|make|cmake --build|(npm|pnpm|yarn|bun)( run)? (build|lint|typecheck|type-check|check)|eslint|ruff|flake8|mypy|pyright|biome|golangci-lint|prettier (--check|-c)|mvn|\.?\/?gradlew?)\b/],
  ['dependency.change', /^((npm|pnpm|yarn|bun) (install|i|ci|add|remove|rm|uninstall|update|upgrade|up|rebuild)|pip3? install|poetry (add|install|remove)|uv (add|sync|remove|pip install)|cargo (add|remove)|go (get|mod tidy)|gem install|bundle install|composer (require|install)|dotnet add package)\b/],
];

const WRAPPERS = /^(npx|bunx|pnpm (exec|dlx)|yarn dlx|uv run|poetry run|(python|py)[\d.]*( -[\d.]+)? -m|time|sudo|env|command|exec|timeout \S+|do|then|else|!|\{)\s+/;
const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)+/;

/** `& 'C:\Python\python3.12.exe' -m pytest` → `python3.12 -m pytest`: the program by name, as the rules expect. */
function programName(seg: string): string {
  return seg
    .replace(/^&\s*/, '')
    .replace(/^(['"])([^'"]*)\1/, '$2')
    .replace(/^[^\s]*[\\/](?=[^\s\\/])/, '')
    .replace(/^(\S+?)\.(exe|cmd|bat)(?=\s|$)/i, '$1');
}

/** Splits a shell line into the commands actually invoked, ignoring heredoc bodies and env prefixes. */
export function segments(command: string): string[] {
  const withoutHeredocs = command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g, '')
    .replace(/<<-?\s*['"]?\w+['"]?[\s\S]*$/, '');
  return withoutHeredocs.split(/&&|\|\||[;|\n()]/).map(s => {
    let seg = programName(s.trim().replace(ENV_ASSIGN, ''));
    while (WRAPPERS.test(seg)) seg = programName(seg.replace(WRAPPERS, '').replace(ENV_ASSIGN, ''));
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

// Agents without dedicated read/search tools (Codex) read files through the shell.
const READ = /^(cat|type|Get-Content|gc|head|tail|less|more|nl|bat|sed -n)\b/i;
const SEARCH = /^(rg|grep|egrep|fgrep|ag|Select-String|sls|find|fd|ls|dir|Get-ChildItem|gci|tree|git (grep|ls-files))\b/i;
/** Output shaping that does not change what a command is: `rg … | head -50`, `Get-Content x | Select-Object -First 80`. */
const FILTER = /^(head|tail|sort|uniq|wc|cut|tr|less|more|Select-Object|select|Format-Table|ft|Format-List|fl|Out-String|Sort-Object|Measure-Object|Where-Object|ForEach-Object|Out-Host)\b/i;

/**
 * Like `classifyCommand`, but also recognises commands that only read or search files. Every invoked program
 * must be a reader/searcher (or an output filter after one); anything else keeps it a plain command.
 */
export function classifyShell(command: string): EventKind {
  const kind = classifyCommand(command);
  if (kind !== 'command.run') return kind;
  const segs = segments(command);
  if (!segs.length) return kind;
  let reads = 0, searches = 0;
  for (const [i, s] of segs.entries()) {
    if (i > 0 && FILTER.test(s)) continue;
    if (READ.test(s)) reads++;
    else if (SEARCH.test(s)) searches++;
    else return kind;
  }
  return searches ? 'file.search' : reads ? 'file.read' : kind;
}

/** Files named by read commands (`cat a b`, `Get-Content -LiteralPath 'x'`, `sed -n 1,80p f`), best effort. */
export function readTargets(command: string): string[] {
  const out: string[] = [];
  for (const s of segments(command)) {
    if (!READ.test(s)) continue;
    const words = s.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
    for (const w of words.slice(/^sed$/i.test(words[0] ?? '') ? 2 : 1)) {
      const v = w.replace(/^['"]|['"]$/g, '');
      if (!v || v.startsWith('-') || /^\d+$/.test(v) || /^\d*,?\d*p$/.test(v) || v === '>' || v.startsWith('$')) continue;
      out.push(v);
    }
  }
  return [...new Set(out)];
}
