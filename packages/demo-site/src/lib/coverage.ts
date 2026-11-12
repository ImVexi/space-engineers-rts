/**
 * Coverage heatmap (CONTRACT T44): equirect texture + click-to-explain.
 *
 * Cells come from GET /api/demo/designer/coverage as a lat/lon grid. The
 * texture is built once per response and reused across frames; cell colours
 * are the contract's red 0 / amber 1 / green 2+.
 */
import type { Vec3 } from '../types';

export interface CoverageCell {
  latDeg: number;
  lonDeg: number;
  coveredBy: number;
  /** threshold this grid was counted against */
  k?: 1 | 2;
  byTier?: Record<string, number>;
  /** the relay the preview credits first (drives the click explanation wording) */
  bestRelayId?: string | null;
  /** terrain blocked a path the smooth footprint counted as covering */
  blockedByTerrain?: boolean;
  /** smooth-sphere count before terrain correction */
  geometricCoveredBy?: number;
}

export interface CoverageTierNode {
  id: string;
  role?: string;
  altitudeM?: number;
  latDeg: number;
  lonDeg: number;
}

export interface CoverageTier {
  id: string;
  altitudeM: number;
  radioRangeM: number;
  count: number;
  bridgeCount?: number;
  coveragePct?: number;
  footprintRadiusM?: number;
  nodes?: CoverageTierNode[];
  warnings?: string[];
}

export interface CoverageResponse {
  planet: string;
  mode: string;
  k: 1 | 2;
  cellDeg: number;
  rangeMargin?: number;
  recommendedTier?: string | null;
  recommendation?: string;
  tiers?: CoverageTier[];
  uncoveredCells?: number;
  uncoveredPct?: number;
  cells: CoverageCell[];
  labels?: string[];
  reasons?: string[];
  surfaceRadiusM?: number;
  /** where the counts came from: terrain-corrected, unavailable, or not asked */
  terrain?: 'corrected' | 'unavailable' | 'none' | 'skipped';
  terrainReason?: string | null;
  /** cells terrain removed from the union of all tiers */
  blockedCells?: number;
  /** smooth-sphere coverage before terrain correction */
  geometricCoveragePct?: number;
}

export type CoverageRgb = [number, number, number, number];

/** Contract colours: red 0, amber 1, green 2 or more. */
export function coverageRgb(coveredBy: number): CoverageRgb {
  if (!Number.isFinite(coveredBy) || coveredBy <= 0) return [192, 57, 43, 205];
  if (coveredBy === 1) return [224, 176, 114, 200];
  return [63, 143, 104, 195];
}

export function coverageColor(coveredBy: number): string {
  const [r, g, b] = coverageRgb(coveredBy);
  return `rgb(${r}, ${g}, ${b})`;
}

export interface CoverageTexture {
  width: number;
  height: number;
  /** RGBA rows south -> north, which is DataTexture v=0..1 on a sphere */
  data: Uint8Array<ArrayBuffer>;
}

/**
 * One texel per grid cell. Row 0 is the south pole so the texture lines up
 * with three's sphere UVs without an extra flip.
 */
