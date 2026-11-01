import {
  Bot, Brain, CircleHelp, ClipboardList, Cog, FilePen, FileSearch, FileText, Flag, FlaskConical, Globe, Hammer,
  MessageSquare, Package, Plug, ShieldCheck, Sparkles, SquareTerminal, TriangleAlert, User, Wrench, type LucideIcon,
} from 'lucide-react';
import type { EventKind, SourceClass } from '../../../src/core/schema.ts';
import type { AgentState, Phase, ZoneId } from '../../../src/core/state.ts';
import { MASCOTS, mascotFor, type MascotId } from '../world/mascots.ts';

export type Category = 'conversation' | 'explore' | 'plan' | 'edit' | 'verify' | 'run' | 'external' | 'people' | 'agents' | 'system';

export const CATEGORIES: Array<{ id: Category; label: string }> = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'explore', label: 'Explore' },
  { id: 'plan', label: 'Plan' },
  { id: 'edit', label: 'Edits' },
  { id: 'verify', label: 'Tests & checks' },
  { id: 'run', label: 'Commands' },
  { id: 'external', label: 'Web & tools' },
  { id: 'people', label: 'You' },
  { id: 'agents', label: 'Subagents' },
  { id: 'system', label: 'System' },
];

export const KIND: Record<EventKind, { label: string; category: Category; icon: LucideIcon }> = {
  'session.start': { label: 'Session', category: 'system', icon: Flag },
  'session.meta': { label: 'Title', category: 'system', icon: Flag },
  'session.compaction': { label: 'Compaction', category: 'system', icon: Cog },
  'turn.start': { label: 'Turn', category: 'conversation', icon: Flag },
  'turn.end': { label: 'Turn done', category: 'conversation', icon: Flag },
  'user.prompt': { label: 'Prompt', category: 'conversation', icon: User },
  'user.question': { label: 'Question', category: 'people', icon: CircleHelp },
  'assistant.message': { label: 'Message', category: 'conversation', icon: MessageSquare },
  'assistant.reasoning': { label: 'Reasoning', category: 'conversation', icon: Brain },
  'file.read': { label: 'Read', category: 'explore', icon: FileText },
  'file.search': { label: 'Search', category: 'explore', icon: FileSearch },
  'file.edit': { label: 'Edit', category: 'edit', icon: FilePen },
  'command.run': { label: 'Command', category: 'run', icon: SquareTerminal },
  'test.run': { label: 'Test', category: 'verify', icon: FlaskConical },
  'build.run': { label: 'Check', category: 'verify', icon: Hammer },
  'dependency.change': { label: 'Dependency', category: 'run', icon: Package },
  'plan.update': { label: 'Plan', category: 'plan', icon: ClipboardList },
  'permission.decision': { label: 'Permission', category: 'people', icon: ShieldCheck },
  'subagent.start': { label: 'Subagent', category: 'agents', icon: Bot },
  'subagent.end': { label: 'Subagent', category: 'agents', icon: Bot },
  'web.fetch': { label: 'Web', category: 'external', icon: Globe },
  'mcp.call': { label: 'MCP', category: 'external', icon: Plug },
  'tool.call': { label: 'Tool', category: 'external', icon: Wrench },
  'usage.tokens': { label: 'Tokens', category: 'system', icon: Sparkles },
  'system.error': { label: 'Error', category: 'system', icon: TriangleAlert },
  'system.unknown': { label: 'Unknown', category: 'system', icon: CircleHelp },
};

export interface ZoneMeta { name: string; blurb: string; categories: Category[]; failedOnly?: boolean }

/** Order is the board layout, row by row, with Mission Control in the middle, as the hub. */
export const ZONE_LAYOUT: ZoneId[] = ['explorer', 'planning', 'implementation', 'tooling', 'mission', 'lab', 'approval', 'review', 'repair'];

