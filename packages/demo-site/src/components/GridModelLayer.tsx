import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { DemoNode } from '../types';
import type { SubtypeInfo, WorldGrid, WorldManifest } from '../lib/worldMapTypes';
import { toScene } from '../lib/sceneMath';
import { gridKey, livePos, poseQuat } from '../lib/pose';
import { LOD, LoadScheduler, planLod, type LodLevel } from '../lib/lod';
import { decodeSegb, type SegbAsset } from '../lib/segB';
import { buildEdgePositions, buildShapeGroups, type ShapeGroup } from '../lib/shapesInstances';
import { resolveSubtypeTable } from '../lib/subtypeInfo';
import { isTransparentShape, machineCoreGeometry, shapeGeometry, type ShapeClass } from '../lib/shapes';
import { publishDebug } from '../lib/debug';
import { publishDemoDebug } from '../lib/demoDebug';
import { fetchGridAsset } from '../lib/worldApi';

/**
 * Block-shape grid models, ported from the world map's BlockLayer/GridDetailLayer.
 *
 * Decoding (SEGB), the subtype_info shape table, block orientation and the
 * paint-vs-function colouring are unchanged. What is new for the demo: the
 * grid transform is the LIVE telemetry pose (position + whatever orientation
 * the backend can supply), not the save pose, so a moving satellite shows the
 * real hull where the dot used to be.
 *
 * LOD, same thresholds as the world map: far = the HTML marker (MapOverlay dot), mid =
 * wireframe bbox, near = instanced blocks. 8 km in / 12 km out hysteresis.
 */
export interface GridModelLayerProps {
  nodes: DemoNode[];
  manifest: WorldManifest | null;
  selectedIds: string[];
  visible: boolean;
  /** colour blocks by function instead of the saved paint */
  byFunction?: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onFocus: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  /** ids currently drawn as bbox/blocks (the parent hides their dot) */
  onDrawn?: (ids: string[]) => void;
}

function publishShapes(
  levels: Record<string, LodLevel>,
  assets: Record<string, SegbAsset>,
  entries: { node: DemoNode; grid: WorldGrid }[],
) {
  const out: Record<
    string,
    { level: LodLevel; instances: number; blocks: number; pos: { x: number; y: number; z: number }; asset: string; bboxKm: number }
  > = {};
  const byGrid = new Map(entries.map((e) => [e.grid.id, e]));
  for (const [id, level] of Object.entries(levels)) {
    const entry = byGrid.get(id);
    const b = entry?.grid.bbox_local;
    out[id] = {
      level,
      instances: assets[id]?.count ?? 0,
      blocks: assets[id]?.count ?? 0,
      pos: entry ? livePos(entry.node, entry.grid) : { x: 0, y: 0, z: 0 },
      asset: entry?.grid.asset ?? '',
      bboxKm: b?.min && b?.max
        ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 1000
        : 0,
    };
  }
  (window as unknown as { __demoShapes?: unknown }).__demoShapes = out;
}