export function buildCoverageTexture(cells: CoverageCell[], cellDeg: number): CoverageTexture {
  const step = Math.max(2, Math.round(cellDeg));
  const width = Math.max(1, Math.round(360 / step));
  const height = Math.max(1, Math.round(180 / step));
  const data = new Uint8Array(new ArrayBuffer(width * height * 4));
  const cellOf = new Map<string, CoverageCell>();
  for (const cell of cells) cellOf.set(`${cell.latDeg}|${cell.lonDeg}`, cell);
  for (let row = 0; row < height; row += 1) {
    const lat = -90 + step / 2 + row * step;
    for (let col = 0; col < width; col += 1) {
      const lon = -180 + step / 2 + col * step;
      const cell = cellOf.get(`${round1(lat)}|${round1(lon)}`);
      if (!cell) continue;
      const [r, g, b, a] = coverageRgb(cell.coveredBy);
      const i = (row * width + col) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function pointToLatLon(point: Vec3, center: Vec3): { latDeg: number; lonDeg: number } {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const dz = point.z - center.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const lat = (Math.asin(Math.max(-1, Math.min(1, dy / len))) * 180) / Math.PI;
  const lon = (Math.atan2(dz, dx) * 180) / Math.PI;
  return { latDeg: lat, lonDeg: lon };
}

export function latLonToCell(cells: CoverageCell[], latDeg: number, lonDeg: number, cellDeg: number): CoverageCell | null {
  if (cells.length === 0) return null;
  const step = Math.max(2, cellDeg);
  const index = Math.max(0, Math.min(Math.round(180 / step) - 1, Math.floor((latDeg + 90) / step)));
  const lat = -90 + step / 2 + index * step;
  const lonWrapped = ((lonDeg + 180) % 360 + 360) % 360 - 180;
  const lonIndex = Math.max(0, Math.min(Math.round(360 / step) - 1, Math.floor((lonWrapped + 180) / step)));
  const lon = -180 + step / 2 + lonIndex * step;
  const key = `${round1(lat)}|${round1(lon)}`;
  const exact = cells.find((c) => `${c.latDeg}|${c.lonDeg}` === key);
  if (exact) return exact;
  // Nearest by wrapped longitude distance; tolerates a differently centred grid.
  let best: { cell: CoverageCell; d: number } | null = null;
  for (const cell of cells) {
    let dLon = Math.abs(cell.lonDeg - lonWrapped);
    if (dLon > 180) dLon = 360 - dLon;
    const d = Math.hypot(cell.latDeg - latDeg, dLon);
    if (d <= step && (!best || d < best.d)) best = { cell, d };
  }
  return best?.cell ?? null;
}

export function coveragePct(cells: CoverageCell[], k = 1): number {
  if (cells.length === 0) return 0;
  const covered = cells.filter((c) => c.coveredBy >= k).length;
  return Math.round((covered / cells.length) * 1000) / 10;
}

export interface CellExplanation {
  title: string;
  lines: string[];
  /** the tier whose node came closest, for prefilling the fix */
  tierId: string | null;
  altitudeM: number | null;
}

interface ExplanationCtx {
  tiers?: CoverageTier[];
  reasons?: string[];
  surfaceRadiusM: number;
}

function dirOf(latDeg: number, lonDeg: number): Vec3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return { x: Math.cos(lat) * Math.cos(lon), y: Math.sin(lat), z: Math.cos(lat) * Math.sin(lon) };
}

function footprintAngle(radius: number, rangeM: number, surfaceM: number): number {
  if (!(rangeM > 0) || !(radius > surfaceM)) return 0;
  const cosPhi = (radius * radius + surfaceM * surfaceM - rangeM * rangeM) / (2 * radius * surfaceM);
  if (cosPhi >= 1) return 0;
  if (cosPhi <= -1) return Math.PI;
  return Math.acos(cosPhi);
}

/**
 * Plain-language "why". Global planner reasons first, then the closest planned
 * relay and how far the cell sits outside its footprint — both are derived from
 * the response, never invented.
 */
export function explainCell(cell: CoverageCell, ctx: ExplanationCtx): CellExplanation {
  const title = `${cell.latDeg.toFixed(0)}°, ${cell.lonDeg.toFixed(0)}° · ${cell.coveredBy === 0 ? 'uncovered' : `covered by ${cell.coveredBy}`}`;
  const lines: string[] = [];
  if (cell.coveredBy > 0) {
    const node = cell.bestRelayId ? ctx.tiers?.flatMap((tier) => tier.nodes ?? []).find((candidate) => candidate.id === cell.bestRelayId) ?? null : null;
    lines.push(
      node
        ? `${cell.coveredBy} relay(s) reach it; the preview credits ${node.id} first.`
        : `${cell.coveredBy} relay footprint${cell.coveredBy === 1 ? ' reaches' : 's reach'} this cell.`,
    );
    if (ctx.reasons?.length) lines.push(ctx.reasons[0]!);
    return { title, lines, tierId: null, altitudeM: null };
  }
  lines.push('No relay footprint reaches this cell.');
  let best: { id: string; tier: CoverageTier; beyondM: number } | null = null;
  const cellDir = dirOf(cell.latDeg, cell.lonDeg);
  for (const tier of ctx.tiers ?? []) {
    const range = (tier.radioRangeM ?? 0) * 0.9;
    for (const node of tier.nodes ?? []) {
      const nodeDir = dirOf(node.latDeg, node.lonDeg);
      const dot = Math.max(-1, Math.min(1, nodeDir.x * cellDir.x + nodeDir.y * cellDir.y + nodeDir.z * cellDir.z));
      const angle = Math.acos(dot);
      const radius = ctx.surfaceRadiusM + (node.altitudeM ?? tier.altitudeM ?? 0);
      const phi = footprintAngle(radius, range, ctx.surfaceRadiusM);
      const beyondM = (angle - phi) * ctx.surfaceRadiusM;
      if (!best || beyondM < best.beyondM) best = { id: node.id, tier, beyondM };
    }
  }
  if (best) {
    const km = (n: number) => `${Math.max(1, Math.round(n / 1000))} km`;
    lines.push(
      best.beyondM > 0
        ? `Closest planned relay ${best.id} misses it by ${km(best.beyondM)} (${km(best.tier.footprintRadiusM ?? 0)} footprint).`
        : `Closest planned relay ${best.id} is inside range on paper — the live grid may be missing or out of fuel.`,
    );
    lines.push(`Suggested tier: ${best.tier.id} at ${Math.round(best.tier.altitudeM / 1000)} km.`);
  }
  if (ctx.reasons?.length) lines.push(...ctx.reasons.slice(0, 2));
  return { title, lines, tierId: best?.tier.id ?? null, altitudeM: best?.tier.altitudeM ?? null };
}

/** Live coverage from actual ship positions (the number ticks up as they arrive). */
export function liveCoverage(
  cells: CoverageCell[],
  ships: { id: string; position: Vec3; radioRangeM: number | null }[],
  center: Vec3,
  surfaceRadiusM: number,
  k = 1,
): { pct: number; covered: number; byId: Map<string, number>; total: number } {
  const caps = ships
    .filter((s) => (s.radioRangeM ?? 0) > 0)
    .map((ship) => {
      const dx = ship.position.x - center.x;
      const dy = ship.position.y - center.y;
      const dz = ship.position.z - center.z;
      const radius = Math.hypot(dx, dy, dz) || surfaceRadiusM;
      const phi = footprintAngle(radius, (ship.radioRangeM ?? 0) * 0.9, surfaceRadiusM);
      return { id: ship.id, dir: { x: dx / radius, y: dy / radius, z: dz / radius }, cosPhi: Math.cos(phi) };
    });
  const byId = new Map<string, number>();
  let covered = 0;
  for (const cell of cells) {
    const dir = dirOf(cell.latDeg, cell.lonDeg);
    let count = 0;
    for (const cap of caps) {
      const dot = cap.dir.x * dir.x + cap.dir.y * dir.y + cap.dir.z * dir.z;
      if (dot >= cap.cosPhi) {
        count += 1;
        byId.set(cap.id, (byId.get(cap.id) ?? 0) + 1);
      }
    }
    if (count >= k) covered += 1;
  }
  return { pct: cells.length ? Math.round((covered / cells.length) * 1000) / 10 : 0, covered, byId, total: cells.length };
}

/** One proposed relay in a preview: position + the radio it will run. */
export interface PreviewNode {
  id: string;
  position: Vec3;
  altitudeM: number;
  radioRangeM: number;
  /** horizon-limited ground radius, metres (informational) */
  groundRadiusM?: number;
}

/**
 * T51.2/T53 preview: the heatmap for the PROPOSED layout, k-aware, from the
 * same footprint maths as live coverage. Cells keep the contract colours
 * (red 0 / amber 1 / green >= 2), so a k=2 preview shows amber where only one
 * relay is heard instead of pretending it is covered.
 */
export function previewCoverage(
  cells: CoverageCell[],
  nodes: PreviewNode[],
  center: Vec3,
  surfaceRadiusM: number,
): { cells: CoverageCell[]; pct: number; pctK2: number } {
  const caps = nodes
    .filter((node) => node.radioRangeM > 0)
    .map((node) => {
      const dx = node.position.x - center.x;
      const dy = node.position.y - center.y;
      const dz = node.position.z - center.z;
      const radius = Math.hypot(dx, dy, dz) || surfaceRadiusM + node.altitudeM;
      const phi = footprintAngle(radius, node.radioRangeM * 0.9, surfaceRadiusM);
      return { id: node.id, dir: { x: dx / radius, y: dy / radius, z: dz / radius }, cosPhi: Math.cos(phi) };
    });
  const out = cells.map((cell) => {
    const dir = dirOf(cell.latDeg, cell.lonDeg);
    let count = 0;
    let best: string | null = null;
    for (const cap of caps) {
      const dot = cap.dir.x * dir.x + cap.dir.y * dir.y + cap.dir.z * dir.z;
      if (dot >= cap.cosPhi) {
        count += 1;
        if (best === null) best = cap.id;
      }
    }
    return { ...cell, coveredBy: count, bestRelayId: best };
  });
  return { cells: out, pct: coveragePct(out, 1), pctK2: coveragePct(out, 2) };
}
