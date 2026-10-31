import { ChevronDown, ChevronRight, FileSearch2, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { SessionState, ZoneId } from '../../../src/core/state.ts';
import { turnNumbers, type Activity } from '../lib/activities.ts';
import { clock, dateTime, duration } from '../lib/format.ts';
import { KIND, PHASE_LABEL, SOURCE_INFO, ZONE } from '../lib/meta.ts';
import { getJson, store, useApp, useFullEvent } from '../lib/store.ts';
import type { Evidence, StoredEvent } from '../lib/types.ts';
import { revealEvent } from './Overview.tsx';
import { SourceTag, StatusIcon, activityStatus, zoneVars } from './ui.tsx';

export function Inspector({ view, activity }: { view: SessionState; activity?: Activity }) {
  const selection = useApp(s => s.selection);
  if (!selection) return null;
  return (
    <aside className="inspector" aria-label="Details">
      {selection.type === 'zone'
        ? <ZoneDetail id={selection.id} view={view} />
        : activity
          ? <ActivityDetail a={activity} view={view} />
          : <Closeable title="Not available"><p className="muted">This event is not in the current view. It may be filtered out or after the replay position.</p></Closeable>}
    </aside>
  );
}

function Closeable({ title, kicker, children }: { title: ReactNode; kicker?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="inspector-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          {kicker && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>{kicker}</div>}
          <h2>{title}</h2>
        </div>
        <button className="icon-btn ghost" onClick={() => store.clearSelection()} aria-label="Close details" title="Close (Esc)"><X size={16} /></button>
      </div>
      <div className="inspector-body">{children}</div>
    </>
  );
}

function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="block-title"><span className="section-title">{title}</span>{extra}</div>
      {children}
    </section>
  );
}

// ── Activity ────────────────────────────────────────────────────────────────

function ActivityDetail({ a, view }: { a: Activity; view: SessionState }) {
  const events = useApp(s => s.events);
  const turn = a.turn_id ? turnNumbers(events).get(a.turn_id) : undefined;
  const meta = KIND[a.kind];
  const status = activityStatus(a);
  // The list holds light events; the inspector shows the full record (outputs, diffs, texts).
  const startEvent = useFullEvent(a.start);
  const resultEvent = useFullEvent(a.result);
  const start = startEvent?.payload ?? {};
  const result = resultEvent?.payload ?? {};
  const agent = view.agents[a.agent_id];
  const redactions = [a.start, a.result, ...a.related].flatMap(e => e?.redactions ?? []);
  const command = typeof start.command === 'string' ? start.command : a.start.resources?.find(r => r.type === 'command')?.ref;

  return (
    <Closeable
      title={a.summary}
      kicker={<>
        <span className="tag">{meta.label}</span>
        {status !== 'none' && <span className="tag" style={{ gap: 4 }}><StatusIcon status={status} />{a.status === 'started' ? 'running' : a.status}</span>}
        <SourceTag source={a.source_class} />
      </>}
    >
      <dl className="kv">
        <dt>Started</dt><dd title={dateTime(a.ts)}>{clock(a.ts)}</dd>
        {a.end_ts && <><dt>Finished</dt><dd>{clock(a.end_ts)}{a.duration_ms !== undefined ? ` · ${duration(a.duration_ms)}` : ''}</dd></>}
        {agent && <><dt>Agent</dt><dd>{agent.label}{agent.parent ? ' (subagent)' : ''}</dd></>}
        {turn && <><dt>Turn</dt><dd>{turn}</dd></>}
        {a.tool && <><dt>Tool</dt><dd className="mono">{a.tool}</dd></>}
        {a.result?.exit_code !== undefined && <><dt>Exit code</dt><dd className="mono" style={{ color: a.result.exit_code ? 'var(--error)' : undefined }}>{a.result.exit_code}</dd></>}
        {a.result?.error_category && <><dt>Failure</dt><dd>{a.result.error_category.replace(/_/g, ' ')}</dd></>}
        {a.files.length > 0 && <><dt>Files</dt><dd><FileLinks files={a.files} /></dd></>}
        {a.start.resources?.some(r => r.type === 'url') && <><dt>URL</dt><dd className="mono">{a.start.resources.find(r => r.type === 'url')!.ref}</dd></>}
      </dl>

      {a.inferred_failure && (
        <div className="why"><b>Inferred failure.</b> The command exited with code 0, but its output says “{a.inferred_failure}”. This usually means the runner was piped (for example <span className="mono">| tail</span>), so the exit code belongs to the last command in the pipe.</div>
      )}

      {command && a.kind !== 'file.edit' && <Section title="Command"><pre className="code">{command}</pre></Section>}

      <KindDetail a={a} start={start} result={result} />

      {a.related.filter(r => r.kind === 'permission.decision').map(r => (
        <Section key={r.id} title="Permission">
          <div className={`alert ${r.status === 'failed' ? 'warn' : ''}`} style={{ boxShadow: 'none' }}>
            <span>{r.summary}</span>
          </div>
          <dl className="kv" style={{ marginTop: 8 }}>
            {typeof r.payload?.source === 'string' && <><dt>Decided by</dt><dd className="mono">{r.payload.source}</dd></>}
            {typeof r.payload?.reason === 'string' && <><dt>Reason</dt><dd className="mono">{r.payload.reason}</dd></>}
            {typeof r.payload?.category === 'string' && <><dt>Category</dt><dd className="mono">{r.payload.category}</dd></>}
            {typeof r.payload?.intention === 'string' && <><dt>Asked to</dt><dd>{r.payload.intention}</dd></>}
            {typeof r.payload?.feedback === 'string' && <><dt>Your note</dt><dd>{r.payload.feedback}</dd></>}
          </dl>
        </Section>
      ))}

      {a.related.some(r => r.kind === 'file.edit') && (
        <Section title="Files this command changed">
          <FileLinks files={a.related.flatMap(r => (r.kind === 'file.edit' ? r.resources?.map(x => x.ref) ?? [] : []))} />
        </Section>
      )}

      {redactions.length > 0 && (
        <div className="why">{redactions.length} value{redactions.length > 1 ? 's were' : ' was'} redacted before storage ({[...new Set(redactions.map(r => r.rule))].join(', ')}).</div>
      )}

      <Section title="Evidence">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <EvidenceView event={a.start} label={a.result ? 'Call record' : 'Record'} />
          {a.result && <EvidenceView event={a.result} label="Result record" />}
          {a.start.correlation?.call_id && <span className="muted mono" style={{ fontSize: 11 }}>call id {a.start.correlation.call_id}</span>}
        </div>
      </Section>
    </Closeable>
  );
}

