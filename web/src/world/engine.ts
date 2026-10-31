import {
  BoxGeometry, BufferGeometry, Color, CylinderGeometry, DirectionalLight, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, Object3D, OrthographicCamera, Plane, Raycaster, RingGeometry, Scene, SphereGeometry, Vector2,
  Vector3, WebGLRenderer, type Material,
} from 'three';
import { ZONES, type ZoneId, type ZoneStatus } from '../../../src/core/state.ts';
import { BACK, bounds, clampView, fit, mix, onScreen, panBy, RIGHT, sameView, UP, zoomAround, type Bounds, type View, type Viewport } from './camera.ts';
import { buildStatic, clawdGeometry, FLOOR, mascotGeometry, personGeometry, SLOTS, STATUS_SLOT, type ClawdGeometry, type MascotGeometry, type Slot } from './build.ts';
import { INK, MASCOTS, type MascotId } from './mascots.ts';
import { QualityGovernor } from './quality.ts';
import { footprint, ROOM, roomCenter, roomCorners, WALL_H } from './layout.ts';
import type { AgentModel, RoomModel, WorldModel } from './model.ts';
import { retarget, spawn, step, walking, type Walker } from './motion.ts';
import type { Palette } from './palette.ts';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Where a label's foot goes on screen; agents also say where their feet are, so a tag can drop below them. */
export interface LabelPos { x: number; y: number; on: boolean; foot?: number }

export interface WorldHandlers {
  zone(id: ZoneId): void;
  agent(id: string): void;
  /** Screen positions of every label anchor, after each rendered frame. `roomPx` is a room's on-screen width. */
  labels(positions: Map<string, LabelPos>, roomPx: number): void;
  /** The user tried to scroll/drag the embedded map in a way that scrolls the page instead. */
  hint(kind: 'wheel' | 'touch'): void;
  /** The user took the camera (stops following an agent). */
  manual(): void;
  contextLost(lost: boolean): void;
}

export interface UpdateOptions {
  /** Jump instead of animating: seeking, switching sessions, reduced motion. */
  snap: boolean;
  /** Walk faster during fast replay. */
  timeScale: number;
  selectedZone?: ZoneId;
  focusAgent?: string;
}

const DRAG_THRESHOLD = 5;
const AMBIENT_FRAME_MS = 1000 / 30;
const PAD = { x: 18, top: 64, bottom: 18 };
const LABEL_INSET = 2.4;
const BLINK_MS = 140;
/** The mascot is its face: standing still, it turns towards the viewer (the camera sits along +x +z), a little to one side so it keeps its depth. */
const FACE_VIEWER = Math.PI / 4 - 0.45;

type FadeMaterial = MeshBasicMaterial | MeshLambertMaterial;

/** The meshes of one avatar kind, before the shared shadow and selection ring are added. */
interface Body {
  /** What a click on the agent hits. */
  hit: Mesh;
  meshes: Mesh[];
  legs: Mesh[];
  arms: Mesh[];
  eyes?: Mesh;
  shadow: BufferGeometry;
  /** Materials faded together, with their full opacity. */
  fades: Array<[FadeMaterial, number]>;
  /** Geometries owned by this agent alone (the mascot's are shared). */
  owned: BufferGeometry[];
  /** Where the tag floats, above the floor, before scaling. */
  height: number;
  scale: number;
}

interface Person extends Body {
  w: Walker;
  model: AgentModel;
  obj: Group;
  ring: Mesh;
  /** 0..1, for fading in on arrival and out on leaving. */
  alpha: number;
  leaving: boolean;
  stride: number;
  /** Next time this agent blinks (mascot only). */
  blinkAt: number;
  /** Where the body points; eases towards the walking direction or resting pose instead of snapping. */
  facing: number;
}

interface CellRef { glow: boolean; i: number; slot: Slot }

export class World {
  readonly stats = { frames: 0, drawCalls: 0, triangles: 0, fps: 0, dpr: 1, zoom: 0, eventToPixelMs: undefined as number | undefined };
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new OrthographicCamera(-1, 1, 1, -1, 1, 1000);
  private hemi = new HemisphereLight();
  private sun = new DirectionalLight();
  private palette: Palette;
  private building: Mesh;
  private buildingMat = new MeshLambertMaterial({ vertexColors: true });
  private cellsLit: InstancedMesh;
  private cellsGlow: InstancedMesh;
  private refs = {} as Record<ZoneId, CellRef[]>;
  private statusRef = {} as Record<ZoneId, number>;
  private gate = new Group();
  private gateArm: Mesh;
  private gateLamp: Mesh;
  private beacon: Mesh;
  private frames = {} as Record<ZoneId, { solid: Mesh; dashed: Mesh }>;
  private pulseGeo = new RingGeometry(0.8, 1.05, 40).rotateX(-Math.PI / 2);
  private pulses: Array<{ mesh: Mesh; t: number }> = [];
  private people = new Map<string, Person>();
  private clawd?: ClawdGeometry;
  /** Built once per mascot and shared by every agent wearing it. */
  private mascots = new Map<MascotId, MascotGeometry>();
  private blinkTimer = 0;
  private model?: WorldModel;
  private opts: UpdateOptions = { snap: true, timeScale: 1 };
  private lastEvents: Partial<Record<ZoneId, string>> = {};
  private gateAngle = 0;

