import {
  Bot, Brain, CircleHelp, ClipboardList, Cog, FilePen, FileSearch, FileText, Flag, FlaskConical, Globe, Hammer,
  MessageSquare, Package, Plug, ShieldCheck, Sparkles, SquareTerminal, TriangleAlert, User, Wrench, type LucideIcon,
} from 'lucide-react';
import type { EventKind, SourceClass } from '../../../src/core/schema.ts';
import type { AgentState, Phase, ZoneId } from '../../../src/core/state.ts';

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

/** Order is the board layout, row by row — Mission Control in the middle, as the hub. */
export const ZONE_LAYOUT: ZoneId[] = ['explorer', 'planning', 'implementation', 'tooling', 'mission', 'lab', 'approval', 'review', 'repair'];

export const ZONE: Record<ZoneId, ZoneMeta> = {
  mission: { name: 'Mission Control', blurb: 'The request, the conversation and the agents working on it.', categories: ['conversation', 'agents'] },
  explorer: { name: 'Repository Explorer', blurb: 'Files read and searches run while the agent orients itself.', categories: ['explore'] },
  planning: { name: 'Planning Desk', blurb: 'Visible plans and task lists the agent writes for itself.', categories: ['plan'] },
  implementation: { name: 'Implementation', blurb: 'Every file the agent changed, with the diff.', categories: ['edit'] },
  lab: { name: 'Test & Build Lab', blurb: 'Test runs, type checks, linters and builds — and their verdicts.', categories: ['verify'] },
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
  inferred: { label: 'Inferred', help: 'Derived from a pattern of observed events — an estimate, with its evidence linked.' },
  unavailable: { label: 'Unavailable', help: 'The assistant does not expose this, or capture is turned off. Not seeing it does not mean it did not happen.' },
};

/** What the Claude Code log adapter can see — mirrors docs/CAPABILITIES.md. */
export const CAPABILITIES: Array<{ signal: string; state: 'yes' | 'partial' | 'no'; note: string }> = [
  { signal: 'Prompts, turns, assistant messages', state: 'yes', note: 'From the transcript' },
  { signal: 'Reasoning', state: 'partial', note: 'That it happened and how long — never its content' },
  { signal: 'File reads, searches and edits with diffs', state: 'yes', note: 'Read, Glob, Grep, Edit, Write' },
  { signal: 'Commands with exit codes and output', state: 'yes', note: 'Bash / PowerShell' },
  { signal: 'Tests, checks, dependency changes', state: 'yes', note: 'Classified from the command that ran' },
  { signal: 'Plans and todo lists', state: 'yes', note: 'TodoWrite, tasks, plan mode' },
  { signal: 'Questions to you, approvals, blocked actions', state: 'yes', note: 'After they are answered' },
  { signal: 'Subagents', state: 'partial', note: 'Verified on synthetic data only so far' },
  { signal: 'Token usage, API errors, compaction', state: 'yes', note: '' },
  { signal: 'A permission prompt still waiting for you', state: 'no', note: 'Needs the hook bridge (planned)' },
  { signal: 'Session closed', state: 'no', note: 'Needs the hook bridge (planned)' },
];

export const AGENT_COLORS = ['#d97757', '#3b82c4', '#8b5cf6', '#16a34a', '#db2777', '#0891b2', '#ca8a04'];

/** Stable colour per agent: Claude (main) is clay, subagents cycle through the palette by first appearance. */
export function agentColor(agents: Record<string, AgentState>, id: string): string {
  if (id === 'main') return AGENT_COLORS[0]!;
  const subs = Object.keys(agents).filter(a => a !== 'main');
  const i = subs.indexOf(id);
  return AGENT_COLORS[1 + ((i < 0 ? subs.length : i) % (AGENT_COLORS.length - 1))]!;
}