function KindDetail({ a, start, result }: { a: Activity; start: Record<string, unknown>; result: Record<string, unknown> }) {
  const output = str(result.output);
  const stderr = str(result.stderr);
  switch (a.kind) {
    case 'file.edit': {
      const patch = Array.isArray(result.patch) ? (result.patch as string[]) : undefined;
      return (
        <Section title="Diff" extra={<span className="mono" style={{ fontSize: 11.5 }}><span className="plus">+{num(result.added)}</span> <span className="minus">−{num(result.removed)}</span>{result.op === 'create' ? ' · new file' : ''}</span>}>
          {patch ? <Diff lines={patch} /> : a.status === 'started'
            ? <p className="muted">Edit in progress…</p>
            : a.status === 'failed' ? <pre className="code">{output}</pre>
            : <p className="muted">The diff for this edit was not captured.</p>}
        </Section>
      );
    }
    case 'assistant.message': case 'user.prompt':
      return <Section title="Text"><div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.55 }}>{str(start.text) || a.summary}</div></Section>;
    case 'assistant.reasoning':
      return (
        <Section title="Reasoning" extra={<SourceTag source="unavailable" />}>
          <div className="why">The model reasoned here{a.duration_ms ? ` for ${duration(a.duration_ms)}` : ''}. Its content is not shown: Behind Everything visualises what agents do, never their private reasoning.</div>
        </Section>
      );
    case 'plan.update': {
      const todos = Array.isArray(start.todos) ? (start.todos as Array<{ text: string; status: string }>) : undefined;
      if (todos) return <Section title={`Plan · ${todos.filter(t => t.status === 'completed').length}/${todos.length} done`}><PlanList items={todos} /></Section>;
      if (str(start.plan)) return <Section title="Proposed plan"><div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5 }}>{str(start.plan)}</div></Section>;
      return <Section title="Task"><p>{str(start.subject) || a.summary}</p>{str(start.description) && <p className="muted">{str(start.description)}</p>}</Section>;
    }
    case 'user.question':
      return (
        <>
          <Section title="Asked">{(Array.isArray(start.questions) ? (start.questions as string[]) : [a.summary]).map((q, i) => <p key={i} style={{ margin: '0 0 6px' }}>{q}</p>)}</Section>
          <Section title="Answer">{a.result ? <pre className="code">{output}</pre> : <p className="muted">Waiting for your answer…</p>}</Section>
        </>
      );
    case 'subagent.start': case 'subagent.end':
      return (
        <>
          <dl className="kv">
            {str(start.subagent_type) && <><dt>Type</dt><dd className="mono">{str(start.subagent_type)}</dd></>}
            {typeof result.tool_uses === 'number' && <><dt>Tool calls</dt><dd>{result.tool_uses}</dd></>}
            {typeof result.tokens === 'number' && <><dt>Tokens</dt><dd>{result.tokens}</dd></>}
          </dl>
          {str(start.prompt) && <Section title="Brief"><pre className="code">{str(start.prompt)}</pre></Section>}
          {output && <Section title="Result"><pre className="code">{output}</pre></Section>}
          {typeof result.agent_id === 'string' && <button className="link" onClick={() => store.setFilter({ agent: result.agent_id as string })}>Show this subagent’s activity</button>}
        </>
      );
    case 'system.error':
      return <Section title="Error"><pre className="code">{str(start.error) || a.summary}</pre></Section>;
    case 'usage.tokens': case 'session.meta': case 'session.compaction': case 'turn.start': case 'turn.end': case 'session.start': case 'system.unknown':
      return Object.keys(start).length ? <Section title="Details"><pre className="code">{JSON.stringify(start, null, 2)}</pre></Section> : null;
    default:
      return (
        <>
          {start.input !== undefined && <Section title="Input"><pre className="code">{JSON.stringify(start.input, null, 2)}</pre></Section>}
          {typeof result.matches === 'number' && <p className="muted">{result.matches} match{result.matches === 1 ? '' : 'es'}</p>}
          {output && <Section title={a.kind === 'file.read' ? 'Content (excerpt)' : 'Output'}><pre className="code">{output}</pre></Section>}
          {stderr && <Section title="Stderr"><pre className="code">{stderr}</pre></Section>}
          {!a.result && a.status === 'started' && <p className="muted">Still running…</p>}
        </>
      );
  }
}

