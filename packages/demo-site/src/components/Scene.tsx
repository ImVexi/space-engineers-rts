import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, Stars } from '@react-three/drei';
import * as THREE from 'three';
import type { DemoNode, DemoOption, FocusRequest, LinkGraph, Planet, Vec3 } from '../types';
import type { DesignerPreview } from '../lib/designer';
import type { TerrainPlanet, WorldManifest } from '../lib/worldMapTypes';
import { toScene } from '../lib/sceneMath';
import { gridKey } from '../lib/pose';
import { hullPxFor, worldRadiusForPx } from '../lib/markers';
import { publishDemoDebug } from '../lib/demoDebug';
import { planetPalette } from '../lib/planetPalette';
import { CameraControls, type CameraApi } from './CameraControls';
import type { CameraContext } from '../lib/cameraContext';
import { TerrainLayer } from './TerrainLayer';
import { GridModelLayer } from './GridModelLayer';
import { LinkLayer, PossibleLinkLayer } from './LinkLayer';
import { CoverageLayer, type CoverageDatum } from './CoverageLayer';
import { currentLinkPairs } from '../lib/links';
import type { PossibleLink } from '../lib/links';
import type { CurrentLink, LinkMode } from '../lib/links';
import { RadioRings } from './RadioRings';

export interface Overlays {
  radioSpheres: boolean;
  /** T23 true-scale radio range pulse rings */
  radioRings: boolean;
  /** T44 coverage heatmap on the planet skin */
  coverage: boolean;
  /** current vs possible link overlay */
  linkMode: LinkMode;
  laserLinks: boolean;
  reachableColours: boolean;
  labels: boolean;
  /** extension slot for planet heightmaps (on by default) */
  terrain: boolean;
  /** real ship shapes (SEGB block models) instead of dots/boxes */
  shapes: boolean;
  /** colour blocks by block function instead of the saved paint */
  blockByFunction: boolean;
}

export interface SceneProps {
  planets: Planet[];
  nodes: DemoNode[];
  graph: LinkGraph;
  selectedIds: string[];
  preview: DemoOption | null;
  /** Planner option geometry in metres, distinct from live grids. */
  designerPreview: DesignerPreview | null;
  highlight: string[];
  overlays: Overlays;
  /** true while a flow wants the next map click as a destination */
  pickMode: boolean;
  pickMarker: Vec3 | null;
  focus: FocusRequest | null;
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
  /** metres; follow mode translates with this point */
  followPos: Vec3 | null;
  /** TEST-world block geometry (save manifest); null until it loads */
  manifest: WorldManifest | null;
  /** available terrain heightmaps for the test world */
  terrainPlanets: TerrainPlanet[] | null;
  /** ids drawn as bbox/blocks; their dot is hidden to avoid overlap */
  drawnIds: string[];
  /** active camera level: pivot + local up for the rig */
  context: CameraContext;
  /** imperative handle for explicit context entry / pose restore */
  cameraApiRef?: React.MutableRefObject<CameraApi | null>;
  /** highlighted pivot (context level) for the hull probe */
  pivot: { id: string; label: string; pos: Vec3 } | null;
  /** Fly mode toggles right-drag look and camera-relative WASD */
  flyMode: boolean;
  /** T23 pulse period in seconds; null hides the rings */
  pulsePeriod: number | null;
  /** current links exactly as the links route reports them (GAME or SIMULATED) */
  currentLinks: CurrentLink[];
  /** possible (not yet existing) links, drawn dimmer and dashed */
  possibleLinks: PossibleLink[];
  /** coverage grid for one planet */
  coverageData: CoverageDatum | null;
  /** T51.2: the constellation panel's proposed layout heatmap outranks the live one */
  previewCoverageData?: CoverageDatum | null;
  onCoverageCell: (planet: Planet, latDeg: number, lonDeg: number) => void;
  /** the coverage mesh's own approximate warning (null = terrain-draped) */
  onCoverageTerrainReport?: (notice: string | null) => void;
  /** coloured bracket around the active group's members, scene km */
  groupBracket: { color: string; center: Vec3; size: Vec3; members: number } | null;
  onDrawn: (ids: string[]) => void;
  onSelect: (id: string, additive: boolean) => void;
  onPickSurface: (planet: string, pos: Vec3) => void;
  onContextMenuShip: (id: string, x: number, y: number) => void;
  onContextMenuSurface: (planet: string | null, pos: Vec3, x: number, y: number) => void;
  onFocusNode: (id: string) => void;
  onFocusPoint: (pos: Vec3, label: string, radiusKm: number) => void;
  /** left click on empty space */
  onBackground: () => void;
}

