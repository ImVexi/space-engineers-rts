import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { DemoNode, Planet } from '../types';
import {
  clusterBadgePx,
  hullPxFor,
  layoutOverlay,
  layoutPlanetLabels,
  LIVE_MS,
  markerPxFor,
  type GridLabel,
  type OverlayLayout,
  type PlanetLabel,
  type ScreenNode,
  type ScreenPlanet,
} from '../lib/markers';
import { segmentBlockedBySphere } from '../lib/sceneMath';

export interface MapOverlayProps {
  nodes: DemoNode[];
  planets: Planet[];
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
  selectedIds: string[];
  /** naming-service names by grid id */
  names: Record<string, string>;
  /** ids drawn as block/bbox geometry: hide their dot, keep their label */
  drawnIds: string[];
  /** node id -> hull bbox diagonal in metres (marker size anchor) */
  hullM?: Record<string, number>;
  showStale: boolean;
  showLabels: boolean;
  /** T23: show the real radio range next to the marker tooltip */
  radioRings?: boolean;
  /** hover id from the zoom-scaled pick (same ranking as click) */
  hoverId?: string | null;
  spofs: string[];
  onSelect: (id: string, additive: boolean) => void;
  onFocus: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
}

const KM = 1000;
const EMPTY: OverlayLayout = { dots: [], clusters: [], labels: [], counts: { live: 0, stale: 0 } };

