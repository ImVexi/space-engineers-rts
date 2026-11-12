import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { toScene } from '../lib/sceneMath';
import {
  RING_MAX_ACTIVE,
  phaseForId,
  pickPulsingNodes,
  pulseAt,
  ringInnerRatio,
  ringRadiusUnits,
  ringVisible,
  screenRadiusPx,
} from '../lib/rings';

export interface RadioRingNode {
  id: string;
  position: { x: number; y: number; z: number };
  radioRadiusM: number | null;
  reachable?: boolean;
}

interface RadioRingsProps {
  nodes: RadioRingNode[];
  selectedIds: string[];
  /** ids whose block model is on screen: their ring must stay hidden */
  drawnIds: string[];
  /** ids that own a block model in the manifest: no ring around a hull */
  modeledIds?: string[];
  visible: boolean;
  /** seconds per pulse; never below the exported constant */
  period: number;
}

interface RingProbe {
  id: string;
  radiusM: number;
  scale: number;
  screenRadiusPx: number;
  cameraDistanceKm: number;
}

const VERT = /* glsl */ `
  varying float vR;
  void main() {
    vR = length(position.xy);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uInner;
  varying float vR;
  void main() {
    if (vR < uInner) discard;
    float edge = smoothstep(uInner, min(uInner + 0.02, 0.999), vR);
    gl_FragColor = vec4(uColor, uOpacity * edge);
  }
`;

/**
 * T23: true-scale radio range rings.
 *
 * One flat annulus per pooled slot (max 40). The annulus is a disc mesh whose
 * fragment shader discards everything inside `uInner`, which is recomputed
 * from the projected radius so the stroke never drops below 2 px. Rings are
 * pure decoration: `raycast` is disabled, so they can never steal a pick from
 * a ship, planet or map point.
 */
export function RadioRings({ nodes, selectedIds, drawnIds, modeledIds, visible, period }: RadioRingsProps) {
  const { camera, size } = useThree();
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const drawn = useMemo(() => new Set([...drawnIds, ...(modeledIds ?? [])]), [drawnIds, modeledIds]);
  const meshes = useRef<(THREE.Mesh | null)[]>(Array.from({ length: RING_MAX_ACTIVE }, () => null));
  const materials = useRef<(THREE.ShaderMaterial | null)[]>(Array.from({ length: RING_MAX_ACTIVE }, () => null));
  const elapsed = useRef(0);
  const lastProbe = useRef(0);

  // One immutable unit disc geometry shared by every slot; scale carries size.
  const geometry = useMemo(() => new THREE.RingGeometry(0.5, 1, 96, 1), []);

  const ringNodes = useMemo(
    () =>
      nodes
        .filter((n) => (n.radioRadiusM ?? 0) > 0 && !drawn.has(n.id))
        .map((n) => ({ id: n.id, position: n.position, radioRadiusM: n.radioRadiusM })),
    [nodes, drawn],
  );

  useFrame((state, delta) => {
    const paused = !visible || (typeof document !== 'undefined' && document.hidden);
    if (!paused) elapsed.current += Math.min(delta, 0.25);

    const nearest = visible ? pickPulsingNodes(ringNodes, camera.position, RING_MAX_ACTIVE) : [];
    // Selected rings always get a slot, even when they are not in the nearest
    // 40; they are drawn steady at full radius.
    const selectedNodes = ringNodes.filter((n) => selected.has(n.id));
    const active = [...selectedNodes, ...nearest.filter((n) => !selected.has(n.id))].slice(0, RING_MAX_ACTIVE);
    const activeIds = new Set(active.map((n) => n.id));
    const heightPx = size.height || 700;
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 50;
    const probe: RingProbe[] = [];

    for (let i = 0; i < RING_MAX_ACTIVE; i++) {
      const mesh = meshes.current[i];
      const material = materials.current[i];
      if (!mesh || !material) continue;
      const node = active[i];
      if (!node || (node.radioRadiusM ?? 0) <= 0) {
        mesh.visible = false;
        continue;
      }
      const p = toScene(node.position);
      const distance = camera.position.distanceTo(new THREE.Vector3(p.x, p.y, p.z));
      const isSelected = selected.has(node.id);
      const phase = phaseForId(node.id);
      const pulse = isSelected ? { scale: 1, opacity: 0.35 } : pulseAt(elapsed.current, phase, period);
      const worldRadius = ringRadiusUnits(node.radioRadiusM ?? 0, pulse.scale);
      const px = screenRadiusPx(worldRadius, distance, fov, heightPx);
      if (!ringVisible(px)) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.position.set(p.x, p.y, p.z);
      mesh.scale.setScalar(Math.max(worldRadius, 1e-4));
      material.uniforms.uInner.value = ringInnerRatio(px);
      material.uniforms.uOpacity.value = isSelected ? 0.35 : pulse.opacity;
      material.uniforms.uColor.value.set(isSelected ? '#e6b878' : '#74d3c4');
      if (probe.length < 3 || isSelected) {
        probe.push({
          id: node.id,
          radiusM: node.radioRadiusM ?? 0,
          scale: pulse.scale,
          screenRadiusPx: Math.round(px * 100) / 100,
          cameraDistanceKm: Math.round(distance * 1000) / 1000,
        });
      }
    }

    // Test probe: the renderer's own numbers, throttled to ~2 Hz. Playwright
    // checks them against the ring formula without scraping WebGL pixels.
    const now = state.clock.elapsedTime;
    if (now - lastProbe.current > 0.5) {
      lastProbe.current = now;
      (window as unknown as { __demoRings?: unknown }).__demoRings = {
        visible,
        paused,
        active: activeIds.size,
        fieldRadiusM: 50_000,
        fov,
        viewportHeightPx: heightPx,
        camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        rings: probe,
      };
    }
  });

  return (
    <group name="radio-range-rings">
      {Array.from({ length: RING_MAX_ACTIVE }, (_, i) => (
        <mesh
          key={i}
          ref={(m) => {
            meshes.current[i] = m;
          }}
          geometry={geometry}
          rotation={[-Math.PI / 2, 0, 0]}
          visible={false}
          raycast={() => null}
          renderOrder={-1}
          frustumCulled={false}
        >
          <shaderMaterial
            ref={(m) => {
              materials.current[i] = m;
            }}
            vertexShader={VERT}
            fragmentShader={FRAG}
            transparent
            depthWrite={false}
            depthTest
            side={THREE.DoubleSide}
            uniforms={{
              uColor: { value: new THREE.Color('#74d3c4') },
              uOpacity: { value: 0 },
              uInner: { value: 0.99 },
            }}
          />
        </mesh>
      ))}
    </group>
  );
}
