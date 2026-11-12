/**
 * Screen-space ship picking.
 *
 * A 10 m drone at 4000 km is smaller than a pixel, so a literal raycast is a
 * lottery. Instead every node is projected to the screen and picked by a radius
 * that grows as you zoom out (14 px close in, ~28 px when far out), which is
 * what makes a small ship on a planet's limb reachable with one click.
 *
 * Pure: the caller does the projection, this module only ranks hits. The same
 * ranking drives hover, click and double-click so they cannot disagree.
 */

/** Closest-in hit radius (px). */
export const PICK_RADIUS_MIN_PX = 14;
/** Hit radius when zoomed out (px). */
export const PICK_RADIUS_MAX_PX = 28;
export const PICK_RADIUS_NEAR_KM = 0.2;
export const PICK_RADIUS_FAR_KM = 5000;

export interface ScreenNode {
  id: string;
  /** marker centre, stage-local px */
  x: number;
  y: number;
  /** NDC depth: -1 near .. +1 far, as three's project() writes it */
  depth: number;
  /** drawn marker diameter (px), so big markers are grabbable from their edge */
  sizePx: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Zoom-scaled hit radius. Logarithmic in distance so the growth is uniform
 * whether you are 1 km or 1000 km from the pivot.
 */
export function pickRadiusPx(distanceKm: number): number {
  const d = Number.isFinite(distanceKm) && distanceKm > 0 ? distanceKm : PICK_RADIUS_NEAR_KM;
  const t = clamp(
    (Math.log(d) - Math.log(PICK_RADIUS_NEAR_KM)) / (Math.log(PICK_RADIUS_FAR_KM) - Math.log(PICK_RADIUS_NEAR_KM)),
    0,
    1,
  );
  return PICK_RADIUS_MIN_PX + (PICK_RADIUS_MAX_PX - PICK_RADIUS_MIN_PX) * t;
}

/** Distance from the pointer to the marker's EDGE (negative = inside it). */
export function edgeDistancePx(node: ScreenNode, x: number, y: number): number {
  return Math.hypot(node.x - x, node.y - y) - Math.max(0, node.sizePx) / 2;
}

export interface PickResult {
  /** the closest hit, or null when nothing is in range */
  best: ScreenNode | null;
  /** every hit inside the radius, best first (a disambiguation list) */
  candidates: ScreenNode[];
}

/**
 * Rank hits inside `radiusPx`. When several ships are within the radius the
 * caller shows the candidate list instead of guessing, but `best` is still the
 * nearest so a plain click keeps working.
 */
export function pickNodes(nodes: ScreenNode[], x: number, y: number, radiusPx: number): PickResult {
  const hits: { node: ScreenNode; d: number }[] = [];
  for (const node of nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    const d = edgeDistancePx(node, x, y);
    if (d <= radiusPx) hits.push({ node, d });
  }
  hits.sort((a, b) => a.d - b.d || a.node.depth - b.node.depth);
  return { best: hits[0]?.node ?? null, candidates: hits.map((h) => h.node) };
}

/** True when the click deserves a disambiguation list rather than a silent pick. */
export function needsDisambiguation(result: PickResult): boolean {
  return result.candidates.length > 1;
}
