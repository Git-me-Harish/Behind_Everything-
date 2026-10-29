import { describe, expect, it } from 'vitest';
import { classifyClaudeTool, classifyCommand } from '../src/core/classify.js';

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
