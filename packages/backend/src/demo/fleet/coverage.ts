/**
 * T50 coverage snapshots. The numbers come from the existing terrain-corrected
 * coverage core (`coverageCellsForNodes` in planner/planetCoverage.ts); nothing
 * here re-implements the slant-path or footprint maths.
 */
import type { Planet } from '@se-rts/schemas';
import { coverageCellsFor, coverageCellsForNodes } from '../../planner/planetCoverage.js';
import type { TerrainField } from '../../planner/terrainField.js';
import type { FleetCoverage, FleetVec3 } from '../../store.js';

export interface CoverageNodeInput {
  id: string;
  position: FleetVec3;
  radioRangeM: number | null;
}

export interface CoverageComputation {
  snapshot: FleetCoverage;
  cells: { latDeg: number; lonDeg: number; covered: boolean }[];
}

/**
 * Conservative range: the *smallest* positive radio radius among the nodes, so
 * a call never credits one ship's antenna to another. Terrain is passed through
 * exactly as the designer route does; `undefined` means "not requested" and is
 * labelled `none`, never silently treated as corrected.
 */
export function computeCoverage(args: {
  planet: Planet;
  nodes: CoverageNodeInput[];
  cellDeg?: number;
  k?: 1 | 2;
  terrain?: TerrainField | null;
  margin?: number;
}): CoverageComputation | null {
  const withRadio = args.nodes.filter((n) => typeof n.radioRangeM === 'number' && n.radioRangeM > 0);
  if (!withRadio.length) return null;
  const rangeM = Math.min(...withRadio.map((n) => n.radioRangeM!));
  const cellDeg = Math.max(2, Math.min(30, args.cellDeg ?? 10));
  const k = args.k ?? 1;
  const margin = args.margin ?? 0.9;
  const cells = coverageCellsFor(args.planet, cellDeg);
  const result = coverageCellsForNodes(
    args.planet,
    cells,
    withRadio.map((n) => ({ id: n.id, position: n.position })),
    rangeM * margin,
    k,
    args.terrain ?? null,
  );
  const uncoveredCells: { latDeg: number; lonDeg: number }[] = [];
  const outCells: { latDeg: number; lonDeg: number; covered: boolean }[] = [];
  for (const cell of result.cells) {
    const covered = cell.coveredBy >= k;
    outCells.push({ latDeg: cell.latDeg, lonDeg: cell.lonDeg, covered });
    if (!covered && uncoveredCells.length < 400) {
      uncoveredCells.push({ latDeg: cell.latDeg, lonDeg: cell.lonDeg });
    }
  }
  return {
    snapshot: {
      planet: args.planet.name,
      cellDeg,
      k,
      radioRangeM: Math.round(rangeM),
      coveragePct: result.coveragePct,
      coveredCells: result.coveredCells,
      totalCells: result.totalCells,
      terrain: result.terrain,
      terrainReason: result.terrainReason,
      uncoveredCells,
      nodeIds: withRadio.map((n) => n.id).sort(),
    },
    cells: outCells,
  };
}

/** Cells covered before that are not covered after (the scuttle invariant). */
export function lostCells(
  before: CoverageComputation | null,
  after: CoverageComputation | null,
  limit = 400,
): { latDeg: number; lonDeg: number }[] {
  if (!before) return [];
  // `after === null` means no coverage node is left (a scuttle): every covered
  // cell before is lost.
  const stillCovered = new Set(
    (after?.cells ?? []).filter((c) => c.covered).map((c) => `${c.latDeg}:${c.lonDeg}`),
  );
  const lost: { latDeg: number; lonDeg: number }[] = [];
  for (const cell of before.cells) {
    if (!cell.covered) continue;
    if (stillCovered.has(`${cell.latDeg}:${cell.lonDeg}`)) continue;
    lost.push({ latDeg: cell.latDeg, lonDeg: cell.lonDeg });
    if (lost.length >= limit) break;
  }
  return lost;
}
