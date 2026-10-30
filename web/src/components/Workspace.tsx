import { Box, LayoutGrid, Rows3 } from 'lucide-react';
import { Component, lazy, Suspense, useCallback, useState, type ReactNode } from 'react';
import type { SessionState } from '../../../src/core/state.ts';
import { ZoneBoard } from './Overview.tsx';

// three.js is loaded only when the map is shown, so the rest of the screen never waits for it.
const WorldView = lazy(() => import('../world/WorldView.tsx'));

type Mode = 'world' | 'board' | 'strip';
const KEY = 'be.workspace';

let webgl2: boolean | undefined;
/** Whether this browser can create a WebGL 2 context at all (checked once, context released at once). */
export function hasWebGL2(): boolean {
  if (webgl2 !== undefined) return webgl2;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    webgl2 = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl2 = false;
  }
  return webgl2;
}

/** A failed chunk download or a crash inside the map falls back to the board instead of blanking the screen. */
class WorldBoundary extends Component<{ onFail: (reason: string) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { this.props.onFail(error instanceof Error ? error.message : String(error)); }
  render() { return this.state.failed ? null : this.props.children; }
}

function readMode(): Mode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'world' || v === 'board' || v === 'strip') return v;
  } catch { /* private mode */ }
  return 'world';
}

export function Workspace({ view }: { view: SessionState }) {
  const [mode, setModeState] = useState<Mode>(readMode);
  const [failure, setFailure] = useState<string | undefined>(() => (hasWebGL2() ? undefined : 'WebGL 2 is not available in this browser'));
  const setMode = (m: Mode) => {
    setModeState(m);
    try { localStorage.setItem(KEY, m); } catch { /* private mode */ }
  };
  const onFail = useCallback((reason: string) => setFailure(reason), []);
  const world = mode === 'world' && !failure;
  const modes: Array<{ id: Mode; label: string; icon: typeof Box }> = [
    { id: 'world', label: '3D', icon: Box }, { id: 'board', label: 'Board', icon: LayoutGrid }, { id: 'strip', label: 'Strip', icon: Rows3 },
  ];

  return (
    <div className="board-wrap">
      <div className="board-head">
        <span className="section-title">Workspace</span>
        <span className="muted board-hint">{world ? 'Click a room or a person for details' : 'Click a zone to focus the timeline on it'}</span>
        <div className="segmented" role="radiogroup" aria-label="Workspace view">
          {modes.map(m => (
            <button key={m.id} role="radio" aria-checked={mode === m.id} onClick={() => setMode(m.id)} disabled={m.id === 'world' && !!failure && !hasWebGL2()} title={m.id === 'world' && failure ? failure : undefined}>
              <m.icon size={13} aria-hidden /> {m.label}
            </button>
          ))}
        </div>
      </div>
      {mode === 'world' && failure && (
        <div className="notice" role="status">
          The 3D map is unavailable — {failure}. Showing the board instead.
          {hasWebGL2() && <> <button className="link" onClick={() => setFailure(undefined)}>Try again</button></>}
        </div>
      )}
      {world ? (
        <WorldBoundary onFail={onFail}>
          <Suspense fallback={<div className="world-loading" aria-busy="true"><span className="muted">Building the workspace…</span></div>}>
            <WorldView view={view} onFail={onFail} />
          </Suspense>
        </WorldBoundary>
      ) : (
        <ZoneBoard view={view} compact={mode === 'strip'} />
      )}
    </div>
  );
}
