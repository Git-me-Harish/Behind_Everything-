import { describe, expect, it } from 'vitest';
import { classifyClaudeTool, classifyCommand, classifyShell, readTargets } from '../src/core/classify.js';

describe('classifyCommand', () => {
  it.each([
    ['pnpm test', 'test.run'],
    ['cd "C:/x" && npx vitest run --project unit 2>&1 | tail', 'test.run'],
    ['npm run test:dev-smoke', 'test.run'],
    ['CI=1 FOO="a b" pytest -q', 'test.run'],
    ['python -m pytest tests/', 'test.run'],
    ['go test ./...', 'test.run'],
    ['npx tsc --noEmit -p .', 'build.run'],
    ['pnpm check 2>&1 | tail -80', 'build.run'],
    ['npm install --no-audit && npx tsc --noEmit', 'build.run'],
    ['pnpm install && pnpm test', 'test.run'],
    ['pnpm add zod', 'dependency.change'],
    ['pip install requests', 'dependency.change'],
    ['for i in 1 2 3; do npx vitest run | grep Tests; done; npx tsc --noEmit', 'test.run'],
    ['if [ -f x ]; then pnpm build; fi', 'build.run'],
    ['timeout 60 pytest', 'test.run'],
    ['git status', 'command.run'],
    ['npm view vitest@4 version', 'command.run'],
    ['sed -n 1,60p vitest.config.ts', 'command.run'],
    ['npx prettier --write src', 'command.run'],
  ])('%s → %s', (cmd, kind) => expect(classifyCommand(cmd)).toBe(kind));

  it('ignores heredoc bodies but still sees commands after them', () => {
    expect(classifyCommand("python - <<'EOF'\nimport subprocess  # runs pytest later\nEOF")).toBe('command.run');
    expect(classifyCommand("cat > a.ts <<'EOF'\nmake test\nEOF\nnpx tsc --noEmit")).toBe('build.run');
  });
});

describe('classifyClaudeTool', () => {
  it.each([
    ['Read', {}, 'file.read'],
    ['Grep', {}, 'file.search'],
    ['Write', {}, 'file.edit'],
    ['Agent', {}, 'subagent.start'],
    ['TodoWrite', {}, 'plan.update'],
    ['AskUserQuestion', {}, 'user.question'],
    ['mcp__github__create_pr', {}, 'mcp.call'],
    ['PowerShell', { command: 'dotnet test' }, 'test.run'],
    ['SomethingNew', {}, 'tool.call'],
  ])('%s → %s', (name, input, kind) => expect(classifyClaudeTool(name, input)).toBe(kind));
});

describe('classifyShell (agents that read through the shell)', () => {
  it.each([
    ["Get-Content -LiteralPath 'src/a.ts'", 'file.read'],
    ['cat README.md package.json', 'file.read'],
    ['sed -n 1,120p src/x.py', 'file.read'],
    ['Get-Content src\a.ts | Select-Object -First 80', 'file.read'],
    ['rg --files public src | Select-Object -First 300', 'file.search'],
    ['rg -n "parse" src; Get-Content src/date.ts', 'file.search'],
    ['Get-ChildItem -LiteralPath . -Force', 'file.search'],
    ['git ls-files', 'file.search'],
    ['git status --short', 'command.run'],
    ['cat a.txt | python fix.py', 'command.run'],
    ['pnpm test', 'test.run'],
    ['python -m pytest -q', 'test.run'],
  ])('%s → %s', (cmd, kind) => expect(classifyShell(cmd)).toBe(kind));

  it('names the files a read command reads', () => {
    expect(readTargets("Get-Content -LiteralPath 'src/a b.ts'")).toEqual(['src/a b.ts']);
    expect(readTargets('cat README.md package.json | head -5')).toEqual(['README.md', 'package.json']);
    expect(readTargets('sed -n 1,120p src/x.py')).toEqual(['src/x.py']);
    expect(readTargets('head -n 40 a.ts')).toEqual(['a.ts']);
  });
});