export const ZONE: Record<ZoneId, ZoneMeta> = {
  mission: { name: 'Mission Control', blurb: 'The request, the conversation and the agents working on it.', categories: ['conversation', 'agents'] },
  explorer: { name: 'Repository Explorer', blurb: 'Files read and searches run while the agent orients itself.', categories: ['explore'] },
  planning: { name: 'Planning Desk', blurb: 'Visible plans and task lists the agent writes for itself.', categories: ['plan'] },
  implementation: { name: 'Implementation', blurb: 'Every file the agent changed, with the diff.', categories: ['edit'] },
  lab: { name: 'Test & Build Lab', blurb: 'Test runs, type checks, linters and builds, and their verdicts.', categories: ['verify'] },
  repair: { name: 'Repair Bay', blurb: 'Inferred: after a failed test or check, the edits and reruns that follow.', categories: ['verify', 'edit', 'run'], failedOnly: true },
  tooling: { name: 'Tools & Dependencies', blurb: 'Shell commands, package changes, web and MCP calls.', categories: ['run', 'external'] },
  approval: { name: 'Approval Gate', blurb: 'Questions for you, your approvals, and actions that were blocked.', categories: ['people'] },
  review: { name: 'Review & Delivery', blurb: 'What changed, what was verified, and what still needs your eyes.', categories: ['edit', 'verify'] },
};

export const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Idle', thinking: 'Thinking', exploring: 'Exploring', planning: 'Planning', implementing: 'Implementing',
  testing: 'Testing', repairing: 'Repairing', running: 'Running', researching: 'Researching', delegating: 'Delegating',
  awaiting_input: 'Waiting for you', delivering: 'Delivered', done: 'Done',
};

export const SOURCE_INFO: Record<SourceClass, { label: string; help: string }> = {
  observed: { label: 'Observed', help: 'Read directly from the assistant’s own record of what happened.' },
  inferred: { label: 'Inferred', help: 'Derived from a pattern of observed events: an estimate, with its evidence linked.' },
  unavailable: { label: 'Unavailable', help: 'The assistant does not expose this, or capture is turned off. Not seeing it does not mean it did not happen.' },
};

/** `hook`: captured once the opt-in hook bridge is installed for this assistant. */
export interface Capability { signal: string; state: 'yes' | 'partial' | 'no'; note: string; hook?: boolean }

const HOOK_NOTE = 'Not in the log until answered. Opt in to the hook bridge: pnpm hooks install';

/** What the Claude Code log adapter can see; mirrors docs/CAPABILITIES.md. */
const CLAUDE_CAPABILITIES: Capability[] = [
  { signal: 'Prompts, turns, assistant messages', state: 'yes', note: 'From the transcript' },
  { signal: 'Reasoning', state: 'partial', note: 'That it happened and how long, never its content' },
  { signal: 'File reads, searches and edits with diffs', state: 'yes', note: 'Read, Glob, Grep, Edit, Write' },
  { signal: 'Commands with exit codes and output', state: 'yes', note: 'Bash / PowerShell' },
  { signal: 'Tests, checks, dependency changes', state: 'yes', note: 'Classified from the command that ran' },
  { signal: 'Plans and todo lists', state: 'yes', note: 'TodoWrite, tasks, plan mode' },
  { signal: 'Questions to you, approvals, blocked actions', state: 'yes', note: 'Questions as they are asked; approvals once answered' },
  { signal: 'Subagents', state: 'partial', note: 'Verified on synthetic data only so far' },
  { signal: 'Token usage, API errors, compaction', state: 'yes', note: '' },
  { signal: 'A permission prompt still waiting for you', state: 'no', note: HOOK_NOTE, hook: true },
  { signal: 'Session closed', state: 'no', note: 'Not recorded in the transcript' },
];

/** What the Codex log adapter can see; mirrors docs/CAPABILITIES.md. */
const CODEX_CAPABILITIES: Capability[] = [
  { signal: 'Prompts, turns, assistant messages', state: 'yes', note: 'From the rollout log' },
  { signal: 'Reasoning', state: 'partial', note: 'That it happened; Codex stores the content encrypted' },
  { signal: 'File reads and searches', state: 'yes', note: 'Recognised from the shell commands Codex runs (Get-Content, cat, rg…)' },
  { signal: 'File edits with diffs', state: 'yes', note: 'apply_patch and Codex’s own file-change records' },
  { signal: 'Commands with exit codes, duration and output', state: 'yes', note: 'Including background processes and code-mode cells' },
  { signal: 'Tests, checks, dependency changes', state: 'yes', note: 'Classified from the command that ran' },
  { signal: 'Plans', state: 'partial', note: 'update_plan, verified on synthetic data only so far' },
  { signal: 'Approvals', state: 'partial', note: 'Commands that asked to leave the sandbox: approval inferred when they ran, refusals observed' },
  { signal: 'Subagents', state: 'no', note: 'Not seen in Codex logs yet' },
  { signal: 'Token usage, compaction', state: 'yes', note: '' },
  { signal: 'A permission prompt still waiting for you', state: 'no', note: HOOK_NOTE, hook: true },
];

