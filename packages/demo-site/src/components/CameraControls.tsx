/**
 * Deterministic camera rig — the single owner of the camera.
 *
 * There is no OrbitControls. State is { target, yaw, pitch, distance } plus the
 * ACTIVE LOCAL FRAME (up + tangent basis) of the current context, and every
 * frame derives camera.position from it:
 *
 *   pos = target + distance * (cos(p)cos(y)*east + cos(p)sin(y)*north + sin(p)*up)
 *
 * Orbit turns about the frame's up, so a ship on a planet's flank swings level
 * to its own horizon instead of on a skewed world-Y arc. `look` (right-drag in
 * fly mode) is a separate view offset: it rotates the camera in place and never
 * moves the target. Nothing in this app writes camera.position anywhere else.
 */
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { FocusRequest, Planet, Vec3 } from '../types';
import { toScene } from '../lib/sceneMath';
import {
  CameraRig,
  MAX_CAMERA_DISTANCE,
  RIG_TWEEN_MS,
  distanceBetween,
  frameFromUp,
  planFocusPose,
  rigFromPosition,
  rigPosition,
  wheelNotches,
  type CameraFrame,
  type Vec3Like,
} from '../lib/camera';
import type { CameraContext } from '../lib/cameraContext';
import { pickRadiusPx } from '../lib/pickShips';
import type { ContextPose } from '../lib/contextStack';

type DragMode = 'orbit' | 'pan' | 'look';

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

const RAD2DEG = 180 / Math.PI;

/** Imperative handle the app uses for explicit context entry / restore. */
export interface CameraApi {
  /** explicit entry: keep the camera still, re-pivot, then fly to the framing */
  enter(entry: CameraContext, framedDistance: number): void;
  /** Esc / breadcrumb: put the saved pose back exactly */
  restore(entry: CameraContext, pose: ContextPose): void;
  pose(): ContextPose;
  distance(): number;
  position(): Vec3Like;
  up(): Vec3Like;
}

export interface CameraControlsProps {
  focus: FocusRequest | null;
  planets: Planet[];
  /** metres; when set, the rig translates with this point every frame */
  followPos: Vec3 | null;
  /** the resolved camera context (pivot + local up) */
  context: CameraContext;
  /** planet centre used only to seed the initial pose */
  defaultPivot: Vec3 | null;
  /** fly mode: right-drag looks in place (Tab) */
  flyMode: boolean;
  apiRef?: React.MutableRefObject<CameraApi | null>;
}

function sameUp(a: Vec3Like, b: Vec3Like): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
}

interface Probe {
  pos: [number, number, number];
  target: [number, number, number];
  mode: 'orbit' | 'fly';
  pivot: string | null;
  pivotLabel: string | null;
  context: string;
  contextKind: string;
  up: [number, number, number];
  rollDeg: number;
  look: { yaw: number; pitch: number };
  flying: boolean;
  frames: number;
  distance: number;
  yaw: number;
  pitch: number;
  /** zoom-scaled click radius the app uses for hover/click/double-click */
  pickRadiusPx: number;
  autoFrameDisabled: boolean;
  jumps: { frame: number; from: [number, number, number]; to: [number, number, number]; km: number }[];
}

