/**
 * Every word on the product page. Kept in one place so it can be reviewed as copy and checked by tests (claims
 * must match what ships; no em dashes).
 */

export const REPO = 'https://github.com/Git-me-Harish/Behind_Everything-';
export const INSTALL = 'npx behind-everything';
export const HOOKS = 'npx behind-everything hooks install';

export const NAV = [
  { href: '#how', label: 'How it works' },
  { href: '#features', label: 'Features' },
  { href: '#assistants', label: 'Assistants' },
  { href: '#privacy', label: 'Privacy' },
  { href: '#faq', label: 'FAQ' },
];

export const HERO = {
  eyebrow: 'For Claude Code, Codex and GitHub Copilot CLI',
  title: 'See what your AI coding agent is actually doing.',
  lede: 'Behind Everything turns every file your agent reads, every edit, command, test and approval into a live 3D workspace you can watch, search and replay. It runs on your machine, needs no setup, and your code never leaves it.',
  note: 'Node.js 22 or newer · Windows, macOS and Linux · Free and open source',
  caption: 'The real renderer, playing a scripted session with all three assistants.',
};

export const ASSISTANTS = [
  { id: 'claude-code', name: 'Claude Code', mascot: 'Claude, the pixel crab', where: 'CLI and IDE extensions', reads: '~/.claude/projects' },
  { id: 'codex', name: 'OpenAI Codex', mascot: 'Codex, the plush cloud in a beret', where: 'CLI and VS Code extension', reads: '~/.codex/sessions' },
  { id: 'copilot-cli', name: 'GitHub Copilot CLI', mascot: 'Copilot, the goggled head', where: 'Terminal, and VS Code when it hosts the CLI', reads: '~/.copilot/session-state' },
] as const;

export const STEPS = [
  { title: 'Run one command', body: 'It starts a small server on 127.0.0.1 and opens your browser. Nothing to configure, no account to create.', code: INSTALL },
  { title: 'Work as you always do', body: 'Use Claude Code, Codex or Copilot in any project, in the terminal or in VS Code. Behind Everything reads the logs they already write.', code: 'claude  ·  codex  ·  copilot' },
  { title: 'Watch it happen, live', body: 'Every action appears within a moment: the agent walks to the room of what it is doing, the timeline fills in, and anything waiting for you is flagged.', code: 'http://127.0.0.1:47821' },
];

/** `size`: the screenshot's crop in CSS pixels (it is stored at twice that). */
export interface Feature { id: string; title: string; body: string; points: string[]; shot: string; size: [number, number]; alt: string }

export const FEATURES: Feature[] = [
  {
    id: 'workspace', title: 'A live 3D workspace',
    body: 'Nine rooms for the kinds of work an agent does. Each agent walks to the room of what it is doing right now, and the furniture is real data.',
    points: ['Books are files read, lit monitors are files changed, test tubes are verdicts', 'Every room has a live status you can click into', 'Smooth on integrated graphics; idle costs nothing'],
    shot: 'workspace', size: [1168, 760], alt: 'The 3D workspace with rooms, status labels and Claude at work',
  },
  {
    id: 'waiting', title: 'Know the moment it needs you',
    body: 'Approvals and questions waiting for you are flagged in every session, not just the one on screen.',
    points: ['A pill in the sessions list and a count in the tab title', 'Optional desktop notifications that open the session', 'Copilot prompts appear live; Claude Code and Codex with an optional hook'],
    shot: 'waiting', size: [1010, 640], alt: 'Copilot waiting at the Approval Gate, with the session marked Waiting for you',
  },
  {
    id: 'inspector', title: 'Every action, with its evidence',
    body: 'A timeline grouped by turn, with each tool call paired with its result. Open any row for the full story.',
    points: ['The actual diff of every edit', 'Commands with exit codes, duration and output', 'The raw log record behind each event, redacted'],
    shot: 'inspector', size: [1148, 800], alt: 'The inspector showing the diff of an edit next to the timeline',
  },
  {
    id: 'replay', title: 'Replay any session',
    body: 'Drag the scrubber or press play. The whole screen shows the session exactly as it was at that moment, map included.',
    points: ['Play at 1×, 4×, 16× or 64×', 'Step one event at a time', 'Jump from any warning straight to its evidence'],
    shot: 'replay', size: [1168, 848], alt: 'A session being replayed, with the scrubber part way through',
  },
  {
    id: 'honest', title: 'Honest by design',
    body: 'Every signal says how it is known: read directly, inferred from a pattern, or not exposed by the assistant at all.',
    points: ['Inferred things are dashed and link to their evidence', 'A coverage panel lists what each assistant does and does not record', 'Unrecognised log records are counted, never hidden'],
    shot: 'coverage', size: [640, 765], alt: 'The coverage panel listing what Copilot records and what it does not',
  },
];