/** What the Copilot CLI log adapter can see; mirrors docs/CAPABILITIES.md. */
const COPILOT_CAPABILITIES: Capability[] = [
  { signal: 'Prompts, turns, assistant messages', state: 'yes', note: 'From the session log' },
  { signal: 'Reasoning', state: 'partial', note: 'That it happened, never its content' },
  { signal: 'File reads, searches and edits with diffs', state: 'yes', note: 'view, rg, glob, apply_patch, edit, create' },
  { signal: 'Commands with exit codes and output', state: 'yes', note: 'Including commands Copilot left running in the background' },
  { signal: 'Tests, checks, dependency changes', state: 'yes', note: 'Classified from the command that ran, plus VS Code’s runTests' },
  { signal: 'Plans and todo lists', state: 'yes', note: 'Copilot’s todo table, followed through its sql tool' },
  { signal: 'Questions to you, approvals, blocked actions', state: 'yes', note: 'Your decisions; Copilot’s routine policy approvals are not shown' },
  { signal: 'A permission prompt still waiting for you', state: 'yes', note: 'Live: Copilot logs the request as it asks' },
  { signal: 'Subagents', state: 'partial', note: 'Verified on synthetic data only so far' },
  { signal: 'MCP and web calls, compaction, errors', state: 'yes', note: '' },
  { signal: 'Token usage', state: 'no', note: 'Copilot logs only session totals at shutdown, repeated across resumes' },
];

export interface AssistantMeta {
  /** Product name, e.g. in "Claude Code 2.1". */
  name: string;
  /** What the main agent is called. */
  agent: string;
  color: string;
  logs: string;
  /** Whether the logs record token usage per call. */
  tokens: boolean;
  capabilities: Capability[];
}

export const ASSISTANTS: Record<string, AssistantMeta> = {
  'claude-code': { name: 'Claude Code', agent: 'Claude', color: '#d97757', logs: 'Claude Code transcripts', tokens: true, capabilities: CLAUDE_CAPABILITIES },
  codex: { name: 'Codex', agent: 'Codex', color: MASCOTS.blob.color!, logs: 'Codex rollout logs', tokens: true, capabilities: CODEX_CAPABILITIES },
  'copilot-cli': { name: 'Copilot CLI', agent: 'Copilot', color: '#8b5cf6', logs: 'Copilot session logs', tokens: false, capabilities: COPILOT_CAPABILITIES },
};

export const assistantMeta = (assistant?: string): AssistantMeta => ASSISTANTS[assistant ?? ''] ?? ASSISTANTS['claude-code']!;

export const AGENT_COLORS = ['#d97757', '#3b82c4', '#8b5cf6', '#16a34a', '#db2777', '#0891b2', '#ca8a04'];

/**
 * Stable colour per agent: the main agent wears its assistant's colour (Claude clay, Codex blue, Copilot violet);
 * subagents cycle through the rest of the palette by first appearance, never in the main agent's colour.
 */
export function agentColor(agents: Record<string, AgentState>, id: string, assistant?: string): string {
  const main = assistantMeta(assistant).color;
  if (id === 'main') return main;
  // A subagent whose mascot has its own colour wears it everywhere (Codex's plush cast).
  const fixed = MASCOTS[mascotOf(agents, id, assistant) as MascotId]?.color;
  if (fixed) return fixed;
  const palette = AGENT_COLORS.slice(1).filter(c => c !== main);
  const subs = Object.keys(agents).filter(a => a !== 'main');
  const i = subs.indexOf(id);
  return palette[(i < 0 ? subs.length : i) % palette.length]!;
}

/** Which mascot an agent is: subagents take their place in the cast by order of appearance, like their colours. */
export function mascotOf(agents: Record<string, AgentState>, id: string, assistant?: string): MascotId | 'clawd' | undefined {
  return mascotFor(assistant ?? 'claude-code', id === 'main', Object.keys(agents).filter(a => a !== 'main').indexOf(id));
}

/** A session opened from a file someone shared (see src/core/share.ts): read-only, removable. */
export const isShared = (sessionId: string) => sessionId.startsWith('shared:');
