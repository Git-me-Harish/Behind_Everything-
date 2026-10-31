/**
 * Secret redaction, applied before anything is persisted or sent to the UI.
 * Each rule replaces only the secret part so the surrounding context stays readable.
 */
const SECRET_NAME = '(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|credential|private[_-]?key|access[_-]?key)';

const RULES: Array<{ rule: string; re: RegExp; keep?: number }> = [
  { rule: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { rule: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { rule: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { rule: 'openai_key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/g },
  { rule: 'github_token', re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { rule: 'aws_key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: 'google_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { rule: 'stripe_key', re: /\b[rs]k_(live|test)_[A-Za-z0-9]{16,}/g },
  // Group 1 is kept, the rest is replaced.
  { rule: 'bearer', re: /(\b(?:Bearer|Basic|token)\s+)[A-Za-z0-9._~+/=-]{12,}/gi, keep: 1 },
  { rule: 'url_credentials', re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi, keep: 1 },
  // Env-style `API_KEY=value` (no spaces) and quoted literals `password: "value"`; code like `token = getToken()` is left alone.
  { rule: 'assignment', re: new RegExp(`(\\b[\\w.-]*${SECRET_NAME}[\\w.-]*=)(?!\\[REDACTED)[^\\s"'\`;&|]{6,}`, 'gi'), keep: 1 },
  { rule: 'assignment', re: new RegExp(`(\\b[\\w.-]*${SECRET_NAME}[\\w.-]*["']?\\s*[:=]\\s*["'])(?!\\[REDACTED)[^"'\\s]{6,}(?=["'])`, 'gi'), keep: 1 },
];

export interface Redaction { path: string; rule: string }

export function redactString(text: string, path = '', out: Redaction[] = []): string {
  let result = text;
  for (const { rule, re, keep } of RULES) {
    result = result.replace(re, (...m: string[]) => {
      out.push({ path, rule });
      return (keep ? m[keep] : '') + `[REDACTED:${rule}]`;
    });
  }
  return result;
}

/** Deep-redacts strings in a JSON-like value. */
export function redactValue<T>(value: T, path = '', out: Redaction[] = []): T {
  if (typeof value === 'string') return redactString(value, path, out) as T;
  if (Array.isArray(value)) return value.map((v, i) => redactValue(v, `${path}[${i}]`, out)) as T;
  if (value && typeof value === 'object') {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) res[k] = redactValue(v, path ? `${path}.${k}` : k, out);
    return res as T;
  }
  return value;
}

/** Keeps payloads small: tool outputs and file contents can be megabytes. */
export function truncate(text: string, max = 4000): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

/** Like `truncate`, but keeps the end too: test runners and compilers print their verdict last. */
export function clip(text: string, max = 4000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 4);
  return `${text.slice(0, head)}\n… [${text.length - max} chars omitted] …\n${text.slice(text.length - (max - head))}`;
}