export function GridModelLayer({
  nodes,
  manifest,
  selectedIds,
  visible,
  byFunction = false,
  onSelect,
  onFocus,
  onContextMenu,
  onDrawn,
}: GridModelLayerProps) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const byId = useMemo(() => new Map((manifest?.grids ?? []).map((g) => [g.id, g])), [manifest]);
  const [levels, setLevels] = useState<Record<string, LodLevel>>({});
  const [assets, setAssets] = useState<Record<string, SegbAsset>>({});
  const levelsRef = useRef<Record<string, LodLevel>>({});
  const assetsRef = useRef<Record<string, SegbAsset>>({});
  const scheduler = useRef(new LoadScheduler(LOD.maxConcurrent));
  const failedAt = useRef<Map<string, number>>(new Map());
  const lastTick = useRef(0);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const entries = useMemo(
    () =>
      nodes
        .map((node) => {
          const grid = byId.get(gridKey(node.id));
          if (!grid) return null;
          const b = grid.bbox_local;
          const bboxKm =
            b?.min && b?.max
              ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 1000
              : 0;
          return { node, grid, bboxKm };
        })
        .filter((v): v is { node: DemoNode; grid: WorldGrid; bboxKm: number } => v !== null),
    [nodes, byId],
  );
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const load = useCallback((grid: WorldGrid) => {
    if (assetsRef.current[grid.id] || scheduler.current.has(grid.id)) return;
    scheduler.current.schedule(grid.id, (done) => {
      const ac = new AbortController();
      fetchGridAsset(grid.asset, ac.signal)
        .then((buf) => {
          const asset = decodeSegb(buf);
          assetsRef.current = { ...assetsRef.current, [grid.id]: asset };
          failedAt.current.delete(grid.id);
          setAssets(assetsRef.current);
        })
        .catch((err: unknown) => {
          if (!(err instanceof DOMException && err.name === 'AbortError')) failedAt.current.set(grid.id, performance.now());
        })
        .finally(() => done());
      return () => ac.abort();
    });
  }, []);

  // New save hash: decoded bytes are stale.
  const hash = manifest?.save_hash ?? null;
  const hashRef = useRef<string | null>(null);
  useEffect(() => {
    if (hash === hashRef.current) return;
    hashRef.current = hash;
    scheduler.current.cancelAll();
    assetsRef.current = {};
    setAssets({});
    levelsRef.current = {};
    setLevels({});
    failedAt.current.clear();
  }, [hash]);

  useEffect(() => {
    return () => scheduler.current.cancelAll();
  }, []);

  // Report every grid whose geometry is actually in the scene: 'mid' draws the
  // bbox, 'near' draws blocks. Derived from the current entries (not the raw
  // level map) so a grid that vanished cannot linger in the parent's set.
  const drawnIds = useMemo(
    () =>
      !visible
        ? []
        : entries
            .filter(({ grid }) => (levels[grid.id] ?? 'far') !== 'far')
            .map(({ grid }) => `grid:${grid.id}`)
            .sort(),
    [entries, levels, visible],
  );
  const drawnKey = drawnIds.join(',');

  useEffect(() => {
    publishShapes(levelsRef.current, assetsRef.current, entriesRef.current);
    onDrawn?.(drawnIds);
    const lod = { far: 0, mid: 0, near: 0 };
    for (const { grid } of entries) lod[levels[grid.id] ?? 'far'] += 1;
    publishDemoDebug({ drawn: drawnIds.length, modeled: entries.length, lod });
    // drawnKey encodes the ids; entries/levels only matter through it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawnKey, visible, onDrawn]);

  useFrame(() => {
    if (!visible || !manifest) return;
    const now = performance.now();
    if (now - lastTick.current < 150) return;
    lastTick.current = now;

    const entriesNow = entriesRef.current;
    const cameraFov = 'fov' in camera ? (camera as THREE.PerspectiveCamera).fov : 50;
    // Pixels per km at 1 km: turns the grid's bbox diagonal into an on-screen
    // span, which is what decides whether blocks can actually be read.
    const pixelsPerKm = size.height / (2 * Math.tan((cameraFov * Math.PI) / 360));
    const plan = planLod(
      entriesNow.map(({ node, grid, bboxKm }) => ({ id: grid.id, ...toScene(livePos(node, grid)), bboxKm })),
      camera.position,
      levelsRef.current,
      LOD,
      pixelsPerKm,
    );

    let changed = false;
    for (const [id, level] of Object.entries(plan.levels)) {
      if (levelsRef.current[id] !== level) changed = true;
    }
    for (const id of Object.keys(levelsRef.current)) {
      if (!(id in plan.levels)) {
        delete levelsRef.current[id];
        changed = true;
      }
    }
    levelsRef.current = plan.levels;
    for (const id of plan.leaveNear) {
      if (id in assetsRef.current) {
        delete assetsRef.current[id];
        changed = true;
      }
    }
    for (const { grid } of entriesNow) {
      if (plan.levels[grid.id] !== 'near' || assetsRef.current[grid.id]) continue;
      const failed = failedAt.current.get(grid.id);
      if (failed != null && now - failed < 4000) continue;
      load(grid);
    }
    if (changed) {
      setLevels(plan.levels);
      setAssets(assetsRef.current);
      publishShapes(plan.levels, assetsRef.current, entriesNow);
    }
  });

  if (!visible) return null;

  const selected = new Set(selectedIds);
  return (
    <group name="grid-detail">
      {entries.map(({ node, grid }) => {
        const level = levels[grid.id] ?? 'far';
        if (level === 'far') return null;
        const pos = toScene(livePos(node, grid));
        const quat = poseQuat(node, grid);
        const asset = assets[grid.id];
        return (
          <group
            key={grid.id}
            name={`grid-model-${grid.id}`}
            position={[pos.x, pos.y, pos.z]}
            quaternion={quat}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(node.id, Boolean(event.nativeEvent.shiftKey));
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onFocus(node.id);
            }}
            onContextMenu={(event) => {
              event.stopPropagation();
              event.nativeEvent.preventDefault();
              onContextMenu(node.id, event.nativeEvent.clientX, event.nativeEvent.clientY);
            }}
          >
            {level === 'near' && asset ? (
              <NearGrid grid={grid} asset={asset} byFunction={byFunction} selected={selected.has(node.id)} />
            ) : (
              // Selection is brackets only: the bbox wireframe is the mid-LOD
              // model, never a second "selection ring" over it.
              !selected.has(node.id) && <BBox grid={grid} />
            )}
            {selected.has(node.id) && <CornerBrackets grid={grid} />}
          </group>
        );
      })}
    </group>
  );
}