const KM = 1000;

interface PlanetMeshProps {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  hasAtmosphere: boolean;
  selected: boolean;
  pickMode: boolean;
  /** terrain tiles cover this planet: hide the plain sphere, keep picking */
  terrain: boolean;
  onPickSurface: (planet: string, pos: Vec3) => void;
  onContextMenu: (planet: string, pos: Vec3, x: number, y: number) => void;
  onFocus: () => void;
}

const PlanetMesh = memo(function PlanetMesh({
  name,
  x,
  y,
  z,
  radius,
  hasAtmosphere,
  selected,
  pickMode,
  terrain,
  onPickSurface,
  onContextMenu,
  onFocus,
}: PlanetMeshProps) {
  const palette = planetPalette(name);
  const surfaceOf = (point: { x: number; y: number; z: number }): Vec3 => ({
    x: point.x * KM,
    y: point.y * KM,
    z: point.z * KM,
  });
  const pickHandlers = {
    onClick: (event: { stopPropagation: () => void; point: { x: number; y: number; z: number } }) => {
      event.stopPropagation();
      if (pickMode) onPickSurface(name, surfaceOf(event.point));
      else onFocus();
    },
    onDoubleClick: (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      onFocus();
    },
    onContextMenu: (event: {
      stopPropagation: () => void;
      nativeEvent: { preventDefault: () => void; clientX: number; clientY: number };
      point: { x: number; y: number; z: number };
    }) => {
      event.stopPropagation();
      event.nativeEvent.preventDefault();
      onContextMenu(name, surfaceOf(event.point), event.nativeEvent.clientX, event.nativeEvent.clientY);
    },
  };
  return (
    <group>
      {terrain ? (
        // Invisible sphere keeps planet picking (surface taps) working under
        // the heightmap tiles without drawing a shell over them.
        <mesh position={[x, y, z]} {...pickHandlers}>
          <sphereGeometry args={[radius, 32, 20]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
        </mesh>
      ) : (
        <mesh position={[x, y, z]} {...pickHandlers}>
          <sphereGeometry args={[radius, 48, 32]} />
          <meshStandardMaterial
            color={palette.base}
            emissive={palette.accent}
            emissiveIntensity={selected ? 0.35 : 0.08}
            roughness={0.9}
            metalness={0.05}
          />
        </mesh>
      )}
      {!terrain && (
        <mesh position={[x, y, z]} userData={{ noPick: true }} raycast={() => null}>
          <sphereGeometry args={[radius * 1.015, 32, 24]} />
          <meshBasicMaterial color={selected ? '#e6b878' : palette.accent} wireframe transparent opacity={selected ? 0.35 : 0.08} />
        </mesh>
      )}
      {hasAtmosphere && (
        <mesh position={[x, y, z]} userData={{ noPick: true }} raycast={() => null}>
          <sphereGeometry args={[radius * 1.06, 32, 24]} />
          <meshBasicMaterial color={palette.accent} transparent opacity={0.05} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
});

/**
 * World-anchored, screen-clamped marker group (CONTRACT-HULL).
 *
 * The dot's world radius is the grid bbox diagonal × 0.6, projected to 3–18 px,
 * so a 10 m satellite is a speck and a 300-block ship is a bigger dot — never a
 * fixed 1 km bubble over the hull. Halo geometry also fades out between 3× and
 * 1.5× the bbox so nothing can wrap a visible model even if a marker survives.
 */
function MarkerGroup({
  pos,
  bboxKm,
  children,
}: {
  pos: { x: number; y: number; z: number };
  bboxKm: number;
  children: React.ReactNode;
}) {
  const ref = useRef<THREE.Group>(null);
  const fade = useRef(1);
  const bases = useRef<{ m: THREE.Material; base: number }[]>([]);

  useEffect(() => {
    const g = ref.current;
    if (!g) return;
    const list: { m: THREE.Material; base: number }[] = [];
    g.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (!m || Array.isArray(m)) return;
      if (!('opacity' in m)) return;
      m.transparent = true;
      list.push({ m, base: m.opacity });
    });
    bases.current = list;
  }, []);

  useFrame(({ camera, size }) => {
    const g = ref.current;
    if (!g) return;
    const d = camera.position.distanceTo(g.position); // scene km
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 50;
    const px = hullPxFor(bboxKm * KM, d * KM, fov, size.height);
    const r = worldRadiusForPx(px, d, fov, size.height);
    g.scale.setScalar(Math.max(r, 1e-6));

    let k = 1;
    if (bboxKm > 0) {
      const near = bboxKm * 1.5;
      const far = bboxKm * 3;
      k = d <= near ? 0 : d >= far ? 1 : (d - near) / (far - near);
    }
    g.visible = k > 0.02;
    if (Math.abs(k - fade.current) > 0.02) {
      fade.current = k;
      for (const { m, base } of bases.current) m.opacity = base * k;
    }
  });

  return (
    <group ref={ref} position={[pos.x, pos.y, pos.z]} userData={{ halo: true }}>
      {children}
    </group>
  );
}

/**
 * Focus probe: how many halo groups (markers, shells, rings) sit within 2× the
 * focused grid's bbox. A focused hull must report 0 — that is the close-range
 * regression the owner screenshot captured.
 */
function HullProbe({
  focusId,
  focusPos,
  hullKm,
}: {
  focusId: string | null;
  focusPos: { x: number; y: number; z: number } | null;
  hullKm: Map<string, number>;
}) {
  const scene = useThree((s) => s.scene);
  const last = useRef(0);
  const v = useMemo(() => new THREE.Vector3(), []);
  const bbox = focusId ? hullKm.get(focusId) ?? 0 : 0;

  useFrame(({ clock }) => {
    const now = clock.elapsedTime;
    if (now - last.current < 0.5) return;
    last.current = now;
    let n = 0;
    if (bbox > 0 && focusPos) {
      const limit = bbox * 2;
      const centre = new THREE.Vector3(focusPos.x, focusPos.y, focusPos.z);
      scene.traverse((obj) => {
        if (!obj.userData?.halo || !obj.visible) return;
        obj.getWorldPosition(v);
        if (v.distanceTo(centre) <= limit) n += 1;
      });
    }
    publishDemoDebug({ haloNearFocus: n, focused: focusId });
  });
  return null;
}

export function Scene(props: SceneProps) {
  const {
    planets,
    nodes,
    graph,
    selectedIds,
    preview,
    designerPreview,
    highlight,
    overlays,
    pickMode,
    pickMarker,
    focus,
    cameraRef,
    followPos,
    manifest,
    terrainPlanets,
    drawnIds,
    pivot,
    context,
    cameraApiRef,
    flyMode,
    pulsePeriod,
    currentLinks,
    possibleLinks,
    coverageData,
    previewCoverageData,
    onCoverageCell,
    onCoverageTerrainReport,
    groupBracket,
    onDrawn,
    onSelect,
    onPickSurface,
    onContextMenuShip,
    onContextMenuSurface,
    onFocusNode,
    onFocusPoint,
    onBackground,
  } = props;

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const drawn = useMemo(() => new Set(drawnIds), [drawnIds]);
  const covered = useMemo(
    () => new Set((terrainPlanets ?? []).filter((p) => p.available).map((p) => p.id)),
    [terrainPlanets],
  );

  // Hull sizes straight from the save manifest: bbox diagonal in metres, keyed
  // by node id. Marker size and the close-range fade both derive from this.
  const hullM = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of manifest?.grids ?? []) {
      const b = g.bbox_local;
      const diag = b?.min && b?.max
        ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])
        : 0;
      map.set(`grid:${g.id}`, diag);
    }
    return map;
  }, [manifest]);
  const hullKm = useMemo(() => {
    const map = new Map<string, number>();
    for (const [id, m] of hullM) map.set(id, m / KM);
    return map;
  }, [hullM]);

  // A grid that exists in the manifest has (or will have) a block model; its
  // 3D marker is suppressed entirely so no sphere/torus can wrap the hull.
  const modeled = useMemo(
    () => new Set(nodes.filter((n) => hullM.has(n.id)).map((n) => n.id)),
    [nodes, hullM],
  );

  const markerNodes = useMemo(
    () => nodes.filter((n) => n.status === 'alive' && !modeled.has(n.id) && !drawn.has(n.id)),
    [nodes, modeled, drawn],
  );

  useEffect(() => {
    publishDemoDebug({ markers: markerNodes.length, modeled: modeled.size, drawn: drawnIds.length });
  }, [markerNodes.length, modeled.size, drawnIds.length]);


  const linkPairs = useMemo(() => {
    if (overlays.linkMode !== 'current' && overlays.linkMode !== 'both') return [];
    // CONTRACT §1: current edges come from the links route's `current` array,
    // not the planner graph. The label (GAME / SIMULATED) travels with the
    // pair so the map can style measured and simulated links differently.
    // Endpoints missing from this scene are dropped here, never drawn at (0,0,0).
    return currentLinkPairs(
      { current: currentLinks, possible: [] },
      { nodeIds: new Set(nodeById.keys()), laser: overlays.laserLinks },
    );
  }, [currentLinks, nodeById, overlays.laserLinks, overlays.linkMode]);

  // Possible edges: same coordinate signature trick, no animation on them.
  const possibleSig = useMemo(() => {
    if (overlays.linkMode !== 'possible' && overlays.linkMode !== 'both') return '';
    return possibleLinks
      .map((l) => {
        const pa = nodeById.get(l.a)?.position;
        const pb = nodeById.get(l.b)?.position;
        return `${l.a}-${l.b}-${l.kind}:${pa ? `${pa.x},${pa.y},${pa.z}` : '?'}>${pb ? `${pb.x},${pb.y},${pb.z}` : '?'}`;
      })
      .join('|');
  }, [possibleLinks, overlays.linkMode, nodeById]);
  const possibleGeometry = useMemo(() => {
    const out = new Map<string, [number, number, number][]>();
    if (overlays.linkMode !== 'possible' && overlays.linkMode !== 'both') return out;
    for (const pair of possibleLinks) {
      const a = nodeById.get(pair.a);
      const b = nodeById.get(pair.b);
      if (!a || !b) continue;
      const pa = toScene(a.position);
      const pb = toScene(b.position);
      out.set(`${pair.a}-${pair.b}-${pair.kind}`, [
        [pa.x, pa.y, pa.z],
        [pb.x, pb.y, pb.z],
      ]);
    }
    return out;
    // possibleSig encodes the coordinates this map depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [possibleSig, overlays.linkMode]);
  const bracketGeo = useMemo(() => {
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    return geo;
  }, []);

  // Polling hands us new node objects every 2 s; key line geometry on a
  // coordinate signature so unchanged links are not rebuilt (no flicker).
  const linkSig = useMemo(() => {
    const of = (id: string) => {
      const n = nodeById.get(id);
      return n ? `${n.position.x},${n.position.y},${n.position.z}` : '?';
    };
    return linkPairs.map((p) => `${p.a}-${p.b}-${p.kind}:${of(p.a)}>${of(p.b)}`).join('|');
  }, [linkPairs, nodeById]);
  const linkGeometry = useMemo(() => {
    const out = new Map<string, [number, number, number][]>();
    for (const pair of linkPairs) {
      const a = nodeById.get(pair.a);
      const b = nodeById.get(pair.b);
      if (!a || !b) continue;
      const pa = toScene(a.position);
      const pb = toScene(b.position);
      out.set(`${pair.a}-${pair.b}-${pair.kind}`, [
        [pa.x, pa.y, pa.z],
        [pb.x, pb.y, pb.z],
      ]);
    }
    return out;
    // linkSig encodes every coordinate linkPairs/nodeById could contribute
  }, [linkSig]);

  // Hop depth from the control source: radio dash flow runs from the far end
  // toward the base, which is what "toward the receiver" means on the map.
  const linkDepth = useMemo(() => {
    const depth = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const edge of graph.edges) {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
      if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
      adjacency.get(edge.from)!.push(edge.to);
      adjacency.get(edge.to)!.push(edge.from);
    }
    const queue: string[] = [];
    for (const n of graph.nodes) {
      if (n.controlSource) {
        depth.set(n.id, 0);
        queue.push(n.id);
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      const d = depth.get(id) ?? 0;
      for (const next of adjacency.get(id) ?? []) {
        if (!depth.has(next)) {
          depth.set(next, d + 1);
          queue.push(next);
        }
      }
    }
    return depth;
  }, [graph]);

  const ringNodes = useMemo(
    () =>
      nodes
        .filter((n) => n.status === 'alive' && (n.capability?.radioRadiusM ?? 0) > 0)
        .map((n) => ({ id: n.id, position: n.position, radioRadiusM: n.capability?.radioRadiusM ?? null, reachable: n.reachable })),
    [nodes],
  );

  const mid = useMemo(() => {
    if (!planets.length) return { x: 0, y: 0, z: 0 };
    const xs = planets.map((p) => p.center.x);
    const ys = planets.map((p) => p.center.y);
    const zs = planets.map((p) => p.center.z);
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2 / KM,
      y: (Math.min(...ys) + Math.max(...ys)) / 2 / KM,
      z: (Math.min(...zs) + Math.max(...zs)) / 2 / KM,
    };
  }, [planets]);

  // Frozen once: a new camera array on every poll can reset a live camera.
  // `near` is 5 m so a focused hull at ~1 km is not clipped; logarithmic depth
  // keeps that usable against a 400 000 km far plane.
  const [initialCamera] = useState(() => ({
    position: [mid.x + 2500, mid.y + 2600, mid.z + 4200] as [number, number, number],
    fov: 50,
    far: 400_000,
    near: 0.005,
  }));

  // Stable callbacks keep memoised planet meshes from re-rendering on polls.
  const handlers = useRef(props);
  handlers.current = props;
  const onPlanetFocus = useCallback((pos: Vec3, label: string, radiusKm: number) => handlers.current.onFocusPoint(pos, label, radiusKm), []);

  return (
    <Canvas
      camera={initialCamera}
      dpr={[1, 2]}
      gl={{ antialias: true, logarithmicDepthBuffer: true }}
      data-testid="demo-canvas"
      // A right-click belongs to the context-menu gate; background clearing is
      // a left-click gesture and must not close the menu that just opened.
      onPointerMissed={(event) => {
        if (event.button === 2) return;
        handlers.current.onBackground();
      }}
      onCreated={({ camera }) => {
        cameraRef.current = camera;
      }}
    >
      <color attach="background" args={['#050914']} />
      {/* Ambient is deliberately high: half of every planet faces away from the
          single sun, and a focused base there was rendering almost black. */}
      <ambientLight intensity={1.45} />
      <directionalLight position={[4000, 6000, 3000]} intensity={1.1} />
      <directionalLight position={[-4000, -3000, -2500]} intensity={0.45} color="#b8c8ff" />
      <Stars radius={12000} depth={600} count={4000} factor={22} saturation={0} fade speed={0.4} />
      <CameraControls
        focus={focus}
        planets={planets}
        followPos={followPos}
        context={context}
        apiRef={cameraApiRef}
        flyMode={flyMode}
        defaultPivot={(planets.find((p) => p.name === 'EarthLike') ?? planets[0])?.center ?? null}
      />

      {planets.map((planet) => (
        <PlanetMesh
          key={planet.id}
          id={planet.id}
          name={planet.name}
          x={planet.center.x / KM}
          y={planet.center.y / KM}
          z={planet.center.z / KM}
          radius={(planet.surfaceRadiusM && planet.surfaceRadiusM > 0 ? planet.surfaceRadiusM : planet.maxHillRadiusM) / KM}
          hasAtmosphere={planet.hasAtmosphere}
          selected={false}
          pickMode={pickMode}
          terrain={overlays.terrain && covered.has(planet.id)}
          onPickSurface={(name, pos) => handlers.current.onPickSurface(name, pos)}
          onContextMenu={(name, pos, x, y) => handlers.current.onContextMenuSurface(name, pos, x, y)}
          onFocus={() =>
            onPlanetFocus(planet.center, planet.name, planet.maxHillRadiusM / KM)
          }
        />
      ))}

      {/*
        Extension slots. Terrain draws under everything; grid models draw over
        the planet but before links/markers. Both are pure geometry and never
        touch the camera, so the polling rule stays intact.
      */}
      <TerrainLayer
        planets={planets}
        terrainPlanets={terrainPlanets}
        visible={overlays.terrain}
        quality="medium"
      />
      <GridModelLayer
        nodes={nodes}
        manifest={manifest}
        selectedIds={selectedIds}
        visible={overlays.shapes}
        byFunction={overlays.blockByFunction}
        onSelect={(id, additive) => handlers.current.onSelect(id, additive)}
        onFocus={(id) => handlers.current.onFocusNode(id)}
        onContextMenu={(id, x, y) => handlers.current.onContextMenuShip(id, x, y)}
        onDrawn={(ids) => handlers.current.onDrawn(ids)}
      />

      {overlays.linkMode !== 'off' && (
        <>
          <LinkLayer pairs={linkPairs} geometry={linkGeometry} depth={linkDepth} />
          {(overlays.linkMode === 'possible' || overlays.linkMode === 'both') && (
            <PossibleLinkLayer pairs={possibleLinks} geometry={possibleGeometry} />
          )}
        </>
      )}

      <CoverageLayer
        planets={planets}
        terrainPlanets={terrainPlanets}
        data={previewCoverageData ?? coverageData}
        visible={overlays.coverage}
        onCellPick={onCoverageCell}
        onTerrainReport={onCoverageTerrainReport}
      />

      {groupBracket && (
        <lineSegments
          geometry={bracketGeo}
          position={[groupBracket.center.x / KM, groupBracket.center.y / KM, groupBracket.center.z / KM]}
          scale={[groupBracket.size.x / KM, groupBracket.size.y / KM, groupBracket.size.z / KM]}
          name="group-bracket"
          renderOrder={4}
        >
          <lineBasicMaterial color={groupBracket.color} transparent opacity={0.9} depthWrite={false} />
        </lineSegments>
      )}

      {overlays.radioRings && pulsePeriod !== null && (
        <RadioRings
          nodes={ringNodes}
          selectedIds={selectedIds}
          drawnIds={drawnIds}
          modeledIds={Array.from(modeled)}
          visible={overlays.radioRings}
          period={pulsePeriod}
        />
      )}

      {/* Radio range is an explicit opt-in overlay. Even then it is three thin
          outline rings, never a filled/wireframe sphere over a hull. */}
      {overlays.radioSpheres &&
        nodes
          .filter((n) => n.status === 'alive' && (n.capability?.radioRadiusM ?? 0) > 0)
          .map((node) => {
            const p = toScene(node.position);
            const r = (node.capability?.radioRadiusM ?? 0) / KM;
            const colour = overlays.reachableColours && !node.reachable ? '#d8a45b' : '#3f8f68';
            const planes: [number, number, number][] = [
              [0, 0, 0],
              [Math.PI / 2, 0, 0],
              [0, Math.PI / 2, 0],
            ];
            return (
              <group
                key={`radio-${node.id}`}
                name={`radio-${node.id}`}
                position={[p.x, p.y, p.z]}
                userData={{ halo: true, radio: true, bboxKm: hullKm.get(node.id) ?? 0 }}
              >
                {planes.map((rotation, i) => (
                  <mesh key={i} rotation={rotation} raycast={() => null}>
                    <ringGeometry args={[r * 0.997, r, 128, 1]} />
                    <meshBasicMaterial
                      color={colour}
                      transparent
                      opacity={0.16}
                      side={THREE.DoubleSide}
                      depthWrite={false}
                    />
                  </mesh>
                ))}
              </group>
            );
          })}

      {markerNodes.map((node) => {
        const p = toScene(node.position);
        const isSelected = selected.has(node.id);
        const telemetry = node.telemetry ?? null;
        const isGame = node.source === 'GAME' && Boolean(telemetry);
        const isStale = Boolean(telemetry) && telemetry!.ageMs > 60_000;
        // No red "SPOF" ring any more: single points of failure are a small
        // icon + tooltip in the HTML overlay, not a scary outline.
        const colour = isSelected
          ? '#e6b878'
          : isGame
            ? isStale
              ? '#6b7280'
              : '#74d3c4'
            : overlays.reachableColours
              ? node.reachable
                ? '#8fbf9e'
                : '#d8a45b'
              : '#9aa3ab';
        return (
          <MarkerGroup key={node.id} pos={p} bboxKm={hullKm.get(node.id) ?? 0}>
            <mesh
              name={`marker-${node.id}`}
              onClick={(event) => {
                // Ignore the click that ends an orbit drag: selection must never
                // change because the drag started on a ship.
                const moved = (event as unknown as { delta?: number }).delta ?? 0;
                if (moved > 5) return;
                event.stopPropagation();
                handlers.current.onSelect(node.id, Boolean(event.nativeEvent.shiftKey));
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                handlers.current.onFocusNode(node.id);
              }}
              onContextMenu={(event) => {
                event.stopPropagation();
                event.nativeEvent.preventDefault();
                handlers.current.onContextMenuShip(node.id, event.nativeEvent.clientX, event.nativeEvent.clientY);
              }}
            >
              <sphereGeometry args={[1, 16, 12]} />
              <meshStandardMaterial
                color={colour}
                emissive={colour}
                emissiveIntensity={isSelected ? 1.1 : isGame && !isStale ? 0.85 : 0.5}
                transparent
              />
            </mesh>
          </MarkerGroup>
        );
      })}

      <HullProbe
        focusId={(pivot?.id ?? selectedIds[0]) || null}
        focusPos={
          pivot?.pos
            ? toScene(pivot.pos)
            : (() => {
                const id = selectedIds[0];
                const n = id ? nodeById.get(id) : null;
                return n ? toScene(n.position) : null;
              })()
        }
        hullKm={hullKm}
      />

      {preview &&
        preview.nodes.map((node) => {
          const p = toScene(node.position);
          const colour = node.role === 'station' ? '#e6b878' : node.role === 'laser-bridge' ? '#74d3c4' : '#8affc1';
          return (
            <mesh key={`preview-${node.id}`} position={[p.x, p.y, p.z]}>
              <sphereGeometry args={[0.9, 10, 8]} />
              <meshBasicMaterial color={colour} transparent opacity={0.85} />
            </mesh>
          );
        })}

      {designerPreview &&
        designerPreview.slots.map((slot) => {
          const p = toScene(slot.pos);
          return (
            <group key={`designer-slot-${slot.id}`} position={[p.x, p.y, p.z]}>
              <mesh>
                <octahedronGeometry args={[1.35, 0]} />
                <meshBasicMaterial color="#ff7ce5" wireframe transparent opacity={0.95} />
              </mesh>
            </group>
          );
        })}

      {designerPreview &&
        designerPreview.links.map((link) => {
          const a = designerPreview.slots.find((s) => s.id === link.from);
          const b = designerPreview.slots.find((s) => s.id === link.to);
          if (!a || !b) return null;
          const pa = toScene(a.pos);
          const pb = toScene(b.pos);
          return (
            <Line
              key={`designer-link-${link.from}-${link.to}-${link.kind}`}
              points={[
                [pa.x, pa.y, pa.z],
                [pb.x, pb.y, pb.z],
              ]}
              color={link.kind === 'laser' ? '#b98bff' : '#ff7ce5'}
              lineWidth={1.9}
              dashed={link.kind === 'radio'}
              dashSize={16}
              dashScale={1}
              transparent
              opacity={0.9}
            />
          );
        })}

      {pickMarker && (
        <group position={[pickMarker.x / KM, pickMarker.y / KM, pickMarker.z / KM]}>
          <mesh>
            <sphereGeometry args={[1.6, 12, 10]} />
            <meshBasicMaterial color="#e6b878" />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[4, 0.16, 8, 32]} />
            <meshBasicMaterial color="#e6b878" transparent opacity={0.8} />
          </mesh>
        </group>
      )}
    </Canvas>
  );
}

export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
