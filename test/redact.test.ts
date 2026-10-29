import { describe, expect, it } from 'vitest';
import { redactString, redactValue, type Redaction } from '../src/core/redact.js';

// Built at runtime so the repository itself never contains secret-shaped literals.
const fake = (prefix: string, n = 36) => prefix + 'x1Y2z3'.repeat(Math.ceil(n / 6)).slice(0, n);

describe('redaction', () => {
  it.each([
    ['anthropic', `key ${fake('sk-ant-api03-')}`],
    ['openai', `OPENAI ${fake('sk-proj-')}`],
    ['github', `push with ${fake('ghp_')}`],
    ['aws', 'AKIAABCDEFGHIJKLMNOP'],
    ['jwt', `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${fake('', 20)}`],
    ['bearer', `curl -H "Authorization: Bearer ${fake('', 30)}"`],
    ['assignment', 'DATABASE_PASSWORD=hunter2hunter2'],
    ['url', 'postgres://admin:s3cretpass@db:5432/app'],
  ])('%s', (_name, text) => {
    const out: Redaction[] = [];
    const red = redactString(text, 'x', out);
    expect(red).toContain('[REDACTED:');
    expect(out.length).toBeGreaterThan(0);
  });

  it('keeps context around the secret', () => {
    expect(redactString('DATABASE_PASSWORD=hunter2hunter2 node app')).toBe('DATABASE_PASSWORD=[REDACTED:assignment] node app');
    expect(redactString('postgres://admin:s3cretpass@db/app')).toBe('postgres://admin:[REDACTED:url_credentials]@db/app');
  });

  it('leaves ordinary text alone', () => {
    for (const t of ['pnpm test', 'const token = getToken();', 'git commit -m "fix password reset flow"', 'see https://example.com/docs']) {
      expect(redactString(t)).toBe(t);
    }
  });

  it('walks nested values and records paths', () => {
    const out: Redaction[] = [];
    const v = redactValue({ a: [{ cmd: `X ${fake('ghp_')}` }], n: 3 }, '', out);
    expect(JSON.stringify(v)).not.toContain('ghp_');
    expect(out).toEqual([{ path: 'a[0].cmd', rule: 'github_token' }]);
  });
});

describe('assignment rule', () => {
  it.each([
    ['GITHUB_TOKEN=abcdef123456 gh pr list', 'GITHUB_TOKEN=[REDACTED:assignment] gh pr list'],
    ['{"apiKey": "abcdef123456"}', '{"apiKey": "[REDACTED:assignment]"}'],
    ["password: 'hunter2hunter2'", "password: '[REDACTED:assignment]'"],
    ['const password = process.env.PASSWORD;', 'const password = process.env.PASSWORD;'],
  ])('%s', (input, expected) => expect(redactString(input)).toBe(expected));
});