function BBox({ grid }: { grid: WorldGrid }) {
  const min = grid.bbox_local.min;
  const max = grid.bbox_local.max;
  const size: [number, number, number] = [
    Math.max((max[0] - min[0]) / 1000, 0.02),
    Math.max((max[1] - min[1]) / 1000, 0.02),
    Math.max((max[2] - min[2]) / 1000, 0.02),
  ];
  const centre: [number, number, number] = [
    (min[0] + max[0]) / 2000,
    (min[1] + max[1]) / 2000,
    (min[2] + max[2]) / 2000,
  ];
  return (
    <mesh position={centre} name={`grid-bbox-${grid.id}`}>
      <boxGeometry args={size} />
      <meshBasicMaterial
        color="#74d3c4"
        wireframe
        transparent
        opacity={0.45}
        depthWrite={false}
      />
    </mesh>
  );
}

function CornerBrackets({ grid }: { grid: WorldGrid }) {
  // Thin world-space corner brackets: a screen-space-looking selection mark
  // that never wraps the hull in a filled shell.
  const geometry = useMemo(() => {
    const min = grid.bbox_local.min;
    const max = grid.bbox_local.max;
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const centre = [(min[0] + max[0]) / 2000, (min[1] + max[1]) / 2000, (min[2] + max[2]) / 2000];
    const half = size.map((s) => Math.max(s / 2000, 0.01));
    const arm = Math.min(0.3, Math.min(...half) * 0.55);
    const points: number[] = [];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const x = sx * half[0];
          const y = sy * half[1];
          const z = sz * half[2];
          points.push(x, y, z, x - sx * arm, y, z);
          points.push(x, y, z, x, y - sy * arm, z);
          points.push(x, y, z, x, y, z - sz * arm);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    return { g, centre };
  }, [grid]);
  return (
    <lineSegments geometry={geometry.g} position={geometry.centre as [number, number, number]}>
      <lineBasicMaterial color="#f4efe3" transparent opacity={0.85} depthWrite={false} />
    </lineSegments>
  );
}

function NearGrid({
  grid,
  asset,
  byFunction,
  selected,
}: {
  grid: WorldGrid;
  asset: SegbAsset;
  byFunction: boolean;
  selected: boolean;
}) {
  const table = useMemo<SubtypeInfo[]>(
    () => resolveSubtypeTable(grid.subtypes ?? [], grid.subtype_info ?? null),
    [grid.subtypes, grid.subtype_info],
  );
  const groups = useMemo(() => buildShapeGroups(asset, table, byFunction), [asset, table, byFunction]);
  return (
    <>
      {groups.map((group) => (
        <ShapeMesh key={group.shape} grid={grid} group={group} selected={selected} />
      ))}
      {groups
        .filter((g) => !isTransparentShape(g.shape as ShapeClass))
        .map((g) => (
          <BlockEdges key={`edges-${g.shape}`} grid={grid} group={g} selected={selected} />
        ))}
      {groups
        .filter((g) => g.shape === 'machine')
        .map((g) => (
          <MachineCores key={`core-${g.shape}`} grid={grid} group={g} />
        ))}
    </>
  );
}

function ShapeMesh({ grid, group, selected }: { grid: WorldGrid; group: ShapeGroup; selected: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(group.matrices, 16);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(group.colors, 3);
    mesh.count = group.count;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [group]);

  const shape = group.shape as ShapeClass;
  const transparent = isTransparentShape(shape);
  return (
    <instancedMesh
      ref={ref}
      name={`blocks-${grid.id}-${group.shape}`}
      args={[undefined, undefined, Math.max(1, group.count)]}
      geometry={shapeGeometry(shape)}
      frustumCulled={false}
    >
      <meshStandardMaterial
        color="#ffffff"
        emissive={selected ? '#2a2010' : '#000000'}
        emissiveIntensity={selected ? 0.7 : 0}
        flatShading
        roughness={0.82}
        metalness={0.06}
        transparent={transparent}
        opacity={transparent ? 0.42 : 1}
        depthWrite={!transparent}
        side={transparent ? THREE.DoubleSide : THREE.FrontSide}
      />
    </instancedMesh>
  );
}

/** Block outline: everything else is flat-lit, so edges carry the read. */
function BlockEdges({ grid, group, selected }: { grid: WorldGrid; group: ShapeGroup; selected: boolean }) {
  const positions = useMemo(() => buildEdgePositions(group, group.shape as ShapeClass), [group]);
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.computeBoundingSphere();
    return g;
  }, [positions]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineSegments name={`edges-${grid.id}-${group.shape}`} geometry={geometry} raycast={() => null}>
      <lineBasicMaterial
        color={selected ? '#f0d7a8' : '#0b1118'}
        transparent
        opacity={selected ? 0.85 : 0.6}
        depthWrite={false}
      />
    </lineSegments>
  );
}

function MachineCores({ grid, group }: { grid: WorldGrid; group: ShapeGroup }) {
  const ref = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(group.matrices, 16);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(group.colors, 3);
    mesh.count = group.count;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [group]);

  return (
    <instancedMesh
      ref={ref}
      name={`blocks-${grid.id}-machine-core`}
      args={[undefined, undefined, Math.max(1, group.count)]}
      geometry={machineCoreGeometry()}
      frustumCulled={false}
      raycast={() => null}
    >
      <meshLambertMaterial color="#ffffff" />
    </instancedMesh>
  );
}