export const PRIVACY = [
  { title: 'Runs on your machine', body: 'A local server bound to 127.0.0.1. It refuses requests from other hosts and web pages.' },
  { title: 'Read-only', body: 'It reads the logs your assistant already writes. It never changes them, and never talks to your agent.' },
  { title: 'Secrets redacted', body: 'Known API keys, tokens, private keys and passwords are scrubbed before anything is stored or shown.' },
  { title: 'No account, no telemetry', body: 'Nothing to sign up for, and nothing is sent anywhere. The page and fonts are served locally.' },
  { title: 'Never sees reasoning', body: 'It records that the model reasoned, never what it thought.' },
  { title: 'Open source', body: 'Apache-2.0. Read every line of what runs on your machine.' },
];

export type Support = 'yes' | 'partial' | 'hook' | 'no';

export const MATRIX: Array<{ signal: string; claude: Support; codex: Support; copilot: Support; note?: string }> = [
  { signal: 'Prompts, turns and messages', claude: 'yes', codex: 'yes', copilot: 'yes' },
  { signal: 'File reads, searches and edits with diffs', claude: 'yes', codex: 'yes', copilot: 'yes' },
  { signal: 'Commands with exit codes and output', claude: 'yes', codex: 'yes', copilot: 'yes' },
  { signal: 'Tests, checks and dependency changes', claude: 'yes', codex: 'yes', copilot: 'yes' },
  { signal: 'Plans and todo lists', claude: 'yes', codex: 'partial', copilot: 'yes', note: 'Codex plans are verified on synthetic sessions only so far.' },
  { signal: 'Questions to you, approvals and blocked actions', claude: 'yes', codex: 'partial', copilot: 'yes', note: 'Codex does not log approvals; an escalated command that ran is shown as approved, marked inferred.' },
  { signal: 'Approval prompts while they wait', claude: 'hook', codex: 'hook', copilot: 'yes', note: 'Claude Code and Codex write an approval only once answered; the optional hook shows it while it waits.' },
  { signal: 'Subagents', claude: 'partial', codex: 'no', copilot: 'partial', note: 'Verified on synthetic sessions; Codex does not log subagents yet.' },
  { signal: 'Token usage', claude: 'yes', codex: 'yes', copilot: 'no', note: 'Copilot only logs session totals, so they are not shown rather than shown wrong.' },
  { signal: 'Reasoning content', claude: 'no', codex: 'no', copilot: 'no', note: 'Never shown, by design. Only that reasoning happened.' },
];

export const FAQ = [
  { q: 'Is it free?', a: 'Yes. Behind Everything is open source under the Apache-2.0 licence, with no paid tier and no account.' },
  { q: 'Does my code or my conversation leave my machine?', a: 'No. Everything runs locally on 127.0.0.1, nothing is uploaded, and there is no telemetry. Secrets are redacted before anything is stored.' },
  { q: 'Do I have to change how I use my agent?', a: 'No. It reads the session logs Claude Code, Codex and Copilot CLI already write. Keep using them exactly as you do, in the terminal or in VS Code.' },
  { q: 'Will it slow my agent down?', a: 'No. It only reads log files as they grow. The optional hook runs in the background, gives up after a second and never answers a prompt for you.' },
  { q: 'What do I need?', a: 'Node.js 22 or newer on Windows, macOS or Linux, and a recent browser with WebGL 2 for the 3D view. Without WebGL it shows a flat board instead.' },
  { q: 'What is the optional hook?', a: 'Claude Code and Codex only log an approval after you answer it. Run "npx behind-everything hooks install" to see their prompts while they wait. It backs up your config first, and "hooks uninstall" removes exactly what it added.' },
  { q: 'What happens when an assistant changes its log format?', a: 'Records it does not recognise are counted and shown in the coverage panel instead of silently dropped, so gaps are visible and the adapter can be updated.' },
  { q: 'Can my team use it?', a: 'Today it is a personal, local tool: each person runs it on their own machine. Sharing sessions with a team is on the roadmap.' },
  { q: 'How do I stop or remove it?', a: 'Press Ctrl+C to stop it. To remove its data, delete the ~/.behind-everything folder. If you installed the hook, run "npx behind-everything hooks uninstall" first.' },
];

export const CLOSING = {
  title: 'Watch your agent work.',
  body: 'One command, and every session you run from now on is something you can see.',
};
