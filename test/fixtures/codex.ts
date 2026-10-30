/**
 * Builds synthetic Codex rollout lines that mirror the real record shapes (verified against Codex VS Code
 * rollouts, CLI 0.142 – 0.162) without containing any real user data.
 */
type Json = Record<string, unknown>;

export const CODEX_SESSION = '01a0c0de-0000-7000-8000-00000000c0de';
export const CODEX_CWD = 'C:\\work\\shop';

export class RolloutBuilder {
  lines: Json[] = [];
  private t = Date.parse('2026-10-29T08:00:00.000Z');
  private turn = '';
  private item = 0;

  constructor(private id = CODEX_SESSION, version = '0.162.0') {
    this.rec('session_meta', {
      id, session_id: id, timestamp: new Date(this.t).toISOString(), cwd: CODEX_CWD, originator: 'codex_vscode',
      cli_version: version, source: 'vscode', thread_source: 'user', model_provider: 'openai', base_instructions: 'BASE INSTRUCTIONS',
      git: { branch: 'feature/cart', commit_hash: 'abc123' },
    });
  }

  private rec(type: string, payload: Json) {
    this.t += 1000;
    this.lines.push({ timestamp: new Date(this.t).toISOString(), type, payload });
    return this;
  }
  private event(payload: Json) { return this.rec('event_msg', payload); }
  private response(payload: Json) { return this.rec('response_item', payload); }
  private completed(item: Json) {
    return this.event({ type: 'item_completed', thread_id: this.id, turn_id: this.turn, item: { id: `item-${++this.item}`, ...item }, completed_at_ms: this.t });
  }

  startTurn(turnId: string, prompt: string) {
    this.turn = turnId;
    this.event({ type: 'task_started', turn_id: turnId, started_at: this.t / 1000, model_context_window: 258400 });
    this.rec('turn_context', { turn_id: turnId, cwd: CODEX_CWD, model: 'gpt-5.5', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' } });
    // The injected context arrives as user messages too; the prompt itself is the UserMessage item.
    this.response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] });
    this.response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] });
    return this.completed({ type: 'UserMessage', client_id: 'c1', content: [{ type: 'text', text: prompt, text_elements: [] }] });
  }

  reasoning() { return this.response({ type: 'reasoning', id: `rs_${this.t}`, summary: [], content: null, encrypted_content: 'gAAAA-SECRET-REASONING' }); }

  say(text: string, phase = 'commentary') {
    return this.response({ type: 'message', id: `msg_${this.t}`, role: 'assistant', content: [{ type: 'output_text', text }], phase });
  }

  exec(callId: string, cmd: string, extra: Json = {}) {
    return this.response({ type: 'function_call', id: `fc_${callId}`, name: 'exec_command', arguments: JSON.stringify({ cmd, workdir: CODEX_CWD, ...extra }), call_id: callId });
  }

  output(callId: string, text: string | Json[], type = 'function_call_output') {
    return this.response({ type, id: `fco_${callId}`, call_id: callId, output: text });
  }

  execResult(callId: string, exit: number, out = '', secs = 1.25) {
    return this.output(callId, `Chunk ID: 1a2b3c\nWall time: ${secs} seconds\nProcess exited with code ${exit}\nOriginal token count: 10\nOutput:\n${out}`);
  }

  commandItem(id: string, cmd: string, exit: number, parsed: Json[] = [{ type: 'unknown', cmd }], out = '') {
    return this.completed({
      type: 'CommandExecution', id, command: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoProfile', '-Command', cmd], cwd: CODEX_CWD,
      parsed_cmd: parsed, source: 'unified_exec_startup', status: exit === 0 ? 'completed' : 'failed', exit_code: exit,
      duration: { secs: 2, nanos: 500_000_000 }, aggregated_output: out,
    });
  }

  plan(callId: string, steps: Array<[string, string]>) {
    this.response({ type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: steps.map(([step, status]) => ({ step, status })) }), call_id: callId });
    return this.output(callId, 'Plan updated');
  }

  patch(callId: string, patch: string) {
    return this.response({ type: 'custom_tool_call', id: `ctc_${callId}`, name: 'apply_patch', input: patch, call_id: callId, status: 'completed' });
  }

  fileChange(id: string, changes: Json, status = 'completed') { return this.completed({ type: 'FileChange', id, changes, status }); }

  /** A code-mode cell: a script calling tools. Its commands are reported as `exec-…` CommandExecution items. */
  cell(callId: string, script: string) {
    return this.response({ type: 'custom_tool_call', id: `ctc_${callId}`, name: 'exec', input: script, call_id: callId, status: 'completed' });
  }

  tokens(input: number, cached: number, output: number) {
    return this.event({ type: 'token_count', info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 5 }, total_token_usage: {} }, rate_limits: null });
  }

  endTurn(ms = 30_000) { return this.event({ type: 'task_complete', turn_id: this.turn, duration_ms: ms, last_agent_message: 'done' }); }
  abort() { return this.event({ type: 'turn_aborted', turn_id: this.turn, reason: 'interrupted', duration_ms: 1000 }); }

  raw(type: string, payload: Json) { return this.rec(type, payload); }

  jsonl() { return this.lines.map(l => JSON.stringify(l)).join('\n') + '\n'; }
}