  private vp: Viewport = { width: 1, height: 1 };
  private view: View = { x: 0, y: 0, zoom: 10 };
  private home: View = { x: 0, y: 0, zoom: 10 };
  private limits = { min: 1, max: 100 };
  private pad = PAD;
  private bounds: Bounds;
  private anim?: { from: View; to: View; t0: number; dur: number };
  private userMoved = false;
  private focused?: ZoneId;
  private hover?: { zone?: ZoneId; agent?: string };

  private raf = 0;
  private dirty = false;
  private last = 0;
  private lastAmbient = 0;
  private fpsWindow: number[] = [];
  private pendingMark?: number;
  private visible = true;
  private disposed = false;
  private reducedMotion: boolean;
  expanded = false;

  private pointers = new Map<number, { x: number; y: number }>();
  private drag?: { x: number; y: number; moved: boolean; id: number };
  private pinch?: { d: number; x: number; y: number };
  private observers: Array<{ disconnect(): void }> = [];
  private quality: QualityGovernor;
  /** When the last frame was drawn, to time frames drawn back to back while something moves. */
  private lastFrame = 0;
  private cleanup: Array<() => void> = [];

  constructor(private canvas: HTMLCanvasElement, private host: HTMLElement, palette: Palette, private on: WorldHandlers, opts: { reducedMotion: boolean }) {
    this.reducedMotion = opts.reducedMotion;
    // Throws when WebGL 2 is unavailable; the caller falls back to the 2D board.
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'default' });
    this.renderer.setClearColor(0x000000, 0);
    this.stats.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(this.stats.dpr);
    this.quality = new QualityGovernor(this.stats.dpr, this.stats.dpr);
    this.palette = palette;
    this.bounds = bounds(footprint());

    this.sun.position.set(0.35, 1, 0.65).multiplyScalar(50);
    this.scene.add(this.hemi, this.sun);
    this.building = new Mesh(buildStatic(palette), this.buildingMat);
    this.building.matrixAutoUpdate = false;
    this.scene.add(this.building);

    // Data-bound props: every slot of every room in two instanced meshes (lit and glowing).
    let lit = 0, glow = 0;
    for (const z of ZONES) {
      this.refs[z] = SLOTS[z].map(slot => ({ glow: slot.glow, i: slot.glow ? glow++ : lit++, slot }));
      this.statusRef[z] = glow++;
    }
    const unit = new BoxGeometry(1, 1, 1);
    this.cellsLit = new InstancedMesh(unit, new MeshLambertMaterial(), lit);
    this.cellsGlow = new InstancedMesh(unit, new MeshBasicMaterial(), glow);
    const m = new Matrix4();
    for (const z of ZONES) {
      const c = roomCenter(z);
      for (const r of this.refs[z]) (r.glow ? this.cellsGlow : this.cellsLit).setMatrixAt(r.i, place(m, r.slot, c.x, c.z));
      this.cellsGlow.setMatrixAt(this.statusRef[z], place(m, STATUS_SLOT, c.x, c.z));
    }
    for (const mesh of [this.cellsLit, this.cellsGlow]) {
      mesh.setColorAt(0, new Color());
      this.scene.add(mesh);
    }

    // Approval Gate barrier and lamp, Repair Bay beacon.
    const a = roomCenter('approval');
    this.gate.position.set(a.x - 0.6, FLOOR + 0.92, a.z + 1.0);
    this.gateArm = new Mesh(new BoxGeometry(4.9, 0.14, 0.14).translate(2.45, 0, 0), new MeshLambertMaterial());
    this.gate.add(this.gateArm);
    this.gateLamp = new Mesh(new SphereGeometry(0.16, 12, 8), new MeshBasicMaterial());
    this.gateLamp.position.set(0, 0.22, 0);
    this.gate.add(this.gateLamp);
    const r = roomCenter('repair');
    this.beacon = new Mesh(new CylinderGeometry(0.2, 0.3, 0.42, 14), new MeshBasicMaterial());
    this.beacon.position.set(r.x - ROOM / 2 + 0.12, WALL_H + 0.29, r.z - ROOM / 2 + 0.12);
    this.scene.add(this.gate, this.beacon);

    for (const z of ZONES) this.frames[z] = this.makeFrames(z);
    this.applyPalette();
    this.listen();
  }

  // ── public API ──────────────────────────────────────────────────────────────

  update(model: WorldModel, opts: UpdateOptions) {
    const first = !this.model;
    const snap = opts.snap || first || this.reducedMotion;
    this.model = model;
    this.opts = opts;
    for (const z of ZONES) this.paintRoom(model.rooms[z]);
    this.paintFrames();
    // An event landing in a room sends a ripple across its floor.
    for (const z of ZONES) {
      const ev = model.rooms[z].last_event;
      if (!snap && ev && ev !== this.lastEvents[z]) this.pulse(z, model.rooms[z].status);
      this.lastEvents[z] = ev;
    }
    const seen = new Set<string>();
    for (const a of model.agents) {
      seen.add(a.id);
      let p = this.people.get(a.id);
      if (!p) {
        // Newcomers appear at Mission Control and walk to work; on a jump they are simply there.
        p = this.addPerson(a, snap ? spawn(a.zone, a.slot) : spawn('mission', 4));
        p.alpha = snap ? 1 : 0;
      } else if (p.model.color !== a.color) {
        this.removePerson(a.id);
        p = this.addPerson(a, p.w);
      }
      p.model = a;
      p.leaving = false;
      retarget(p.w, a.zone, a.slot, { snap, timeScale: opts.timeScale });
    }
    for (const [id, p] of this.people) if (!seen.has(id)) {
      if (snap) this.removePerson(id);
      else p.leaving = true;
    }
    if (opts.selectedZone !== this.focused) {
      this.focused = opts.selectedZone;
      this.focus(opts.selectedZone, !snap);
    }
    this.invalidate();
  }

  /** Where a room's floor centre is on screen, in page coordinates, for tests and tooling. */
  roomOnScreen(z: ZoneId): { x: number; y: number } {
    const c = roomCenter(z);
    return this.toPage(c.x, FLOOR, c.z);
  }

  /** Where an agent's body is on screen, in page coordinates, for tests and tooling. */
  agentOnScreen(id: string): { x: number; y: number } | undefined {
    const p = this.people.get(id);
    if (!p) return undefined;
    const { x, y, z } = p.obj.position;
    return this.toPage(x, y + p.height * 0.35 * p.obj.scale.y, z);
  }

  private toPage(x: number, y: number, z: number) {
    this.applyCamera();
    const v = new Vector3(x, y, z).project(this.camera);
    const r = this.host.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * this.vp.width, y: r.top + ((1 - v.y) / 2) * this.vp.height };
  }

  /** Records when the data behind the next frame arrived, to measure event-to-pixel latency. */
  markArrival(t: number) { this.pendingMark ??= t; }

  setPalette(p: Palette) {
    this.palette = p;
    this.building.geometry.dispose();
    this.building.geometry = buildStatic(p);
    // Snapshot first: re-adding a key while iterating a Map visits it again, forever.
    for (const [id, person] of [...this.people]) {
      this.removePerson(id);
      const fresh = this.addPerson(person.model, person.w);
      Object.assign(fresh, { alpha: person.alpha, leaving: person.leaving, stride: person.stride, blinkAt: person.blinkAt, facing: person.facing });
    }
    this.applyPalette();
    if (this.model) for (const z of ZONES) this.paintRoom(this.model.rooms[z]);
    this.invalidate();
  }

  setReducedMotion(on: boolean) { this.reducedMotion = on; this.invalidate(); }

  zoomBy(factor: number) {
    this.userMoved = true;
    this.on.manual();
    this.animateTo(zoomAround(this.target(), this.vp, factor, this.vp.width / 2, this.vp.height / 2, this.limits), 220);
  }

  resetView() {
    this.userMoved = false;
    this.animateTo(this.focused ? this.roomView(this.focused) : this.home, 450);
  }

  /** Trades resolution for speed (or back), keeping the canvas the same size on screen. */
  private setPixelRatio(dpr: number) {
    this.stats.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.vp.width, this.vp.height, false);
  }

  /** Re-measures after the host changed size (e.g. expanded / collapsed). */
  resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    if (w === this.vp.width && h === this.vp.height) return;
    this.vp = { width: w, height: h };
    this.renderer.setSize(w, h, false);
    Object.assign(this.camera, { left: -w / 2, right: w / 2, top: h / 2, bottom: -h / 2 });
    this.camera.updateProjectionMatrix();
    // Phones get icon-only room labels, so need less room above the building.
    this.pad = w < 520 ? { x: 10, top: 34, bottom: 10 } : PAD;
    this.home = fit(footprint(), this.vp, this.pad);
    // Zoom from a little wider than the whole building to close enough to read a single desk.
    this.limits = { min: this.home.zoom * 0.7, max: Math.max(this.home.zoom * 6, fit(roomCorners('mission'), this.vp, this.pad).zoom * 2.2) };
    this.anim = undefined;
    this.view = this.userMoved ? clampView(this.view, this.bounds, this.limits) : this.focused ? this.roomView(this.focused) : this.home;
    this.invalidate();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.blinkTimer);
    for (const o of this.observers) o.disconnect();
    for (const c of this.cleanup) c();
    for (const id of [...this.people.keys()]) this.removePerson(id);
    if (this.clawd) for (const g of Object.values(this.clawd)) if (g instanceof BufferGeometry) g.dispose();
    for (const m of this.mascots.values()) for (const g of Object.values(m)) if (g instanceof BufferGeometry) g.dispose();
    this.scene.traverse(o => {
      if (o instanceof Mesh) {
        o.geometry.dispose();
        for (const m of [o.material].flat()) m.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // ── painting ────────────────────────────────────────────────────────────────

  private applyPalette() {
    const p = this.palette;
    this.hemi.color.copy(p.sky);
    this.hemi.groundColor.copy(p.ground);
    this.hemi.intensity = p.ambient;
    this.sun.intensity = p.sun;
    (this.gateArm.material as MeshLambertMaterial).color.copy(p.status.warn);
    for (const z of ZONES) {
      (this.frames[z].solid.material as MeshBasicMaterial).color.copy(p.badge[z]);
      (this.frames[z].dashed.material as MeshBasicMaterial).color.copy(p.badge[z]);
    }
  }

  private paintRoom(r: RoomModel) {
    const p = this.palette;
    const m = new Matrix4();
    const c = roomCenter(r.id);
    r.cells.forEach((tone, i) => {
      const ref = this.refs[r.id][i]!;
      const mesh = ref.glow ? this.cellsGlow : this.cellsLit;
      mesh.setMatrixAt(ref.i, tone ? place(m, ref.slot, c.x, c.z) : m.makeScale(0, 0, 0));
      if (tone) mesh.setColorAt(ref.i, p.tone(tone, r.id));
    });
    this.cellsGlow.setColorAt(this.statusRef[r.id], statusColor(p, r.status));
    for (const mesh of [this.cellsLit, this.cellsGlow]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (r.id === 'approval') (this.gateLamp.material as MeshBasicMaterial).color.copy(r.gateClosed ? p.status.error : p.status.ok);
    if (r.id === 'repair') (this.beacon.material as MeshBasicMaterial).color.copy(r.beacon ? p.status.error : p.status.idle);
  }

  private makeFrames(z: ZoneId) {
    const c = roomCenter(z);
    const inset = 0.45, len = ROOM - 2 * inset, w = 0.14;
    const parts: BufferGeometry[] = [];
    const solid: BufferGeometry[] = [];
    for (const [dx, dz, horizontal] of [[0, -1, true], [0, 1, true], [-1, 0, false], [1, 0, false]] as const) {
      const ox = dx * (len / 2), oz = dz * (len / 2);
      solid.push(new BoxGeometry(horizontal ? len : w, 0.02, horizontal ? w : len).translate(ox, 0, oz));
      for (let s = -len / 2; s < len / 2; s += 0.7) {
        const seg = Math.min(0.4, len / 2 - s);
        parts.push(new BoxGeometry(horizontal ? seg : w, 0.02, horizontal ? w : seg).translate(horizontal ? s + seg / 2 : ox, 0, horizontal ? oz : s + seg / 2));
      }
    }
    const mk = (gs: BufferGeometry[]) => {
      const mesh = new Mesh(mergeGeometries(gs)!, new MeshBasicMaterial({ transparent: true, depthWrite: false }));
      mesh.position.set(c.x, FLOOR + 0.012, c.z);
      mesh.visible = false;
      this.scene.add(mesh);
      return mesh;
    };
    const out = { solid: mk(solid), dashed: mk(parts) };
    for (const g of [...solid, ...parts]) g.dispose();
    return out;
  }

  /** Selected room: solid outline; hovered: faint outline; inferred rooms: dashed outline, as in the 2D views. */
  private paintFrames() {
    for (const z of ZONES) {
      const f = this.frames[z];
      const selected = this.opts.selectedZone === z;
      const hovered = this.hover?.zone === z;
      f.solid.visible = selected || hovered;
      (f.solid.material as MeshBasicMaterial).opacity = selected ? 0.95 : 0.4;
      f.dashed.visible = !f.solid.visible && this.model?.rooms[z].source_class === 'inferred' && this.model.rooms[z].status !== 'idle';
      (f.dashed.material as MeshBasicMaterial).opacity = 0.7;
    }
  }

  private pulse(z: ZoneId, status: ZoneStatus) {
    if (this.reducedMotion) return;
    const c = roomCenter(z);
    const mesh = new Mesh(this.pulseGeo, new MeshBasicMaterial({ color: statusColor(this.palette, status === 'idle' || status === 'ok' ? 'active' : status), transparent: true, depthWrite: false }));
    mesh.position.set(c.x, FLOOR + 0.02, c.z);
    this.scene.add(mesh);
    this.pulses.push({ mesh, t: 0 });
    if (this.pulses.length > 18) this.dropPulse(0);
  }

  private dropPulse(i: number) {
    const [p] = this.pulses.splice(i, 1);
    if (!p) return;
    this.scene.remove(p.mesh);
    (p.mesh.material as Material).dispose();
  }

  // ── people ──────────────────────────────────────────────────────────────────

  private addPerson(a: AgentModel, w: Walker): Person {
    const body = a.avatar === 'clawd' ? this.clawdBody(a) : a.avatar === 'person' ? this.humanBody(a) : this.mascotBody(a, a.avatar);
    const radius = a.avatar === 'clawd' ? 0.95 : a.avatar === 'person' ? 0.5 : 0.8;
    const shadowMat = new MeshBasicMaterial({ color: 0x0b1220, transparent: true, opacity: 0.16, depthWrite: false });
    const ringMat = new MeshBasicMaterial({ color: a.color, transparent: true, opacity: 0.9, depthWrite: false });
    const shadow = new Mesh(body.shadow, shadowMat);
    shadow.position.y = 0.01;
    const ringGeo = new RingGeometry(radius, radius + 0.12, 40).rotateX(-Math.PI / 2);
    const ring = new Mesh(ringGeo, ringMat);
    ring.position.y = 0.02;
    body.hit.userData.agent = a.id;
    const obj = new Group();
    obj.add(shadow, ring, ...body.meshes);
    obj.scale.setScalar(body.scale);
    this.scene.add(obj);
    const person: Person = {
      ...body, w, model: a, obj, ring, fades: [...body.fades, [shadowMat, 0.16], [ringMat, 0.9]], owned: [...body.owned, ringGeo],
      alpha: 1, leaving: false, stride: 0, blinkAt: performance.now() + 1500 + Math.random() * 3000, facing: w.yaw,
    };
    this.people.set(a.id, person);
    return person;
  }

  private humanBody(a: AgentModel): Body {
    const g = personGeometry(new Color(a.color), this.palette);
    const torsoMat = new MeshLambertMaterial({ vertexColors: true, transparent: true });
    const legMat = new MeshLambertMaterial({ color: this.palette.legs, transparent: true });
    const torso = new Mesh(g.torso, torsoMat);
    const legs = [new Mesh(g.leg, legMat), new Mesh(g.leg, legMat)];
    legs.forEach((l, i) => l.position.set(i ? 0.1 : -0.1, 0.4, 0));
    return {
      hit: torso, meshes: [torso, ...legs], legs, arms: [], shadow: g.shadow, fades: [[torsoMat, 1], [legMat, 1]],
      owned: [g.torso, g.leg, g.shadow], height: 1.75, scale: a.main ? 1.12 : 0.95,
    };
  }

  /** Claude's pixel mascot. Subagents are smaller and wear their own colour. */
  private clawdBody(a: AgentModel): Body {
    const g = (this.clawd ??= clawdGeometry());
    const skin = new MeshLambertMaterial({ color: a.color, transparent: true });
    const eyeMat = new MeshBasicMaterial({ color: 0x1d1714, transparent: true });
    const body = new Mesh(g.body, skin);
    const eyes = new Mesh(g.eye, eyeMat);
    eyes.position.y = g.eyeY;
    const arms = [new Mesh(g.armL, skin), new Mesh(g.armR, skin)];
    const legs = [new Mesh(g.legFront, skin), new Mesh(g.legBack, skin)];
    return {
      hit: body, meshes: [body, eyes, ...arms, ...legs], legs, arms, eyes, shadow: g.shadow, fades: [[skin, 1], [eyeMat, 1]],
      owned: [], height: g.height + 0.4, scale: a.main ? 1 : 0.72,
    };
  }

  /** Codex's plush cast and Copilot's head: one drawing each, in their own colours (Copilot wears its agent's). */
  private mascotBody(a: AgentModel, id: MascotId): Body {
    let g = this.mascots.get(id);
    if (!g) this.mascots.set(id, (g = mascotGeometry(MASCOTS[id].grid)));
    const skin = new MeshLambertMaterial({ color: MASCOTS[id].color ?? a.color, transparent: true });
    const dark = new MeshLambertMaterial({ color: INK.dark, transparent: true });
    const plate = (color: string) => new MeshBasicMaterial({ color, transparent: true });
    const body = new Mesh(g.body, skin);
    const meshes: Mesh[] = [body];
    const fades: Body['fades'] = [[skin, 1]];
    const add = (geo: BufferGeometry | undefined, mat: FadeMaterial) => {
      if (!geo) return undefined;
      const m = new Mesh(geo, mat);
      meshes.push(m);
      fades.push([mat, 1]);
      return m;
    };
    add(g.standalone, dark);
    add(g.dark, plate(INK.dark));
    add(g.white, plate(INK.white));
    const eyes = add(g.eye, plate(MASCOTS[id].eye ?? INK.dark));
    if (eyes) eyes.position.y = g.eyeY;
    return { hit: body, meshes, legs: [], arms: [], eyes, shadow: g.shadow, fades, owned: [], height: g.height + 0.45, scale: a.main ? 1 : 0.74 };
  }

  private removePerson(id: string) {
    const p = this.people.get(id);
    if (!p) return;
    this.scene.remove(p.obj);
    for (const [m] of p.fades) m.dispose();
    for (const g of p.owned) g.dispose();
    this.people.delete(id);
  }

  // ── camera ──────────────────────────────────────────────────────────────────

  private roomView(z: ZoneId): View {
    const v = fit(roomCorners(z), this.vp, this.pad);
    return clampView({ ...v, zoom: Math.min(v.zoom, this.limits.max) }, this.bounds, this.limits);
  }

  private focus(z: ZoneId | undefined, animate: boolean) {
    if (!z && this.userMoved) return;
    const to = z ? this.roomView(z) : this.home;
    if (z) this.userMoved = false;
    if (animate && !this.reducedMotion) this.animateTo(to, 650);
    else { this.anim = undefined; this.view = to; }
  }

  private animateTo(to: View, dur: number) {
    if (this.reducedMotion) { this.anim = undefined; this.view = to; }
    else this.anim = { from: { ...this.view }, to, t0: performance.now(), dur };
    this.invalidate();
  }

  /** Where the camera is heading (the end of a running animation). */
  private target(): View { return this.anim?.to ?? this.view; }

  private setView(v: View) {
    this.anim = undefined;
    this.view = clampView(v, this.bounds, this.limits);
    this.userMoved = true;
    this.on.manual();
    this.invalidate();
  }

  private applyCamera() {
    const { x, y, zoom } = this.view;
    const t = new Vector3(RIGHT[0] * x + UP[0] * y, RIGHT[1] * x + UP[1] * y, RIGHT[2] * x + UP[2] * y);
    this.camera.position.set(t.x + BACK[0] * 200, t.y + BACK[1] * 200, t.z + BACK[2] * 200);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(t);
    this.camera.zoom = zoom;
    this.camera.updateProjectionMatrix();
  }

  // ── loop ────────────────────────────────────────────────────────────────────

  /** Something changed (input, data, theme, size): draw it on the very next frame. */
  invalidate = () => {
    this.dirty = true;
    this.schedule();
  };

  private schedule() {
    if (!this.raf && !this.disposed && this.visible) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    const dt = Math.min(0.1, this.last ? (now - this.last) / 1000 : 1 / 60);
    const moving = this.animate(dt, now);
    const ambient = !this.reducedMotion && this.ambient(now);
    // Only gentle idle motion left: 30 fps is plenty and halves the GPU work. Input and data never wait.
    if (!moving && !this.dirty && ambient && now - this.lastAmbient < AMBIENT_FRAME_MS) {
      this.schedule();
      return;
    }
    this.dirty = false;
    this.last = now;
    this.lastAmbient = now;
    if (moving && now - this.lastFrame < 250) {
      const dpr = this.quality.sample(now - this.lastFrame, now);
      if (dpr !== undefined) this.setPixelRatio(dpr);
    }
    this.lastFrame = now;
    this.render(now);
    if (moving || ambient) this.schedule();
    else {
      this.last = 0;
      this.wakeForBlink(now);
    }
  };

  /** Advances everything time-based. Returns true while something is in motion. */
  private animate(dt: number, now: number): boolean {
    let moving = false;
    if (this.anim) {
      const t = Math.min(1, (now - this.anim.t0) / this.anim.dur);
      this.view = mix(this.anim.from, this.anim.to, t);
      if (t >= 1) this.anim = undefined;
      moving = true;
    }
    const follow = this.opts.focusAgent ? this.people.get(this.opts.focusAgent) : undefined;
    if (follow && !this.anim) {
      const s = onScreen([follow.w.pos.x, 0.8, follow.w.pos.z]);
      const k = 1 - Math.exp(-dt * 5);
      const next = clampView({ x: this.view.x + (s.x - this.view.x) * k, y: this.view.y + (s.y - this.view.y) * k, zoom: this.view.zoom }, this.bounds, this.limits);
      if (!sameView(next, this.view)) moving = true;
      this.view = next;
    }
    for (const [id, p] of this.people) {
      const walked = walking(p.w);
      if (walked) { step(p.w, dt); p.stride += dt; moving = true; }
      const want = p.leaving ? 0 : 1;
      if (p.alpha !== want) {
        p.alpha = this.reducedMotion ? want : Math.max(0, Math.min(1, p.alpha + (want ? dt : -dt) * 2.5));
        moving = true;
        if (p.leaving && p.alpha === 0) { this.removePerson(id); continue; }
      }
      if (this.pose(p, now, dt, walked)) moving = true;
    }
    const closed = !!this.model?.rooms.approval.gateClosed;
    const angle = closed ? 0 : 1.35;
    if (Math.abs(this.gateAngle - angle) > 1e-3) {
      this.gateAngle = this.reducedMotion ? angle : this.gateAngle + Math.sign(angle - this.gateAngle) * Math.min(Math.abs(angle - this.gateAngle), dt * 3);
      moving = true;
    }
    this.gate.rotation.z = this.gateAngle;
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i]!;
      p.t += dt / 1.1;
      if (p.t >= 1) { this.dropPulse(i); continue; }
      p.mesh.scale.setScalar(1 + p.t * 3.2);
      (p.mesh.material as MeshBasicMaterial).opacity = 0.75 * (1 - p.t) ** 1.5;
      moving = true;
    }
    if (this.model?.rooms.repair.beacon && !this.reducedMotion) {
      const k = 0.5 + 0.5 * Math.sin(now / 160);
      (this.beacon.material as MeshBasicMaterial).color.copy(this.palette.status.error).lerp(this.palette.status.warn, k * 0.6);
      this.beacon.rotation.y = now / 300;
    }
    return moving;
  }

  /** Idle animation worth keeping the loop alive for: busy, thinking or waiting agents, blinks and the repair beacon. */
  private ambient(now: number) {
    if (this.model?.rooms.repair.beacon) return true;
    for (const p of this.people.values()) {
      if (p.model.busy || p.model.thinking || p.model.waiting) return true;
      if (p.eyes && now >= p.blinkAt && now < p.blinkAt + BLINK_MS) return true;
    }
    return false;
  }

  /** With nothing else moving the loop sleeps; wake it for the next blink so the mascots never look frozen. */
  private wakeForBlink(now: number) {
    clearTimeout(this.blinkTimer);
    if (this.reducedMotion || !this.visible || this.disposed) return;
    let next = Infinity;
    for (const p of this.people.values()) if (p.eyes && !p.leaving) next = Math.min(next, p.blinkAt);
    if (next < Infinity) this.blinkTimer = window.setTimeout(this.invalidate, Math.max(0, next - now));
  }

  /** Poses one agent for this frame. Returns true while it is still turning. */
  private pose(p: Person, now: number, dt: number, walked: boolean): boolean {
    const { obj, legs, arms, model } = p;
    const animate = !this.reducedMotion;
    const clawd = model.avatar === 'clawd';
    const motion = model.avatar === 'clawd' || model.avatar === 'person' ? undefined : MASCOTS[model.avatar].motion;
    // Mascots are their faces: at rest they turn to the viewer.
    const want = (clawd || motion) && !walked ? FACE_VIEWER : p.w.yaw;
    const turn = Math.atan2(Math.sin(want - p.facing), Math.cos(want - p.facing));
    p.facing = animate ? p.facing + Math.sign(turn) * Math.min(Math.abs(turn), dt * 9) : want;
    let bob = 0, sway = 0, swing = 0;
    const lift = [0, 0], reach = [0, 0];
    if (walked && animate) {
      const s = Math.sin(p.stride * (clawd ? 11 : 13));
      swing = s * 0.55;
      bob = Math.abs(s) * (clawd ? 0.035 : 0.06);
      // The mascot scuttles: front and back legs lift in turn, the body rocks, the arms pump.
      if (clawd) [lift[0], lift[1], reach[0], reach[1], sway] = [Math.max(0, s) * 0.08, Math.max(0, -s) * 0.08, s * 0.03, -s * 0.03, s * 0.05];
    } else if (animate && model.waiting) {
      // Waiting for you: waves.
      reach[1] = (0.5 + 0.5 * Math.sin(now / 150)) * 0.18;
    } else if (animate && model.busy) {
      bob = Math.max(0, Math.sin(now / 140 + p.w.pos.x)) * 0.035;
      // At work: typing, one arm after the other.
      reach[0] = Math.max(0, Math.sin(now / 85)) * 0.06;
      reach[1] = Math.max(0, -Math.sin(now / 85)) * 0.06;
    } else if (animate && model.thinking) sway = Math.sin(now / 700) * (clawd ? 0.05 : 0.03);
    let squash = 0;
    if (motion === 'hop' && animate) {
      // Plush toys hop where people walk, squashing as they land; they bounce while waiting and wobble at work.
      if (walked) { const s = Math.abs(Math.sin(p.stride * 9)); bob = s * 0.16; squash = (1 - s) * 0.07; }
      else if (model.waiting) { const s = Math.abs(Math.sin(now / 230)); bob = s * 0.12; squash = (1 - s) * 0.05; }
      else if (model.busy) { bob = 0; sway = Math.sin(now / 110) * 0.045; }
    }
    if (motion === 'hover') {
      // Copilot's head floats; it bobs while it moves or works, and rocks while waiting for you.
      bob = 0.16 + (animate && (walked || model.busy) ? Math.sin(now / 260) * 0.04 : 0);
      if (animate && model.waiting) sway = Math.sin(now / 160) * 0.07;
    }
    obj.position.set(p.w.pos.x, FLOOR + bob, p.w.pos.z);
    obj.rotation.set(0, p.facing, sway);
    obj.scale.set(p.scale * (1 + squash), p.scale * (1 - squash), p.scale * (1 + squash));
    if (motion) {
      // No limbs: the whole body moves.
    } else if (clawd) {
      legs.forEach((l, i) => (l.position.y = lift[i]!));
      arms.forEach((a, i) => (a.position.y = reach[i]!));
    } else {
      legs[0]!.rotation.x = swing;
      legs[1]!.rotation.x = -swing;
    }
    if (p.eyes) {
      if (now >= p.blinkAt + BLINK_MS) p.blinkAt = now + 2200 + Math.random() * 3800;
      p.eyes.scale.y = animate && now >= p.blinkAt ? 0.15 : 1;
    }
    p.ring.visible = this.opts.focusAgent === model.id || this.hover?.agent === model.id;
    const fade = p.alpha * (model.finished ? 0.55 : 1);
    for (const [m, full] of p.fades) m.opacity = full * fade;
    obj.visible = fade > 0.01;
    return Math.abs(Math.sin(want - p.facing)) > 1e-3 || Math.cos(want - p.facing) < 0;
  }

  private render(now: number) {
    this.applyCamera();
    this.renderer.render(this.scene, this.camera);
    const info = this.renderer.info.render;
    this.stats.frames++;
    this.stats.drawCalls = info.calls;
    this.stats.triangles = info.triangles;
    this.stats.zoom = this.view.zoom;
    this.fpsWindow.push(now);
    while (this.fpsWindow.length && now - this.fpsWindow[0]! > 1000) this.fpsWindow.shift();
    this.stats.fps = this.fpsWindow.length;
    if (this.pendingMark !== undefined) {
      this.stats.eventToPixelMs = performance.now() - this.pendingMark;
      this.pendingMark = undefined;
    }
    this.emitLabels();
  }

  private emitLabels() {
    const out = new Map<string, LabelPos>();
    const v = new Vector3();
    const put = (key: string, x: number, y: number, z: number) => {
      v.set(x, y, z).project(this.camera);
      const px = ((v.x + 1) / 2) * this.vp.width, py = ((1 - v.y) / 2) * this.vp.height;
      out.set(key, { x: px, y: py, on: px > -40 && px < this.vp.width + 40 && py > -10 && py < this.vp.height + 60 });
    };
    for (const z of ZONES) {
      const c = roomCenter(z);
      // Over the back half of the room: the label's foot sits between the room's centre and its far corner.
      put(`zone:${z}`, c.x - LABEL_INSET, WALL_H, c.z - LABEL_INSET);
    }
    for (const [id, p] of this.people) {
      if (p.leaving) continue;
      put(`agent:${id}`, p.obj.position.x, p.obj.position.y + p.height * p.obj.scale.y, p.obj.position.z);
      v.set(p.obj.position.x, FLOOR, p.obj.position.z).project(this.camera);
      out.get(`agent:${id}`)!.foot = ((1 - v.y) / 2) * this.vp.height;
    }
    this.on.labels(out, ROOM * Math.SQRT2 * this.view.zoom);
  }

  // ── input ───────────────────────────────────────────────────────────────────

  private listen() {
    const h = this.host;
    const add = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, o);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, o));
    };
    add(h, 'pointerdown', e => this.down(e));
    add(h, 'pointermove', e => this.move(e));
    add(h, 'pointerup', e => this.up(e));
    add(h, 'pointercancel', e => this.cancel(e));
    add(h, 'pointerleave', () => this.setHover(undefined));
    add(h, 'wheel', e => this.wheel(e), { passive: false });
    add(h, 'keydown', e => this.key(e));
    // The GPU can drop the context (driver reset, too many tabs); three.js rebuilds it when it comes back.
    const lost = (e: Event) => { e.preventDefault(); this.on.contextLost(true); };
    const restored = () => { this.on.contextLost(false); this.invalidate(); };
    this.canvas.addEventListener('webglcontextlost', lost);
    this.canvas.addEventListener('webglcontextrestored', restored);
    this.cleanup.push(() => { this.canvas.removeEventListener('webglcontextlost', lost); this.canvas.removeEventListener('webglcontextrestored', restored); });
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(h);
    const io = new IntersectionObserver(([entry]) => {
      this.visible = !!entry?.isIntersecting;
      if (this.visible) this.invalidate();
    });
    io.observe(h);
    this.observers.push(ro, io);
    this.resize();
  }

  private local(e: { clientX: number; clientY: number }) {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) this.drag = { ...p, moved: false, id: e.pointerId };
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (this.drag) this.drag.moved = true;
    }
  }

  private move(e: PointerEvent) {
    const p = this.local(e);
    const prev = this.pointers.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === 'mouse') this.setHover(this.pick(p.x, p.y, e.target));
      return;
    }
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size >= 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const zoomed = zoomAround(panBy(this.view, mx - this.pinch.x, my - this.pinch.y), this.vp, d / Math.max(1, this.pinch.d), mx, my, this.limits);
      this.pinch = { d, x: mx, y: my };
      this.setView(zoomed);
      return;
    }
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) > DRAG_THRESHOLD) {
      d.moved = true;
      // Capture only once it is a drag, so a plain click still reaches the label button it started on.
      this.host.setPointerCapture?.(e.pointerId);
      this.host.classList.add('dragging');
    }
    if (d.moved) this.setView(panBy(this.view, p.x - prev.x, p.y - prev.y));
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = undefined;
    if (!d || d.id !== e.pointerId) return;
    this.drag = undefined;
    this.host.classList.remove('dragging');
    if (d.moved) {
      // Swallow the click that follows a drag, so dragging across a label does not select it.
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      this.host.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => this.host.removeEventListener('click', swallow, { capture: true }), 0);
      return;
    }
    if (e.target !== this.canvas) return; // a label button handles its own click
    const p = this.local(e);
    const hit = this.pick(p.x, p.y, e.target);
    if (hit?.agent) this.on.agent(hit.agent);
    else if (hit?.zone) this.on.zone(hit.zone);
  }

  private cancel(e: PointerEvent) {
    const d = this.drag;
    this.pointers.delete(e.pointerId);
    this.pinch = undefined;
    this.drag = undefined;
    this.host.classList.remove('dragging');
    // The browser took a one-finger drag to scroll the page: tell the user how to move the map.
    if (e.pointerType === 'touch' && d && !this.expanded) this.on.hint('touch');
  }

  private wheel(e: WheelEvent) {
    // Trackpad pinch arrives as ctrl+wheel. A plain wheel scrolls the page unless the map is expanded.
    if (!e.ctrlKey && !e.metaKey && !this.expanded) return this.on.hint('wheel');
    e.preventDefault();
    const p = this.local(e);
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const factor = Math.exp(-e.deltaY * scale * (e.ctrlKey ? 0.01 : 0.0018));
    this.setView(zoomAround(this.view, this.vp, factor, p.x, p.y, this.limits));
  }

  private key(e: KeyboardEvent) {
    if (e.target !== this.host || e.ctrlKey || e.metaKey || e.altKey) return;
    const step = 80;
    const moves: Record<string, () => View> = {
      ArrowLeft: () => panBy(this.view, step, 0), ArrowRight: () => panBy(this.view, -step, 0),
      ArrowUp: () => panBy(this.view, 0, step), ArrowDown: () => panBy(this.view, 0, -step),
      '+': () => zoomAround(this.view, this.vp, 1.25, this.vp.width / 2, this.vp.height / 2, this.limits),
      '=': () => zoomAround(this.view, this.vp, 1.25, this.vp.width / 2, this.vp.height / 2, this.limits),
      '-': () => zoomAround(this.view, this.vp, 0.8, this.vp.width / 2, this.vp.height / 2, this.limits),
    };
    if (e.key === '0') { e.preventDefault(); e.stopPropagation(); return this.resetView(); }
    const fn = moves[e.key];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    this.setView(fn());
  }

  private ray = new Raycaster();
  private floor = new Plane(new Vector3(0, 1, 0), -FLOOR);

  /** What is under a point of the viewport: an agent first, then the room whose floor it is on. */
  private pick(x: number, y: number, target: EventTarget | null): { zone?: ZoneId; agent?: string } | undefined {
    if (target !== this.canvas) return undefined;
    this.applyCamera();
    this.ray.setFromCamera(new Vector2((x / this.vp.width) * 2 - 1, -(y / this.vp.height) * 2 + 1), this.camera);
    const bodies: Object3D[] = [];
    for (const p of this.people.values()) if (!p.leaving) bodies.push(p.hit);
    const agent = this.ray.intersectObjects(bodies, false)[0]?.object.userData.agent as string | undefined;
    if (agent) return { agent };
    const hit = this.ray.ray.intersectPlane(this.floor, new Vector3());
    if (!hit) return undefined;
    const zone = ZONES.find(z => {
      const c = roomCenter(z);
      return Math.abs(hit.x - c.x) <= ROOM / 2 && Math.abs(hit.z - c.z) <= ROOM / 2;
    });
    return zone ? { zone } : undefined;
  }

  private setHover(h: { zone?: ZoneId; agent?: string } | undefined) {
    if (h?.zone === this.hover?.zone && h?.agent === this.hover?.agent) return;
    this.hover = h;
    this.host.classList.toggle('hovering', !!(h?.zone || h?.agent));
    this.paintFrames();
    this.invalidate();
  }
}

function place(m: Matrix4, s: Slot, ox: number, oz: number): Matrix4 {
  return m.makeScale(s.w, s.h, s.d).setPosition(ox + s.x, s.y, oz + s.z);
}

function statusColor(p: Palette, s: ZoneStatus): Color {
  return s === 'idle' ? p.tone('dim', 'mission') : p.status[s];
}
