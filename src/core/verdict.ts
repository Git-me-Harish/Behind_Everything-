import type { CanonicalEvent } from './schema.js';

// Failure summaries printed by common runners. "0 failed" never matches.
const TEST_FAILURES: RegExp[] = [
  /\b([1-9]\d*) (?:tests? )?(failed|failing|failures?)\b/i, // vitest, jest, pytest, mocha, rspec
  /^\s*FAIL\b/m,                                         // vitest / jest file headers, go test summary
  /^--- FAIL:/m,                                         // go test
  /test result: FAILED/,                                 // cargo
  /\bTests run:.*Failures: [1-9]/,                       // maven surefire
];
const CHECK_FAILURES: RegExp[] = [
  /\berror TS\d+:/,                                      // tsc
  /✖ \d+ problems? \(([1-9]\d*) errors?/,                // eslint
  /\bFound [1-9]\d* errors?\b/,                          // tsc --build, mypy, ruff
  /^error(\[E\d+\])?:/m,                                 // rustc / cargo
  /\bBuild FAILED\b/i,
];

/**
 * A test or check that exited 0 but whose output reports failures — typically because it was piped
 * (`pnpm test | tail`), so the exit code is the last command's. Returns the matching evidence, or undefined.
 * The verdict is an inference from output text, never presented as observed.
 */
export function inferredFailure(e: Pick<CanonicalEvent, 'kind' | 'status' | 'payload'>): string | undefined {
  if (e.status !== 'succeeded' || (e.kind !== 'test.run' && e.kind !== 'build.run')) return undefined;
  // List-form events carry the verdict precomputed (the output itself is left out).
  if (typeof e.payload?.failure_hint === 'string') return e.payload.failure_hint;
  const output = `${typeof e.payload?.output === 'string' ? e.payload.output : ''}\n${typeof e.payload?.stderr === 'string' ? e.payload.stderr : ''}`;
  for (const re of e.kind === 'test.run' ? TEST_FAILURES : CHECK_FAILURES) {
    const m = re.exec(output);
    if (m) return m[0].trim().slice(0, 80);
  }
  return undefined;
}
