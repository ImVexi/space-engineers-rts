/**
 * Optimiser response types (T43/T51.9/T52). Mirrors the fields the backend
 * actually returns from POST /api/demo/designer/optimise; the panel reads
 * these or says it cannot, it never assumes a shape.
 */

export interface OptimiseCoverage {
  pct: number;
  coveredCells: number;
  totalCells: number;
  cellsByK: { k1: number; k2: number };
  blockedCells: number;
  geometricPct: number;
  terrain: 'corrected' | 'unavailable' | 'none';
  terrainReason: string | null;
  sampling: { samplesPerPath: number; tiles: number } | null;
}

export interface OptimiseMove {
  gridId: string;
  name: string;
  from: { pos: { x: number; y: number; z: number }; altitudeM: number; latDeg: number; lonDeg: number };
  to: { pos: { x: number; y: number; z: number }; altitudeM: number; latDeg: number; lonDeg: number };
  distanceM: number;
  etaS: number;
  fuel: { h2L: number | null; batteryMWh: number | null; reservePct: number };
  thrustClassNeeded: string;
  holdMode: string;
  altitudeChangeM?: number;
  altitudeReason?: string;
  reason: string;
  substitution: {
    basis: string;
    cellsCovered: number;
    coversTotal: number;
    uncoveredDuringTransit: boolean;
    uncoveredCellCount: number;
    uncoveredCells: { latDeg: number; lonDeg: number }[];
    uncoveredTruncated: boolean;
    transitEtaS: number;
  };
}

export interface OptimiseHole {
  latDeg: number;
  lonDeg: number;
  reason: 'no relay in range' | 'terrain shadow' | 'no LOS to any base' | 'no hull available';
  fix: { kind: string; text: string; gridId?: string; distanceM?: number; etaS?: number; buildRequest?: string };
}

export interface OptimisePlan {
  schemaVersion: 1;
  planId: string;
  planet: { id: string; name: string; surfaceRadiusM: number };
  asOf: number;
  request: {
    target: string;
    k: 1 | 2;
    cellDeg: number;
    cellDegUsed: number;
    rangeMarginPct: number;
    maxMoves: number | null;
    dryRun: boolean;
    altitudeMode: 'manual' | 'max-reach' | 'cheapest';
  };
  base: { gridId: string | null; name: string; latDeg: number; lonDeg: number; altitudeM: number; source: string };
  fleet: {
    total: number;
    withRadio: number;
    commandable: number;
    movable: number;
    entries: {
      gridId: string;
      name: string;
      radioRangeM: number | null;
      altitudeM: number;
      latDeg: number;
      lonDeg: number;
      fuelPct: number | null;
      batteryPct: number | null;
      isStatic: boolean;
      commandable: boolean;
      hullId: string | null;
      hullSource: 'prefab' | 'standin' | null;
    }[];
  };
  excluded: { gridId: string; name: string; reason: string }[];
  coverageNow: OptimiseCoverage;
  moves: OptimiseMove[];
  staying: { gridId: string; name: string; reason: string }[];
  surplus: { gridId: string; name: string; reason: string }[];
  coverageAfter: OptimiseCoverage;
  gainPct: number;
  gainCells: number;
  holes: OptimiseHole[];
  holesTotal: number;
  holesTruncated: boolean;
  buildRequests: { slotId: string; buildRequest: string; reason: string }[];
  solver: { candidateSlots: number; movesEvaluated: number; altitudesEvaluated: number; basis: string };
  assumptions: string[];
  labels: string[];
  limitations: string[];
  executable: boolean;
  operation: unknown | null;
}