export function CameraControls({ focus, planets, followPos, context, defaultPivot, flyMode, apiRef }: CameraControlsProps) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const keys = useRef<Record<string, boolean>>({});
  const drag = useRef<{ mode: DragMode; x: number; y: number } | null>(null);
  const lastNonce = useRef(-1);
  const followPrev = useRef<Vec3 | null>(null);
  const lastInputAt = useRef(-1e9);
  const lastPos = useRef<THREE.Vector3 | null>(null);
  const raycaster = useRef(new THREE.Raycaster());
  const flyRef = useRef(flyMode);
  flyRef.current = flyMode;
  const contextRef = useRef(context);
  contextRef.current = context;
  /**
   * Key of the level the app explicitly entered. Until the next render delivers
   * that context, the frame must not be re-synced from the previous level's up
   * (that would flicker the camera for one frame after a double-click).
   */
  const enteredKey = useRef<string | null>(null);
  const probe = useRef<Probe>({
    pos: [0, 0, 0],
    target: [0, 0, 0],
    mode: 'orbit',
    pivot: null,
    pivotLabel: null,
    context: 'system',
    contextKind: 'system',
    up: [0, 1, 0],
    rollDeg: 0,
    look: { yaw: 0, pitch: 0 },
    flying: false,
    frames: 0,
    distance: 0,
    yaw: 0,
    pitch: 0,
    pickRadiusPx: 14,
    autoFrameDisabled: false,
    jumps: [],
  });

  // Seed once from the camera the Canvas mounted. Never re-seed from props:
  // polling must not be able to reset a live camera.
  const rigRef = useRef<CameraRig | null>(null);
  if (!rigRef.current) {
    const seedTarget = defaultPivot ? toScene(defaultPivot) : { x: 0, y: 0, z: 0 };
    rigRef.current = new CameraRig(
      rigFromPosition(
        { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        seedTarget,
        frameFromUp(context.up),
      ),
      frameFromUp(context.up),
    );
  }

  useEffect(() => {
    (window as unknown as { __demoCam?: Probe }).__demoCam = probe.current;
  }, []);

  // Imperative handle: explicit entry and exact pose restore. A single click
  // never calls into here, which is why selection cannot move the camera.
  useEffect(() => {
    if (!apiRef) return undefined;
    const api: CameraApi = {
      enter: (entry, framedDistance) => {
        const rig = rigRef.current;
        if (!rig) return;
        const frame: CameraFrame = frameFromUp(entry.up);
        enteredKey.current = entry.key;
        rig.retarget(entry.pivot, frame, framedDistance);
        probe.current.autoFrameDisabled = false;
      },
      restore: (entry, pose) => {
        const rig = rigRef.current;
        if (!rig) return;
        enteredKey.current = entry.key;
        rig.applyPose(entry.pivot, frameFromUp(entry.up), pose);
      },
      pose: () => {
        const rig = rigRef.current;
        if (!rig) return { yaw: 0, pitch: 0, distance: 20 };
        return {
          yaw: rig.state.yaw,
          pitch: rig.state.pitch,
          distance: rig.state.distance,
          target: { x: rig.state.target.x, y: rig.state.target.y, z: rig.state.target.z },
        };
      },
      distance: () => rigRef.current?.state.distance ?? 20,
      position: () => rigRef.current?.position ?? { x: 0, y: 0, z: 0 },
      up: () => ({ ...(rigRef.current?.frame.up ?? { x: 0, y: 1, z: 0 }) }),
    };
    apiRef.current = api;
    return () => {
      if (apiRef.current === api) apiRef.current = null;
    };
  }, [apiRef]);

  // Keyboard: WASD/QE fly, Shift boost. Any key cancels a focus tween.
  useEffect(() => {
    const markInput = () => {
      lastInputAt.current = performance.now();
      probe.current.autoFrameDisabled = true;
      rigRef.current?.cancel();
    };
    const down = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const mapped = key === ' ' ? 'space' : key === 'control' ? 'ctrl' : key;
      markInput();
      if (['w', 'a', 's', 'd', 'q', 'e', 'shift', 'space', 'ctrl'].includes(mapped)) {
        keys.current[mapped] = true;
        if (mapped !== 'shift') event.preventDefault();
      }
    };
    const up = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const mapped = key === ' ' ? 'space' : key === 'control' ? 'ctrl' : key;
      if (mapped in keys.current) keys.current[mapped] = false;
    };
    const blur = () => {
      keys.current = {};
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // Drag: left = orbit, middle = orbit, right = pan (orbit mode) or look (fly
  // mode). 'look' is handled explicitly — it used to fall through into orbit,
  // which is why dragging after a ship click swung the camera around it.
  // Shift+left belongs to box select and never starts a camera drag.
  useEffect(() => {
    const dom = gl.domElement;
    const onDown = (event: PointerEvent) => {
      let mode: DragMode | null = null;
      if (event.button === 0 && !event.shiftKey) mode = 'orbit';
      else if (event.button === 1) mode = 'orbit';
      else if (event.button === 2) mode = flyRef.current ? 'look' : 'pan';
      if (!mode) return;
      rigRef.current?.cancel();
      lastInputAt.current = performance.now();
      probe.current.autoFrameDisabled = true;
      drag.current = { mode, x: event.clientX, y: event.clientY };
    };
    const onMove = (event: PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      const dx = event.clientX - state.x;
      const dy = event.clientY - state.y;
      state.x = event.clientX;
      state.y = event.clientY;
      if (!dx && !dy) return;
      const rig = rigRef.current;
      if (!rig) return;
      if (state.mode === 'pan') rig.pan(dx, dy, dom.clientHeight || 1);
      else if (state.mode === 'look') rig.lookBy(dx, dy);
      else rig.orbit(dx, dy);
      lastInputAt.current = performance.now();
    };
    const onUp = () => {
      drag.current = null;
    };
    dom.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    return () => {
      dom.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    };
  }, [gl]);

  // Wheel: immediate multiplicative zoom, normalised deltaMode, capped at 1.2
  // notches per event. The cursor ray picks ships first, then planet/terrain;
  // the hit becomes the point the target moves toward so it stays put on screen.
  useEffect(() => {
    const dom = gl.domElement;
    const pick = (event: WheelEvent): THREE.Vector3 | null => {
      const rect = dom.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const ray = raycaster.current;
      ray.setFromCamera(ndc, camera);
      ray.far = MAX_CAMERA_DISTANCE * 10;
      const hits = ray.intersectObjects(scene.children, true);
      for (const hit of hits) {
        const object = hit.object as THREE.Mesh;
        if (!object.isMesh || !object.visible) continue;
        if (object.userData?.noPick === true) continue;
        const material = object.material as THREE.Material | THREE.Material[] | undefined;
        const first = Array.isArray(material) ? material[0] : material;
        if (first && first.transparent && first.opacity < 0.05) continue;
        return hit.point.clone();
      }
      return null;
    };
    const onWheel = (event: WheelEvent) => {
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      const rig = rigRef.current;
      if (!rig) return;
      rig.wheel(wheelNotches(event.deltaY, event.deltaMode), pick(event));
      lastInputAt.current = performance.now();
      probe.current.autoFrameDisabled = true;
    };
    dom.addEventListener('wheel', onWheel, { passive: false });
    return () => dom.removeEventListener('wheel', onWheel);
  }, [gl, camera, scene]);

  // One focus tween per nonce. The effect only records the tween; useFrame is
  // the single writer, so a re-render or a poll cannot move anything.
  useEffect(() => {
    if (!focus || focus.nonce === lastNonce.current || !rigRef.current) return;
    lastNonce.current = focus.nonce;
    const goal = planFocusPose(focus.target, planets, {
      minDistance: 0.15,
      maxDistance: MAX_CAMERA_DISTANCE,
    });
    rigRef.current.focusTo(goal.target, distanceBetween(goal.pos, goal.target), RIG_TWEEN_MS);
  }, [focus, planets]);

  useFrame((_, delta) => {
    const rig = rigRef.current;
    if (!rig) return;
    const step = Math.min(0.1, delta);
    const now = performance.now();
    // A tween is capped per frame so a slow first frame cannot teleport the
    // camera through the whole flight in one step.
    const wasFlying = rig.flying;
    rig.update(Math.min(delta * 1000, 100));

    // A context whose up is radial (ship/group) changes as the target moves:
    // keep the frame in sync without touching the pose, so the horizon drifts
    // with the planet instead of snapping.
    const liveContext = contextRef.current;
    const liveUp = liveContext.up;
    if (liveContext.key !== enteredKey.current && !sameUp(rig.frame.up, liveUp)) {
      rig.setFrame(frameFromUp(liveUp));
    }

    // Follow mode translates the orbit target with the ship; the camera follows
    // because it is derived from the target (never a separate camera write).
    if (followPos && !rig.flying) {
      const prev = followPrev.current;
      if (prev) {
        const dx = (followPos.x - prev.x) / 1000;
        const dy = (followPos.y - prev.y) / 1000;
        const dz = (followPos.z - prev.z) / 1000;
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-6) rig.translate(dx, dy, dz);
      }
      followPrev.current = followPos;
    } else if (!followPos) {
      followPrev.current = null;
    }

    const k = keys.current;
    const moving = Boolean(k.w || k.s || k.a || k.d || k.q || k.e || k.ctrl || k.space);
    if (moving) {
      rig.fly(
        {
          w: Boolean(k.w),
          s: Boolean(k.s),
          a: Boolean(k.a),
          d: Boolean(k.d),
          q: Boolean(k.q || k.ctrl),
          e: Boolean(k.e || k.space),
        },
        step,
        Boolean(k.shift),
      );
    }

    // THE formula. This is the only place the camera is written.
    const pos = rigPosition(rig.state, rig.frame);
    const basis = rig.basis;
    camera.position.set(pos.x, pos.y, pos.z);
    camera.up.set(rig.frame.up.x, rig.frame.up.y, rig.frame.up.z);
    camera.lookAt(pos.x + basis.forward.x, pos.y + basis.forward.y, pos.z + basis.forward.z);
    camera.updateMatrixWorld();

    // Source-free snap-back detector: a >5 km jump in one frame with no input,
    // no tween and no follow is a bug worth recording.
    const inputActive = drag.current !== null || now - lastInputAt.current < 250 || Boolean(followPos);
    if (lastPos.current && !wasFlying && !rig.flying && !inputActive) {
      const jump = lastPos.current.distanceTo(camera.position);
      if (jump > 5) {
        probe.current.jumps.push({
          frame: probe.current.frames,
          from: [lastPos.current.x, lastPos.current.y, lastPos.current.z],
          to: [pos.x, pos.y, pos.z],
          km: +jump.toFixed(3),
        });
        if (probe.current.jumps.length > 50) probe.current.jumps.shift();
      }
    }
    (lastPos.current ??= new THREE.Vector3()).copy(camera.position);

    // Roll relative to the context's up: 0 means the local horizon is level.
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const camUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const frameUp = new THREE.Vector3(rig.frame.up.x, rig.frame.up.y, rig.frame.up.z);
    const noRoll = frameUp.clone().sub(fwd.clone().multiplyScalar(frameUp.dot(fwd)));
    let rollDeg = 0;
    if (noRoll.lengthSq() > 1e-9) {
      noRoll.normalize();
      const cross = new THREE.Vector3().crossVectors(noRoll, camUp);
      rollDeg = Math.atan2(cross.dot(fwd), noRoll.dot(camUp)) * RAD2DEG;
    }

    const p = probe.current;
    p.pos = [pos.x, pos.y, pos.z];
    p.target = [rig.state.target.x, rig.state.target.y, rig.state.target.z];
    p.mode = flyRef.current ? 'fly' : 'orbit';
    p.pivot = liveContext.id;
    p.pivotLabel = liveContext.label;
    p.context = liveContext.key;
    p.contextKind = liveContext.kind;
    p.up = [rig.frame.up.x, rig.frame.up.y, rig.frame.up.z];
    p.rollDeg = +rollDeg.toFixed(3);
    p.look = { yaw: rig.look.yaw, pitch: rig.look.pitch };
    p.flying = rig.flying;
    p.distance = rig.state.distance;
    p.pickRadiusPx = +pickRadiusPx(rig.state.distance).toFixed(2);
    p.yaw = rig.state.yaw;
    p.pitch = rig.state.pitch;
    p.frames += 1;
  });

  return null;
}

/** Focus target for a grid node (radius in km is a readable framing hint). */
export function nodeFocusTarget(node: { id: string; name: string; position: Vec3 }, radiusKm = 0.15) {
  return { id: node.id, label: node.name, pos: node.position, radiusKm };
}
