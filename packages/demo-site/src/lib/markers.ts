/**
 * Screen-space marker layout for the demo map.
 *
 * Everything here is pure and framework-free so the label priority, stale
 * filter and clustering rules can be unit tested without a WebGL context.
 * The overlay component projects node positions to CSS pixels and feeds them
 * in; this module decides what is actually drawn and where.
 */

/** A grid is live when telemetry is at most 60 s old (spec), not merely "fresh". */
export const LIVE_MS = 60_000;
/** Markers closer than this many pixels collapse into one badge. */
export const CLUSTER_PX = 24;
/** World-anchored marker diameter floor/ceiling in CSS px. */
export const DOT_MIN_PX = 4;
export const DOT_MAX_PX = 14;
/** Apparent size of a satellite marker in metres (a hull reads ~26 m). */
export const MARKER_WORLD_M = 26;
/** Fixed label card size: fixed geometry makes declutter exact, not estimated. */
export const LABEL_W = 176;
export const LABEL_H = 34;
/** Labels sit above the dot/badge so they cannot cover their own marker. */
export const LABEL_GAP_Y = 14;
/** Below this projected radius a planet label is pinned just above the centre. */
const MIN_LIMB_PX = 8;

function clampPx(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Distance-aware marker size, in CSS pixels.
 *
 * The marker represents a fixed world size, so its projected span follows
 * `world / distance`; clamped to 4–14 px so it is never an invisible speck at
 * 200 km nor a blob over the hull at 500 m. This is why markers stop being a
 * constant 9 px and stop piling on top of each other when the camera dives in.
 */
export function markerPxFor(
  distanceM: number,
  fovDeg = 50,
  viewportH = 900,
  worldM = MARKER_WORLD_M,
): number {
  if (!(distanceM > 0) || !(viewportH > 0)) return DOT_MIN_PX;
  const px = (worldM / (2 * distanceM * Math.tan((fovDeg * Math.PI) / 360))) * viewportH;
  return clampPx(px, DOT_MIN_PX, DOT_MAX_PX);
}

/** Screen-space clamp for a hull-anchored marker (CONTRACT-HULL). */
export const HULL_PX_MIN = 3;
export const HULL_PX_MAX = 18;
/** A dot spans this fraction of the hull's bbox diagonal. */
export const HULL_DOT_FACTOR = 0.6;

/**
 * Marker radius in CSS px, anchored to the grid's real hull size.
 *
 * `worldM` is the grid bbox diagonal in metres: the dot is 60 % of it, so a
 * 10 m satellite reads as a small speck, a 69-block base is visibly larger and
 * a several-hundred-block ship larger still. The projection is clamped to
 * 3–18 px: at far zoom everything collapses to a dot, and up close the dot can
 * grow with the hull but never become a bubble that covers it.
 */
export function hullPxFor(
  bboxM: number,
  distanceM: number,
  fovDeg = 50,
  viewportH = 900,
): number {
  const worldM = bboxM > 0 ? bboxM * HULL_DOT_FACTOR : MARKER_WORLD_M;
  if (!(distanceM > 0) || !(viewportH > 0)) return HULL_PX_MIN;
  const px = (worldM / (2 * distanceM * Math.tan((fovDeg * Math.PI) / 360))) * viewportH;
  return clampPx(px, HULL_PX_MIN, HULL_PX_MAX);
}

/** Cluster badge diameter in px: count-based, never hull-based. */
export function clusterBadgePx(count: number): number {
  const n = Math.max(1, Math.floor(count));
  return Math.round(22 + Math.min(14, Math.log2(n) * 4));
}

/**
 * World radius (scene km) that projects to `px` at `distanceKm`.
 *
 * The 3D marker layer uses this so a marker is the same apparent size as its
 * HTML dot: world-anchored, screen-clamped, never a fixed bubble.
 */
export function worldRadiusForPx(
  px: number,
  distanceKm: number,
  fovDeg = 50,
  viewportH = 900,
): number {
  if (!(distanceKm > 0) || !(viewportH > 0)) return 0;
  const pxPerKm = viewportH / 2 / (distanceKm * Math.tan((fovDeg * Math.PI) / 360));
  return pxPerKm > 0 ? px / pxPerKm : 0;
}

/**
 * Minimum screen separation before two markers merge. Grows with marker size
 * so two 14 px dots never overlap at close range; floors at 150 % of the
 * smaller dot so far-away clusters stay compact.
 */
export function clusterPxFor(aPx: number, bPx = aPx): number {
  return Math.max(9, (aPx + bPx) / 2 + 4);
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ScreenNode extends ScreenPoint {
  id: string;
  /** false when the node projects behind the camera or outside the viewport */
  visible: boolean;
  name: string;
  /** world position in metres, kept for camera focus */
  world: { x: number; y: number; z: number };
  live: boolean;
  moving: boolean;
  speedMps: number;
  ageSec: number;
  owner: string | null;
  isGame: boolean;
  spof: boolean;
  isolated: boolean;
  /** camera distance in scene units (km); smaller = nearer */
  distance: number;
  /** projected marker diameter in CSS px (world-anchored, 4–14) */
  sizePx?: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type DotKind = 'selected' | 'hovered' | 'live' | 'stale' | 'simulated' | 'spof';

export interface MarkerDot extends ScreenPoint {
  id: string;
  kind: DotKind;
  labelled: boolean;
  /** CSS px diameter from the projection */
  size: number;
}

export interface ClusterBadge extends ScreenPoint {
  key: string;
  count: number;
  ids: string[];
  world: { x: number; y: number; z: number };
  /** largest member distance from the centroid, metres */
  spreadM: number;
  staleOnly: boolean;
}

export interface GridLabel extends Box {
  id: string;
  name: string;
  /** selected / hovered / drone */
  role: 'selected' | 'hovered' | 'drone';
  live: boolean;
}

export interface OverlayLayout {
  dots: MarkerDot[];
  clusters: ClusterBadge[];
  labels: GridLabel[];
  counts: { live: number; stale: number };
}

export interface LayoutOptions {
  width: number;
  height: number;
  selectedId: string | null;
  /** multi-selection; when absent only `selectedId` is treated as selected */
  selectedIds?: string[];
  hoveredId: string | null;
  showStale: boolean;
  /** live moving drones that may carry a label, nearest to camera first */
  maxDroneLabels?: number;
  /** ids whose block/bbox model is drawn in WebGL: no dot, no cluster member */
  drawnIds?: string[];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function overlaps(a: Box, b: Box, pad = 0): boolean {
  return (
    a.x < b.x + b.w + pad &&
    a.x + a.w + pad > b.x &&
    a.y < b.y + b.h + pad &&
    a.y + a.h + pad > b.y
  );
}

/** Label card anchored above-right of its marker and clamped into the viewport. */
export function labelBoxFor(point: ScreenPoint, width: number, height: number, dy = 0): Box {
  const x = clamp(point.x - 12, 4, Math.max(4, width - LABEL_W - 4));
  const y = clamp(point.y - LABEL_H - LABEL_GAP_Y + dy, 4, Math.max(4, height - LABEL_H - 4));
  return { x, y, w: LABEL_W, h: LABEL_H };
}

/**
 * Hover tooltip placement: to the RIGHT of the marker, vertically centred on
 * it, so the card never covers the ship it describes (owner review of ui-v2:
 * the old above-left card sat on top of the marker).
 */
export function hoverLabelBoxFor(point: ScreenPoint, width: number, height: number): Box {
  const flipLeft = point.x + 14 + LABEL_W > width - 4;
  const x = flipLeft
    ? clamp(point.x - 16 - LABEL_W, 4, Math.max(4, width - LABEL_W - 4))
    : clamp(point.x + 14, 4, Math.max(4, width - LABEL_W - 4));
  const y = clamp(point.y - LABEL_H / 2, 4, Math.max(4, height - LABEL_H - 4));
  return { x, y, w: LABEL_W, h: LABEL_H };
}

interface ClusterAcc extends ScreenPoint {
  key: string;
  count: number;
  ids: string[];
  sumX: number;
  sumY: number;
  sumWorld: { x: number; y: number; z: number };
  staleOnly: boolean;
  /** mean projected marker size of the members */
  sizePx: number;
}

/**
 * Greedy 2D clustering in screen space: a marker joins the nearest existing
 * cluster within the pair's separation radius, otherwise it starts one.
 * The radius grows with the dots' projected size, so two 14 px markers at
 * close range stay separate and individually clickable while 4 px far dots
 * still collapse into one badge.
 */
export function clusterMarkers(nodes: ScreenNode[]): ClusterBadge[] {
  const accs: ClusterAcc[] = [];
  for (const n of nodes) {
    let best: ClusterAcc | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const a of accs) {
      const d = Math.hypot(a.x - n.x, a.y - n.y);
      const limit = clusterPxFor(n.sizePx ?? 9, a.sizePx ?? 9);
      if (d <= limit && d < bestD) {
        best = a;
        bestD = d;
      }
    }
    if (best) {
      best.sumX += n.x;
      best.sumY += n.y;
      best.sumWorld.x += n.world.x;
      best.sumWorld.y += n.world.y;
      best.sumWorld.z += n.world.z;
      best.count += 1;
      best.ids.push(n.id);
      best.sizePx = (best.sizePx * (best.count - 1) + (n.sizePx ?? 9)) / best.count;
      best.staleOnly = best.staleOnly && !n.live;
      best.x = best.sumX / best.count;
      best.y = best.sumY / best.count;
    } else {
      accs.push({
        key: n.id,
        x: n.x,
        y: n.y,
        count: 1,
        ids: [n.id],
        sumX: n.x,
        sumY: n.y,
        sumWorld: { ...n.world },
        staleOnly: !n.live,
        sizePx: n.sizePx ?? 9,
      });
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return accs
    .filter((a) => a.count > 1)
    .map((a) => {
      const cx = a.sumWorld.x / a.count;
      const cy = a.sumWorld.y / a.count;
      const cz = a.sumWorld.z / a.count;
      let spreadM = 0;
      for (const id of a.ids) {
        const n = byId.get(id);
        if (!n) continue;
        spreadM = Math.max(spreadM, Math.hypot(n.world.x - cx, n.world.y - cy, n.world.z - cz));
      }
      return {
        key: a.key,
        x: a.x,
        y: a.y,
        count: a.count,
        ids: a.ids,
        world: { x: cx, y: cy, z: cz },
        spreadM,
        staleOnly: a.staleOnly,
      };
    });
}

function dotKind(node: ScreenNode, selectedIds: Set<string>, hoveredId: string | null): DotKind {
  if (selectedIds.has(node.id)) return 'selected';
  if (node.id === hoveredId) return 'hovered';
  if (!node.isGame) return 'simulated';
  return node.live ? 'live' : 'stale';
}

/**
 * Decide markers, clusters and labels.
 *
 * Rules (in order of authority):
 *  - the selected grid always gets a label (even if it is stale/off-screen
 *    filters would hide it), so selection is never invisible;
 *  - the hovered grid gets a label;
 *  - up to `maxDroneLabels` live *moving* drones, nearest to camera first;
 *  - stale grids never get a label and are hidden entirely unless showStale;
 *  - any label that would overlap an already accepted label is dropped, so
 *    the higher-priority one always wins.
 */
export function layoutOverlay(nodes: ScreenNode[], opts: LayoutOptions): OverlayLayout {
  const width = Math.max(1, opts.width);
  const height = Math.max(1, opts.height);
  const maxDrones = opts.maxDroneLabels ?? 8;
  const selection = new Set(opts.selectedIds ?? (opts.selectedId ? [opts.selectedId] : []));

  let live = 0;
  let stale = 0;
  for (const n of nodes) {
    if (!n.isGame) continue;
    if (n.live) live += 1;
    else stale += 1;
  }

  const visible = nodes.filter(
    (n) =>
      n.visible &&
      (!n.isGame || n.live || opts.showStale || selection.has(n.id) || n.id === opts.hoveredId),
  );
  // A grid whose hull/bbox is already drawn must not also show a marker: that
  // was the "marker sits on top of the model" bug at close range.
  const drawnSet = new Set(opts.drawnIds ?? []);
  const marked = visible.filter((n) => !drawnSet.has(n.id));

  const droneIds = visible
    .filter((n) => n.isGame && n.live && n.moving)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxDrones)
    .map((n) => n.id);

  const labelOrder: { id: string; role: GridLabel['role']; priority: number }[] = [];
  let priority = 0;
  for (const node of visible) {
    if (!selection.has(node.id)) continue;
    labelOrder.push({ id: node.id, role: 'selected', priority: priority++ });
  }
  const hovered = opts.hoveredId ? visible.find((n) => n.id === opts.hoveredId) : undefined;
  if (hovered && !selection.has(hovered.id)) labelOrder.push({ id: hovered.id, role: 'hovered', priority: priority++ });
  droneIds.forEach((id) => {
    if (selection.has(id) || id === hovered?.id) return;
    labelOrder.push({ id, role: 'drone', priority: priority++ });
  });

  const labelled = new Set(labelOrder.map((l) => l.id));
  const clustered = marked.filter((n) => !labelled.has(n.id));
  const clusters = clusterMarkers(clustered).map((c) => ({ ...c }));

  // A dot that would sit on top of a cluster badge is absorbed by it, so no
  // two hit targets ever overlap (owner: markers piled up at close zoom).
  for (const n of clustered) {
    if (clusters.some((c) => c.ids.includes(n.id))) continue;
    const hit = clusters.find(
      (c) => Math.hypot(c.x - n.x, c.y - n.y) <= clusterPxFor(n.sizePx ?? 9, 15),
    );
    if (!hit) continue;
    hit.count += 1;
    hit.ids.push(n.id);
    hit.x = (hit.x * (hit.count - 1) + n.x) / hit.count;
    hit.y = (hit.y * (hit.count - 1) + n.y) / hit.count;
  }

  const dots: MarkerDot[] = [];
  const inCluster = new Set(clusters.flatMap((c) => c.ids));
  for (const n of marked) {
    if (inCluster.has(n.id)) continue;
    dots.push({
      id: n.id,
      x: n.x,
      y: n.y,
      kind: dotKind(n, selection, opts.hoveredId),
      labelled: labelled.has(n.id),
      size: n.sizePx ?? 9,
    });
  }

  const obstacles: Box[] = clusters.map((c) => ({ x: c.x - 12, y: c.y - 12, w: 24, h: 24 }));
  const labels: GridLabel[] = [];
  const accepted: Box[] = [];
  for (const entry of labelOrder.sort((a, b) => a.priority - b.priority)) {
    const node = visible.find((n) => n.id === entry.id);
    if (!node) continue;
    // One slot per marker: overlap means the lower-priority card is dropped,
    // exactly as specified — no nudging, so geometry stays predictable.
    let box = entry.role === 'hovered' ? hoverLabelBoxFor(node, width, height) : labelBoxFor(node, width, height);
    let blocked = accepted.some((a) => overlaps(box, a, 4)) || obstacles.some((o) => overlaps(box, o, 2));
    if (blocked && entry.role === 'selected') {
      // A selected grid must stay labelled (selection is never invisible), so
      // try a few vertical slots before falling back to the first one.
      for (const dy of [-LABEL_H - 6, LABEL_H + 6, -(LABEL_H + 6) * 2, (LABEL_H + 6) * 2]) {
        const alt = labelBoxFor(node, width, height, dy);
        if (!accepted.some((a) => overlaps(alt, a, 4)) && !obstacles.some((o) => overlaps(alt, o, 2))) {
          box = alt;
          blocked = false;
          break;
        }
      }
    }
    if (blocked && entry.role !== 'selected') continue;
    accepted.push(box);
    labels.push({ ...box, id: node.id, name: node.name, role: entry.role, live: node.live });
  }

  return { dots, clusters, labels, counts: { live, stale } };
}

export interface ScreenPlanet extends ScreenPoint {
  id: string;
  name: string;
  radiusPx: number;
  selected: boolean;
}

export interface PlanetLabel extends Box {
  /** true projected centre of the planet, unclamped (the box may be nudged) */
  cx: number;
  cy: number;
  id: string;
  name: string;
}

/**
 * Planet labels sit on the limb (the edge facing away from the viewport
 * centre), are small text-only chips, and yield to grid label cards: if every
 * candidate slot collides, the planet label is dropped rather than covering a
 * grid label.
 */
export function layoutPlanetLabels(
  planets: ScreenPlanet[],
  width: number,
  height: number,
  obstacles: Box[],
): PlanetLabel[] {
  const out: PlanetLabel[] = [];
  const accepted: Box[] = [];
  const centre = { x: width / 2, y: height / 2 };
  const ordered = [...planets].sort((a, b) => Number(b.selected) - Number(a.selected));
  for (const p of ordered) {
    const w = Math.max(18, Math.round(p.name.length * 7.4) + 4);
    const h = 13;
    let dx = p.x - centre.x;
    let dy = p.y - centre.y;
    const len = Math.hypot(dx, dy);
    if (len < 1 || p.radiusPx < MIN_LIMB_PX) {
      dx = 0;
      dy = -1;
    } else {
      dx /= len;
      dy /= len;
    }
    const anchorX = p.x + dx * (Math.max(p.radiusPx, 2) * 1.08 + 14);
    const anchorY = p.y + dy * (Math.max(p.radiusPx, 2) * 1.08 + 14);
    let placed: Box | null = null;
    for (const off of [0, -16, 16, -30, 30, -46, 46]) {
      // The chip is centred on its anchor (translate(-50%)), so clamp by half
      // the chip wherever it lands — otherwise edge labels get clipped.
      const cx = clamp(anchorX, w / 2 + 2, Math.max(w / 2 + 2, width - w / 2 - 2));
      const cy = clamp(anchorY + off, h / 2 + 2, Math.max(h / 2 + 2, height - h / 2 - 2));
      const box: Box = { x: cx - w / 2, y: cy - h / 2, w, h };
      const hitsGrid = obstacles.some((o) => overlaps(box, o, 3));
      const hitsPlanet = accepted.some((a) => overlaps(box, a, 6));
      if (!hitsGrid && !hitsPlanet) {
        placed = box;
        break;
      }
    }
    if (!placed) continue;
    accepted.push(placed);
    out.push({ ...placed, id: p.id, name: p.name, cx: p.x, cy: p.y });
  }
  return out;
}