function Diff({ lines }: { lines: string[] }) {
  return (
    <div className="diff" role="region" aria-label="Diff">
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : undefined}>{l || ' '}</div>
      ))}
    </div>
  );
}

function PlanList({ items }: { items: Array<{ text: string; status: string }> }) {
  return (
    <div>
      {items.map((t, i) => (
        <div key={i} className={`plan-item ${t.status}`}>
          <StatusIcon status={t.status === 'completed' ? 'ok' : t.status === 'in_progress' ? 'running' : 'none'} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function FileLinks({ files }: { files: string[] }) {
  return (
    <div className="file-list">
      {[...new Set(files)].map(f => (
        <button key={f} className="file-item" onClick={() => store.setFilter({ file: f })} title={`Show all activity on ${f}`}>
          <span className="truncate">{f}</span>
        </button>
      ))}
    </div>
  );
}

function EvidenceView({ event, label }: { event: StoredEvent; label: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Evidence | { error: string }>();
  useEffect(() => { setOpen(false); setData(undefined); }, [event.id]);
  const toggle = async () => {
    setOpen(!open);
    if (data || open) return;
    try {
      setData(await getJson<Evidence>(`/api/events/${encodeURIComponent(event.id)}/evidence`));
    } catch (err) {
      setData({ error: String(err).includes('410') ? 'The source transcript has been removed since this was recorded.' : `Could not load the record (${String(err)}).` });
    }
  };
  return (
    <div>
      <button className="icon-btn evidence-btn" onClick={toggle} aria-expanded={open} title={event.evidence ? `${event.evidence.file}, line ${event.evidence.line}` : undefined}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<FileSearch2 size={14} /> {label}
        {event.evidence && <span className="where">line {event.evidence.line}</span>}
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          {!data && <p className="muted">Loading…</p>}
          {data && 'error' in data && <p className="muted">{data.error}</p>}
          {data && 'record' in data && (
            <>
              <p className="muted" style={{ margin: '0 0 6px', fontSize: 11.5 }}>Raw record from <span className="mono">{data.file}</span>, line {data.line}, redacted.</p>
              <pre className="code">{JSON.stringify(data.record, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Zones ───────────────────────────────────────────────────────────────────

function ZoneDetail({ id, view }: { id: ZoneId; view: SessionState }) {
  const z = view.zones[id];
  const meta = ZONE[id];
  const activities = useApp(s => s.activities);
  const files = Object.values(view.files);
  return (
    <Closeable
      title={meta.name}
      kicker={<><span className="badge" style={{ ...zoneVars(id), background: 'var(--zb)' }}>{z.label}</span><SourceTag source={z.source_class} /></>}
    >
      <p className="muted" style={{ margin: 0 }}>{meta.blurb}</p>
      {id === 'mission' && (
        <>
          <dl className="kv">
            <dt>Turns</dt><dd>{view.turn.index}{view.turn.open ? ' (one in progress)' : ''}</dd>
            <dt>Tokens</dt><dd>{view.tokens.input.toLocaleString()} in · {view.tokens.output.toLocaleString()} out · {view.tokens.cache_read.toLocaleString()} cached</dd>
            <dt>Events</dt><dd>{view.event_count.toLocaleString()}</dd>
          </dl>
          <Section title="Agents">
            {Object.values(view.agents).map(a => (
              <div key={a.id} className="plan-item">
                <span style={{ fontWeight: 600 }}>{a.label}</span>
                <span className="tag">{a.phase_source === 'inferred' ? '~ ' : ''}{PHASE_LABEL[a.phase]}</span>
                {a.phase_source === 'inferred' && <Why ids={a.phase_evidence} />}
              </div>
            ))}
          </Section>
        </>
      )}
      {id === 'explorer' && (
        <Section title={`Files read · ${files.filter(f => f.reads).length}`} extra={<span className="muted">{view.searches} searches</span>}>
          <FileTable rows={files.filter(f => f.reads).sort((a, b) => b.reads - a.reads)} right={f => `${f.reads}×`} />
        </Section>
      )}
      {id === 'planning' && (
        <>
          {view.plan.items.length ? <Section title="Current plan"><PlanList items={view.plan.items} /></Section> : <p className="muted">No plan or todo list has been written in this session.</p>}
          {view.plan.proposals > 0 && <p className="muted">{view.plan.proposals} plan{view.plan.proposals > 1 ? 's' : ''} proposed via plan mode.</p>}
        </>
      )}
      {(id === 'implementation' || id === 'review') && (
        <Section title={`Files changed · ${files.filter(f => f.edits).length}`}>
          <FileTable rows={files.filter(f => f.edits).sort((a, b) => b.added + b.removed - (a.added + a.removed))} right={f => <><span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span> · {f.edits} edit{f.edits > 1 ? 's' : ''}</>} />
        </Section>
      )}
      {id === 'review' && <Delivery view={view} />}
      {id === 'lab' && (
        <>
          <dl className="kv">
            <dt>Tests</dt><dd>{view.tests.runs} runs · {view.tests.passed} passed · {view.tests.failed} failed{view.tests.last ? ` · last ${view.tests.last}` : ''}</dd>
            <dt>Checks</dt><dd>{view.builds.runs} runs · {view.builds.passed} passed · {view.builds.failed} failed{view.builds.last ? ` · last ${view.builds.last}` : ''}</dd>
          </dl>
          <RunList items={activities.filter(a => a.category === 'verify').slice(-30).reverse()} />
        </>
      )}
      {id === 'repair' && (
        <>
          <div className="why">
            <b>Inferred.</b> When a test or check fails, the edits and reruns that follow are treated as repair work until a run passes.
            {' '}{view.repair.active ? `Repair in progress: ${view.repair.reruns} rerun${view.repair.reruns === 1 ? '' : 's'} since the first failure.` : view.repair.failures ? `${view.repair.failures} failure${view.repair.failures > 1 ? 's' : ''} so far, all followed by a passing run.` : 'No failures so far.'}
          </div>
          {view.repair.evidence.length > 0 && <Section title="Evidence"><Why ids={view.repair.evidence} /></Section>}
        </>
      )}
      {id === 'tooling' && (
        <>
          <dl className="kv">
            <dt>Commands</dt><dd>{view.commands.total} run · {view.commands.failed} failed</dd>
            <dt>Dependencies</dt><dd>{view.commands.dependencies} change{view.commands.dependencies === 1 ? '' : 's'}</dd>
            <dt>Web / MCP</dt><dd>{view.web} web · {view.mcp} MCP</dd>
          </dl>
          {Object.keys(view.commands.running).length > 0 && (
            <Section title="Running now">
              {Object.entries(view.commands.running).map(([cid, c]) => (
                <button key={cid} className="file-item" onClick={() => store.select({ type: 'activity', key: `call:${cid}` })}>
                  <span className="truncate">{c.summary}</span><span className="muted">{clock(c.started_at)}</span>
                </button>
              ))}
            </Section>
          )}
          <RunList items={activities.filter(a => a.category === 'run' || a.category === 'external').slice(-30).reverse()} />
        </>
      )}
      {id === 'approval' && (
        <>
          <dl className="kv">
            <dt>Waiting</dt><dd>{Object.keys(view.approvals.pending).length}</dd>
            <dt>Approved by you</dt><dd>{view.approvals.approved}</dd>
            <dt>Blocked</dt><dd>{view.approvals.blocked}</dd>
          </dl>
          <div className="why">Permission prompts that are still open are not written to the assistant’s log until you answer them. Live prompts need the hook bridge (planned).</div>
          <RunList items={activities.filter(a => a.category === 'people').slice(-30).reverse()} />
        </>
      )}
    </Closeable>
  );
}

function Delivery({ view }: { view: SessionState }) {
  const open = view.attention.filter(a => !a.resolved && a.severity !== 'info');
  const verify: string[] = [];
  if (!view.tests.runs) verify.push('No tests were run in this session.');
  else if (view.tests.last === 'failed') verify.push('The most recent test run failed.');
  if (view.builds.last === 'failed') verify.push('The most recent check or build failed.');
  if (view.approvals.blocked) verify.push(`${view.approvals.blocked} action${view.approvals.blocked > 1 ? 's were' : ' was'} blocked. Confirm the agent worked around them correctly.`);
  if (Object.values(view.files).some(f => f.edits > 0)) verify.push('Review the changed files above before committing.');
  return (
    <>
      <Section title="Checks observed">
        <dl className="kv">
          <dt>Tests</dt><dd>{view.tests.runs ? `${view.tests.passed}/${view.tests.runs} passed · last ${view.tests.last}` : 'none observed'}</dd>
          <dt>Checks</dt><dd>{view.builds.runs ? `${view.builds.passed}/${view.builds.runs} passed · last ${view.builds.last}` : 'none observed'}</dd>
        </dl>
      </Section>
      {open.length > 0 && <Section title={`Open issues · ${open.length}`}>{open.map(a => <button key={a.id} className="file-item" onClick={() => a.evidence.at(-1) && revealEvent(a.evidence.at(-1)!)}><span className="truncate">{a.message}</span></button>)}</Section>}
      <Section title="Worth verifying">{verify.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{verify.map(v => <li key={v}>{v}</li>)}</ul> : <p className="muted">Nothing flagged.</p>}</Section>
    </>
  );
}

function FileTable({ rows, right }: { rows: SessionState['files'][string][]; right: (f: SessionState['files'][string]) => ReactNode }) {
  if (!rows.length) return <p className="muted">None yet.</p>;
  return (
    <div className="file-list">
      {rows.slice(0, 200).map(f => (
        <button key={f.path} className="file-item" onClick={() => store.setFilter({ file: f.path, categories: new Set() })} title={`Show all activity on ${f.path}`}>
          <span className="truncate">{f.path}</span><span>{right(f)}</span>
        </button>
      ))}
    </div>
  );
}

function RunList({ items }: { items: Activity[] }) {
  if (!items.length) return null;
  return (
    <Section title="Recent">
      <div className="file-list">
        {items.map(a => (
          <button key={a.key} className="file-item" onClick={() => store.select({ type: 'activity', key: a.key })} style={{ gridTemplateColumns: '20px minmax(0,1fr) auto' }}>
            <StatusIcon status={activityStatus(a)} /><span className="truncate">{a.summary}</span><span className="muted">{clock(a.ts)}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

function Why({ ids }: { ids: string[] }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }} title={SOURCE_INFO.inferred.help}>
      {ids.map((id, i) => <button key={id} className="link" onClick={() => revealEvent(id)}>evidence {i + 1}</button>)}
    </span>
  );
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : 0);