/** A short Codex session: explore, plan, edit, a failing test, a fix through a code-mode cell, a passing test. */
export function codexSession() {
  return new RolloutBuilder()
    .startTurn('turn-1', 'Fix the cart total rounding bug')
    .reasoning()
    .say('Looking at the cart code first.')
    .exec('call_read', "Get-Content -LiteralPath 'src/cart.py'")
    .execResult('call_read', 0, 'def total(items): ...')
    .commandItem('call_read', "Get-Content -LiteralPath 'src/cart.py'", 0, [{ type: 'read', cmd: "Get-Content -LiteralPath 'src/cart.py'", name: 'cart.py', path: 'src/cart.py' }])
    .exec('call_search', 'rg -n "round" src')
    .execResult('call_search', 0, 'src/cart.py:4: round(x, 2)')
    .plan('call_plan', [['Find the rounding bug', 'completed'], ['Fix total()', 'in_progress'], ['Run tests', 'pending']])
    .patch('call_patch', '*** Begin Patch\n*** Update File: src/cart.py\n@@\n-    return round(sum(items), 1)\n+    return round(sum(items), 2)\n*** End Patch')
    .fileChange('call_patch', { [`${CODEX_CWD}\\src\\cart.py`]: { type: 'update', unified_diff: '@@ -3,1 +3,1 @@\n-    return round(sum(items), 1)\n+    return round(sum(items), 2)\n' } })
    .output('call_patch', 'Success. Updated the following files:\nM src/cart.py', 'custom_tool_call_output')
    .exec('call_test1', 'python -m pytest -q', { sandbox_permissions: 'require_escalated', justification: 'Run the test suite' })
    .commandItem('call_test1', 'python -m pytest -q', 1, undefined, '1 failed, 4 passed')
    .execResult('call_test1', 1, '1 failed, 4 passed')
    .reasoning()
    .cell('call_cell', 'const r = await tools.exec_command({"cmd":"python -m pytest -q tests/test_cart.py","workdir":"C:\\\\work\\\\shop"});\ntext(r);')
    .commandItem('exec-1111', 'python -m pytest -q tests/test_cart.py', 0, undefined, '5 passed')
    .output('call_cell', [{ type: 'input_text', text: 'Script completed\nWall time 3.1 seconds\nOutput:\n' }, { type: 'input_text', text: 'Exit code: 0\nWall time: 2.5 seconds\nOutput:\n5 passed' }], 'custom_tool_call_output')
    .fileChange('exec-2222', { [`${CODEX_CWD}\\tests\\test_rounding.py`]: { type: 'add', content: 'def test_round():\n    assert True\n' } })
    .tokens(12_000, 8_000, 900)
    .say('Fixed: totals now round to cents.', 'final_answer')
    .endTurn();
}
