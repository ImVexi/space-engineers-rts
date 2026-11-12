import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { currentLinkStyle } from '../lib/links';

export interface LinkPair {
  a: string;
  b: string;
  kind: 'radio' | 'laser';
  /** Provenance from the links view: measured in game vs planner maths. */
  label: 'GAME' | 'SIMULATED' | string;
}

interface LinkLayerProps {
  pairs: LinkPair[];
  /** scene-space points per `${a}-${b}-${kind}` key */
  geometry: Map<string, [number, number, number][]>;
  /** hop depth from the control source; radio dashes flow from deep to shallow */
  depth: Map<string, number>;
}

interface LineHandle {
  material?: {
    dashOffset?: number;
    opacity?: number;
    uniforms?: { dashOffset?: { value: number }; opacity?: { value: number } };
    transparent?: boolean;
  };
}

/**
 * T23 link styling: GAME links are solid and bright (they were measured in the
 * game: radio groups + Connected laser pairs). SIMULATED current links are
 * dimmer and dashed (planner range maths, never a measured link). Radio dashes
 * flow toward the receiver; laser edges shimmer only when they are GAME.
 * Pure decoration: no pointer handlers, so picking is untouched.
 */
export function LinkLayer({ pairs, geometry, depth }: LinkLayerProps) {
  return (
    <group name="link-layer">
      {pairs.map((pair) => {
        const points = geometry.get(`${pair.a}-${pair.b}-${pair.kind}`);
        if (!points) return null;
        const da = depth.get(pair.a) ?? Number.POSITIVE_INFINITY;
        const db = depth.get(pair.b) ?? Number.POSITIVE_INFINITY;
        // Flow toward the receiver: the shallow end (closer to the base) is
        // the last vertex, so a negative dash offset moves toward it.
        const ordered = db <= da ? points : [points[1], points[0]];
        return (
          <LinkLine
            key={`${pair.a}-${pair.b}-${pair.kind}`}
            points={ordered}
            kind={pair.kind}
            label={pair.label}
            lengthUnits={Math.hypot(
              points[1][0] - points[0][0],
              points[1][1] - points[0][1],
              points[1][2] - points[0][2],
            )}
          />
        );
      })}
    </group>
  );
}

function LinkLine({
  points,
  kind,
  label,
  lengthUnits,
}: {
  points: [number, number, number][];
  kind: 'radio' | 'laser';
  label: 'GAME' | 'SIMULATED' | string;
  lengthUnits: number;
}) {
  const ref = useRef<LineHandle | null>(null);
  const style = useMemo(() => currentLinkStyle({ kind, label }), [kind, label]);
  const dashSize = useMemo(
    () => (style.dashed ? Math.max(0.8, Math.min(60, lengthUnits * 0.02)) : 0),
    [style.dashed, lengthUnits],
  );
  const gap = dashSize * 0.8;

  useFrame(({ clock }) => {
    const material = ref.current?.material;
    if (!material) return;
    if (style.dashed) {
      // One dash every ~3 s drifting toward the receiver.
      const offset = -clock.elapsedTime * Math.max(0.8, dashSize) * 0.33;
      if (material.dashOffset !== undefined) material.dashOffset = offset;
      if (material.uniforms?.dashOffset) material.uniforms.dashOffset.value = offset;
    } else if (kind === 'laser') {
      // GAME laser: subtle shimmer, still one solid line.
      if (material.uniforms?.opacity) {
        material.uniforms.opacity.value = 0.82 + 0.08 * Math.sin(clock.elapsedTime * 1.7);
      } else if (material.opacity !== undefined) {
        material.opacity = 0.82 + 0.08 * Math.sin(clock.elapsedTime * 1.7);
      }
    }
  });

  return (
    <Line
      // drei forwards the ref to the Line2 object; only its material is used.
      ref={ref as never}
      points={points}
      color={style.color}
      lineWidth={style.lineWidth}
      transparent
      opacity={style.opacity}
      dashed={style.dashed}
      dashSize={dashSize}
      gapSize={gap}
      dashScale={1}
    />
  );
}

/**
 * Possible links (CONTRACT §1): dimmer, dashed, never animated. Same geometry
 * map shape as the current layer so the scene builds both the same way.
 */
export function PossibleLinkLayer({
  pairs,
  geometry,
}: {
  pairs: { a: string; b: string; kind: 'radio' | 'laser'; feasible: boolean }[];
  geometry: Map<string, [number, number, number][]>;
}) {
  return (
    <group name="possible-link-layer">
      {pairs.map((pair) => {
        const points = geometry.get(`${pair.a}-${pair.b}-${pair.kind}`);
        if (!points) return null;
        return (
          <Line
            key={`possible-${pair.a}-${pair.b}-${pair.kind}`}
            points={points}
            color={pair.kind === 'laser' ? '#8fa6e8' : '#c9a06a'}
            lineWidth={0.8}
            dashed
            dashSize={2.5}
            gapSize={2.2}
            dashScale={1}
            transparent
            opacity={pair.feasible ? 0.38 : 0.22}
          />
        );
      })}
    </group>
  );
}