function ageLabel(ageSec: number): string {
  if (!Number.isFinite(ageSec)) return '—';
  if (ageSec < 1) return 'now';
  if (ageSec < 90) return `${Math.round(ageSec)}s`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m`;
  return `${Math.round(ageSec / 3600)}h`;
}

/**
 * HTML overlay that owns every grid/planet label and marker.
 *
 * Keeping labels out of WebGL gives constant pixel size at any zoom, exact
 * declutter math and one label layer, so UI chrome always wins the z-order.
 * Markers/labels take left click (select), shift-click (add) and right click
 * (context menu) directly — no separate list to hunt through.
 */
export function MapOverlay({
  nodes,
  planets,
  cameraRef,
  selectedIds,
  names,
  drawnIds,
  hullM,
  showStale,
  showLabels,
  radioRings,
  hoverId = null,
  spofs,
  onSelect,
  onFocus,
  onContextMenu,
}: MapOverlayProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [layout, setLayout] = useState<OverlayLayout>(EMPTY);
  const [planetLabels, setPlanetLabels] = useState<PlanetLabel[]>([]);
  const [cameraAttr, setCameraAttr] = useState('');
  const signatureRef = useRef('');

  const selectedKey = selectedIds.join(',');
  const nameKey = useMemo(() => Object.keys(names).sort().map((k) => `${k}=${names[k]}`).join('|'), [names]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const rect = host.getBoundingClientRect();
      setSize((prev) =>
        Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5
          ? prev
          : { width: rect.width, height: rect.height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedKey]);
  // The pick-based hover wins over the per-marker mouseenter: it comes from the
  // same radius the click uses, so "highlighted" means "clickable".
  const activeHover = hoverId ?? hoveredId;
  const drawn = useMemo(() => new Set(drawnIds), [drawnIds]);

  useEffect(() => {
    if (!size.width || !size.height) return;
    let raf = 0;
    let lastRun = 0;
    const v = new THREE.Vector3();
    const camSpace = new THREE.Vector3();
    const worldPos = new THREE.Vector3();

    const tick = (time: number) => {
      raf = requestAnimationFrame(tick);
      if (time - lastRun < 45) return;
      lastRun = time;
      const camera = cameraRef.current;
      if (!camera) return;
      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      const height = size.height;
      const width = size.width;
      const fov = 'fov' in camera ? (camera as THREE.PerspectiveCamera).fov : 50;
      const tanHalf = Math.tan((fov * Math.PI) / 360);

      const screenNodes: ScreenNode[] = [];
      for (const node of nodes) {
        const wx = node.position.x / KM;
        const wy = node.position.y / KM;
        const wz = node.position.z / KM;
        camSpace.set(wx, wy, wz).applyMatrix4(camera.matrixWorldInverse);
        const inFront = camSpace.z < -0.05;
        v.set(wx, wy, wz).project(camera);
        const onScreen = Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05;
        const telemetry = node.telemetry ?? null;
        const ageMs = telemetry ? telemetry.ageMs : Number.POSITIVE_INFINITY;
        const distanceKm = camera.position.distanceTo(worldPos.set(wx, wy, wz));
        const depthKm = Math.max(0.001, -camSpace.z);
        // A grid behind the planet must not draw its marker over the limb.
        let occluded = false;
        for (const planet of planets) {
          if (
            segmentBlockedBySphere(
              camera.position,
              { x: wx, y: wy, z: wz },
              { x: planet.center.x / KM, y: planet.center.y / KM, z: planet.center.z / KM },
              planet.surfaceRadiusM / KM,
            )
          ) {
            occluded = true;
            break;
          }
        }
        screenNodes.push({
          id: node.id,
          name: names[node.id] ?? node.name,
          visible: inFront && onScreen && !occluded,
          x: inFront ? (v.x * 0.5 + 0.5) * width : -9999,
          y: inFront ? (-v.y * 0.5 + 0.5) * height : -9999,
          world: node.position,
          live: Boolean(telemetry) && ageMs <= LIVE_MS,
          moving: Boolean(telemetry?.moving),
          speedMps: telemetry?.speedMps ?? 0,
          ageSec: ageMs / 1000,
          owner: telemetry?.ownership ?? null,
          isGame: node.source === 'GAME',
          spof: spofs.includes(node.id),
          isolated: !node.reachable,
          distance: distanceKm,
          sizePx: hullPxFor(hullM?.[node.id] ?? 0, depthKm * KM, fov, height),
        });
      }

      const screenPlanets: ScreenPlanet[] = [];
      for (const planet of planets) {
        const wx = planet.center.x / KM;
        const wy = planet.center.y / KM;
        const wz = planet.center.z / KM;
        camSpace.set(wx, wy, wz).applyMatrix4(camera.matrixWorldInverse);
        if (camSpace.z > -0.05) continue;
        const dist = camera.position.distanceTo(v.set(wx, wy, wz));
        v.set(wx, wy, wz).project(camera);
        if (v.x < -1.5 || v.x > 1.5 || v.y < -1.5 || v.y > 1.5) continue;
        const radiusKm = planet.maxHillRadiusM / KM;
        screenPlanets.push({
          id: planet.id,
          name: planet.name,
          x: (v.x * 0.5 + 0.5) * width,
          y: (-v.y * 0.5 + 0.5) * height,
          radiusPx: dist > 0 ? (radiusKm / (dist * tanHalf)) * (height / 2) : 0,
          selected: false,
        });
      }

      const next = layoutOverlay(screenNodes, {
        width,
        height,
        selectedId: selectedIds[selectedIds.length - 1] ?? null,
        selectedIds,
        hoveredId,
        showStale,
        drawnIds,
      });
      if (!showLabels) next.labels = [];
      const nextPlanetLabels = layoutPlanetLabels(
        screenPlanets,
        width,
        height,
        next.labels.map((l) => ({ x: l.x, y: l.y, w: l.w, h: l.h })),
      );

      const signature = JSON.stringify([
        Math.round(width),
        Math.round(height),
        next.counts.live,
        next.counts.stale,
        selectedKey,
        nameKey,
        next.labels.map((l) => [l.id, Math.round(l.x), Math.round(l.y)]),
        next.dots.map((d) => [d.id, Math.round(d.x), Math.round(d.y), d.kind, Math.round(d.size)]),
        next.clusters.map((c) => [c.key, Math.round(c.x), Math.round(c.y), c.count]),
        nextPlanetLabels.map((p) => [p.id, Math.round(p.x), Math.round(p.y)]),
      ]);
      if (signature !== signatureRef.current) {
        signatureRef.current = signature;
        setLayout(next);
        setPlanetLabels(nextPlanetLabels);
      }
      const camText = `${camera.position.x.toFixed(1)},${camera.position.y.toFixed(1)},${camera.position.z.toFixed(1)}`;
      setCameraAttr((prev) => (prev === camText ? prev : camText));
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cameraRef, nodes, planets, selectedIds, selectedKey, nameKey, names, hoveredId, showStale, showLabels, spofs, size.width, size.height, byId, drawnIds, hullM]);

  const labelFor = (label: GridLabel) => {
    const node = byId.get(label.id);
    const telemetry = node?.telemetry ?? null;
    return {
      name: names[label.id] ?? label.name,
      speed: telemetry ? Math.round(telemetry.speedMps) : null,
      age: telemetry ? ageLabel(telemetry.ageMs / 1000) : null,
      stale: telemetry ? telemetry.ageMs > LIVE_MS : false,
    };
  };

  return (
    <div
      ref={hostRef}
      className="map-overlay"
      data-testid="map-overlay"
      data-camera={cameraAttr}
      data-live={layout.counts.live}
      data-stale={layout.counts.stale}
    >
      <div className="planet-layer">
        {planetLabels.map((p) => {
          const cx = p.x + p.w / 2;
          const cy = p.y + p.h / 2;
          // Short leader from the chip toward the projected planet centre, so
          // the label reads as an annotation instead of floating text.
          const dx = p.cx - cx;
          const dy = p.cy - cy;
          const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
          const length = Math.min(22, Math.max(8, Math.hypot(dx, dy) / 2));
          return (
            <span
              key={p.id}
              className="planet-label"
              data-testid="planet-label"
              data-planet={p.id}
              data-cx={Math.round(p.cx)}
              data-cy={Math.round(p.cy)}
              style={{ left: cx, top: cy }}
            >
              <i className="planet-leader" style={{ width: length, transform: `rotate(${angle}deg)` }} aria-hidden="true" />
              <span className="planet-label-text">{p.name}</span>
            </span>
          );
        })}
      </div>
      <div className="marker-layer">
        {layout.clusters.map((cluster) => {
          const badge = clusterBadgePx(cluster.count);
          return (
          <button
            type="button"
            key={cluster.key}
            className={`cluster-badge${cluster.staleOnly ? ' stale' : ''}`}
            data-testid="cluster-badge"
            data-count={cluster.count}
            data-ids={cluster.ids.join(',')}
            title={`${cluster.count} grids here — click to zoom in`}
            style={{
              transform: `translate3d(${cluster.x}px, ${cluster.y}px, 0)`,
              width: badge,
              height: badge,
              marginLeft: -badge / 2,
              marginTop: -badge / 2,
            }}
            onClick={() => {
              const node = byId.get(cluster.ids[0]!);
              if (node) onFocus(node.id);
            }}
          >
            {cluster.count}
          </button>
          );
        })}
        {layout.dots.filter((dot) => !drawn.has(dot.id)).map((dot) => {
          const node = byId.get(dot.id);
          const isSelected = selectedSet.has(dot.id);
          const isSpof = spofs.includes(dot.id);
          const label = names[dot.id] ?? node?.name ?? dot.id;
          const radioM = node?.capability?.radioRadiusM ?? null;
          const radioText = radioRings && radioM ? `${Math.round(radioM / KM)} km radio` : null;
          const size = Math.round(dot.size * 10) / 10;
          return (
            <button
              type="button"
              key={dot.id}
              className={`marker-dot ${dot.kind}${isSelected ? ' selected' : ''}${activeHover === dot.id ? ' hovered' : ''}`}
              data-testid="marker-dot"
              data-marker-id={dot.id}
              data-kind={dot.kind}
              data-size={size}
              data-selected={isSelected ? 'true' : 'false'}
              data-spof={isSpof ? 'true' : 'false'}
              data-hovered={activeHover === dot.id ? 'true' : 'false'}
              aria-label={`grid ${label}`}
              title={[isSpof ? `${label} — single point of failure` : label, radioText].filter(Boolean).join(' · ')}
              style={{
                transform: `translate3d(${dot.x}px, ${dot.y}px, 0)`,
                width: size,
                height: size,
                marginLeft: -size / 2,
                marginTop: -size / 2,
              }}
              onMouseEnter={() => setHoveredId(dot.id)}
              onMouseLeave={() => setHoveredId((current) => (current === dot.id ? null : current))}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                onSelect(dot.id, event.shiftKey);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onContextMenu(dot.id, event.clientX, event.clientY);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onFocus(dot.id);
              }}
            />
          );
        })}
        {activeHover && (() => {
          const dot = layout.dots.find((d) => d.id === activeHover);
          if (!dot) return null;
          return (
            <span
              className="hover-ring"
              data-testid="hover-ring"
              data-hover-id={activeHover}
              style={{ transform: `translate3d(${dot.x}px, ${dot.y}px, 0)` }}
              aria-hidden="true"
            />
          );
        })()}
        {radioRings && (() => {
          const dot = hoveredId ? layout.dots.find((d) => d.id === hoveredId) : null;
          const node = hoveredId ? byId.get(hoveredId) : null;
          const radiusM = node?.capability?.radioRadiusM ?? null;
          if (!dot || !radiusM) return null;
          return (
            <span
              className="map-tooltip"
              data-testid="radio-tooltip"
              style={{ transform: `translate3d(${dot.x}px, ${dot.y - 18}px, 0)` }}
            >
              {Math.round(radiusM / KM)} km radio
            </span>
          );
        })()}
        {layout.labels.map((label) => {
          const meta = labelFor(label);
          const spof = spofs.includes(label.id);
          const node = byId.get(label.id);
          return (
            <span
              key={label.id}
              className={`grid-label role-${label.role}${meta.stale ? ' stale' : ''}${selectedSet.has(label.id) ? ' selected' : ''}${activeHover === label.id ? ' hovered' : ''}`}
              data-testid="grid-label"
              data-id={label.id}
              data-role={label.role}
              data-spof={spof ? 'true' : 'false'}
              style={{ left: label.x, top: label.y, width: label.w, height: label.h }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                onSelect(label.id, event.shiftKey);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onContextMenu(label.id, event.clientX, event.clientY);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onFocus(label.id);
              }}
            >
              <span className="grid-label-name">
                {meta.name}
                {spof && (
                  <span
                    className="spof-icon"
                    data-testid="spof-icon"
                    title="Single point of failure: if this grid dies, everything behind it is cut off."
                    aria-label="single point of failure"
                  >
                    ▲
                  </span>
                )}
              </span>
              <span className="grid-label-meta">
                {meta.speed !== null ? `${meta.speed} m/s` : node?.reachable ? 'reachable' : 'isolated'}
                {meta.age !== null ? `, ${meta.age}` : ''}
                {node?.role && node.role !== 'managed' ? `, ${node.role}` : ''}
                {node?.controlSource ? ', base' : ''}
                {meta.stale ? ', stale' : ''}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
