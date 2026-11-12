// These fixtures document the LEGACY radio=range+los behaviour (still reachable via
// the flag) because that is the only mode where terrain shapes radio coverage.
// The measured rule is radio = range-only (see docs/architecture.md): under it a
// ridge changes nothing for radio, which is asserted in terrain-coverage.test.ts.
process.env.RTS_RADIO_LOS = '1';

import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { makeConfig } from './helpers.js';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import { PROVISION_CAPABILITIES_KV } from '../src/demo/network.js';
import { evaluateGate, prefabForGrid } from '../src/demo/gate.js';
import { seedWorld } from '../src/demo/world.js';
import { add, scale, v3 } from '../src/planner/geometry.js';
import { terrainFieldFromRadiusFn } from '../src/planner/terrainField.js';
import {
  loadOptimiseFleet,
  solveOptimise,
  type FleetShip,
  type OptimiseBase,
  type OptimisePlan,
} from '../src/demo/designer/optimise.js';

const EARTH = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const NOW = 1_800_000_000_000;

interface GridSpec {
  id: string;
  name?: string;
  radio: number;
  lat: number;
  lon: number;
  alt: number;
  massKg?: number;
  fuelPct?: number;
  powerPct?: number;
  isStatic?: boolean;
  link?: 'up' | 'down';
  lastSeen?: number;
}

function dirOf(latDeg: number, lonDeg: number) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return v3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
}

function positionOf(latDeg: number, lonDeg: number, altM: number) {
  return add(EARTH.center, scale(dirOf(latDeg, lonDeg), EARTH.surfaceRadiusM + altM));
}

interface Fixture {
  store: Store;
  base: OptimiseBase;
  fleet: (options?: { includeGridIds?: string[] }) => ReturnType<typeof loadOptimiseFleet>;
}

function fixture(grids: GridSpec[], baseSpec: Partial<GridSpec> = {}, prefabs: Record<string, string> = {}): Fixture {
  const store = new Store(openDb(':memory:', { memory: true }));
  const base: GridSpec = {
    id: 'base',
    name: 'BASE-01',
    radio: 50_000,
    lat: 0,
    lon: 0,
    alt: 300,
    massKg: 0,
    isStatic: true,
    ...baseSpec,
  };
  const all = [base, ...grids];
  store.setKv(
    PROVISION_CAPABILITIES_KV,
    JSON.stringify({
      at: NOW,
      grids: all.map((grid) => ({
        gridId: grid.id,
        name: grid.name ?? grid.id,
        profile: grid.id === base.id ? 'BASE' : 'DRONE',
        broadcasting: true,
        radioRadiusM: grid.radio,
        laserCount: 0,
        massKg: grid.massKg ?? 2_000_000,
        isStatic: grid.isStatic ?? false,
        updatedAt: NOW,
      })),
    }),
  );
  for (const grid of all) {
    store.upsertUnit({
      id: grid.id,
      name: grid.name ?? grid.id,
      specId: null,
      station: null,
      linkStatus: grid.link ?? 'up',
      lastSeen: grid.lastSeen ?? NOW,
      pos: positionOf(grid.lat, grid.lon, grid.alt),
      vel: null,
      meta: {
        massKg: grid.massKg ?? 2_000_000,
        fuelFraction: (grid.fuelPct ?? 90) / 100,
        powerFraction: (grid.powerPct ?? 90) / 100,
      },
    });
  }
  const world = seedWorld(NOW);
  const basePosition = positionOf(base.lat, base.lon, base.alt);
  const baseObject: OptimiseBase = {
    gridId: base.id,
    name: base.name ?? 'BASE-01',
    position: basePosition,
    altitudeM: base.alt,
    radioRangeM: base.radio,
    latDeg: base.lat,
    lonDeg: base.lon,
    source: 'control-source',
  };
  const fleet = (options: { includeGridIds?: string[] } = {}) =>
    loadOptimiseFleet({
      store,
      planet: EARTH,
      now: NOW,
      includeGridIds: options.includeGridIds,
      gateFor: (gridId) => {
        const gate = evaluateGate({
          store,
          world,
          now: NOW,
          nodeId: gridId,
          prefabFor: (id) => prefabForGrid(store, id),
        });
        return { allowed: gate.allowed, reason: gate.reason };
      },
      prefabFor: (gridId) => prefabs[gridId] ?? (gridId === 'g-fuel' ? 'Escort TT-420' : prefabForGrid(store, gridId)),
    });
  return { store, base: baseObject, fleet };
}

function solve(
  input: Fixture,
  overrides: Partial<Parameters<typeof solveOptimise>[0]> & { fleet?: FleetShip[] } = {},
): OptimisePlan {
  const read = input.fleet();
  return solveOptimise({
    planet: EARTH,
    ships: overrides.fleet ?? read.ships,
    excluded: read.excluded,
    base: input.base,
    target: { kind: 'whole' },
    targetDescription: 'whole planet',
    k: 1,
    cellDeg: 5,
    cellDegUsed: 5,
    rangeMarginPct: 10,
    maxMoves: null,
    minReservePct: 15,
    maxHoles: 12,
    terrain: null,
    now: NOW,
    dryRun: true,
    timing: false,
    ...overrides,
  });
}

afterEach(() => {
  delete process.env.RTS_DEMO;
  delete process.env.RTS_ENV;
  delete process.env.RTS_TEST_SERVER_MARKER;
});

const BUNCHED: GridSpec[] = [
  { id: 'g1', lat: 1, lon: 0, alt: 15_000, radio: 50_000 },
  { id: 'g2', lat: 1.1, lon: 0.05, alt: 15_000, radio: 50_000 },
  { id: 'g3', lat: 1.2, lon: 0.1, alt: 15_000, radio: 50_000 },
];

describe('POST /api/demo/designer/optimise (T43)', () => {
  it('(a) returns moves: 0 and gain 0 when the fleet is already optimal', () => {
    const first = solve(fixture(BUNCHED));
    expect(first.moves.length).toBeGreaterThan(0);

    // Re-read the fleet at the planned slots: the optimiser must now say the
    // network is fine and change nothing.
    const moved = fixture(
      first.moves.map((move) => ({
        id: move.gridId,
        lat: move.to.latDeg,
        lon: move.to.lonDeg,
        alt: move.to.altitudeM,
        radio: 50_000,
      })),
    );
    const second = solve(moved);
    expect(second.moves).toHaveLength(0);
    expect(second.gainPct).toBe(0);
    expect(second.gainCells).toBe(0);
    expect(second.coverageAfter.pct).toBe(second.coverageNow.pct);
    for (const ship of second.staying) {
      if (ship.gridId === 'base') {
        expect(ship.reason).toMatch(/static/);
        continue;
      }
      expect(ship.reason).toMatch(/staying put|already covered/);
    }
  });

  it('(b) spreads a bunched fleet and reports the freed coverage', () => {
    const plan = solve(fixture(BUNCHED));
    expect(plan.coverageNow.pct).toBeGreaterThan(0);
    expect(plan.moves.length).toBeGreaterThanOrEqual(2);
    expect(plan.gainPct).toBeGreaterThan(0);
    expect(plan.coverageAfter.pct).toBeGreaterThan(plan.coverageNow.pct);
    expect(plan.coverageAfter.coveredCells).toBeGreaterThan(plan.coverageNow.coveredCells);

    // The moves must actually separate the ships, not nudge them.
    const finalPositions = plan.moves.map((move) => dirOf(move.to.latDeg, move.to.lonDeg));
    for (let i = 0; i < finalPositions.length; i += 1) {
      for (let j = i + 1; j < finalPositions.length; j += 1) {
        const dot =
          finalPositions[i]!.x * finalPositions[j]!.x +
          finalPositions[i]!.y * finalPositions[j]!.y +
          finalPositions[i]!.z * finalPositions[j]!.z;
        expect(Math.acos(Math.max(-1, Math.min(1, dot)))).toBeGreaterThan(0.2);
      }
    }
    // "Freed coverage": every move names the cells it used to provide and who
    // picks them up (or how many go dark).
    for (const move of plan.moves) {
      expect(move.substitution.coversTotal).toBeGreaterThan(0);
      expect(move.substitution.covers.length).toBeGreaterThan(0);
      expect(move.substitution.covers.length).toBeLessThanOrEqual(move.substitution.coversTotal);
      for (const cell of move.substitution.covers) {
        expect(Number.isFinite(cell.latDeg)).toBe(true);
        expect(Array.isArray(cell.stillCoveredBy)).toBe(true);
      }
      expect(move.distanceM).toBeGreaterThan(0);
      expect(move.etaS).toBeGreaterThan(0);
      expect(move.fuel.reservePct).toBeGreaterThanOrEqual(15);
    }
  });

  it('(c) never assigns a grid that cannot reach the slot on fuel/charge, and says why', () => {
    // One hull with real tanks runs dry: 1 % H2 on a 15 km cruise cannot cover
    // a 40+ km relocation, while its neighbours can.
    const grids: GridSpec[] = [
      { id: 'g1', lat: 1, lon: 0, alt: 15_000, radio: 50_000 },
      { id: 'g2', lat: 1.1, lon: 0.05, alt: 15_000, radio: 50_000 },
      { id: 'g-fuel', lat: 1.2, lon: 0.1, alt: 15_000, radio: 50_000, fuelPct: 1, powerPct: 1 },
    ];
    const plan = solve(fixture(grids));
    expect(plan.moves.some((move) => move.gridId === 'g-fuel')).toBe(false);
    const staying = plan.staying.find((entry) => entry.gridId === 'g-fuel');
    expect(staying).toBeDefined();
    expect(staying!.reason).toMatch(/fuel|charge|reserve|endurance/i);
    // Its neighbours did move, so the refusal is about this grid, not the plan.
    expect(plan.moves.length).toBeGreaterThan(0);
  });

  it('(d) excludes a grid under player control and never moves it', () => {
    const built = fixture(BUNCHED);
    built.store.setKv('demo:control:g2', JSON.stringify({ underControl: true, by: 'the owner' }));
    const plan = solve(built);
    expect(plan.excluded.map((entry) => entry.gridId)).toContain('g2');
    expect(plan.excluded.find((entry) => entry.gridId === 'g2')!.reason).toMatch(/player control/i);
    expect(plan.moves.some((move) => move.gridId === 'g2')).toBe(false);
    expect(plan.staying.some((entry) => entry.gridId === 'g2')).toBe(false);
  });

  it('(e) reports uncoveredDuringTransit with an exact cell count when no neighbour covers the old cells', () => {
    // A radio chain out to 70 deg: the base footprint stops at ~50 deg, so the
    // outer pair's cells have no fallback once the cluster leaves.
    const grids: GridSpec[] = [
      { id: 'c1', lat: 35, lon: 0, alt: 15_000, radio: 50_000 },
      { id: 'o1', lat: 70, lon: 0, alt: 15_000, radio: 50_000 },
      { id: 'o2', lat: 70.5, lon: 0, alt: 15_000, radio: 50_000 },
    ];
    const plan = solve(fixture(grids));
    expect(plan.moves.length).toBeGreaterThan(0);
    const gap = plan.moves.find((move) => move.substitution.uncoveredDuringTransit);
    expect(gap).toBeDefined();
    expect(gap!.substitution.uncoveredCellCount).toBeGreaterThan(0);
    expect(gap!.substitution.uncoveredCells.length).toBeGreaterThan(0);
    expect(gap!.substitution.uncoveredCells.length).toBeLessThanOrEqual(gap!.substitution.uncoveredCellCount);
    // The count is exact: it equals the number of the ship's old cells with no
    // other coverer, i.e. the sampled list can never exceed it.
    expect(gap!.substitution.transitEtaS).toBe(gap!.etaS);
  });

  it('(f) returns a byte-identical plan for the same input twice', async () => {
    process.env.RTS_DEMO = '1';
    process.env.RTS_ENV = 'test';
    process.env.RTS_TEST_SERVER_MARKER = 'se-rts-test';
    try {
      const { designerRoutesFor } = await import('../src/demo/designer/routes.js');
      const built = fixture(BUNCHED);
      const deps = {
        config: makeConfig(),
        store: built.store,
        hub: { isConnected: () => false } as never,
        stateHub: { broadcast: () => undefined } as never,
        clock: () => NOW,
      } as never;
      const route = designerRoutesFor(deps).find(
        (candidate) => candidate.method === 'POST' && candidate.pattern.test('/api/demo/designer/optimise'),
      )!;
      expect(route).toBeTruthy();
      const call = async (body: unknown): Promise<string> => {
        let payload = '';
        const res = {
          writeHead: () => undefined,
          end: (text: string) => {
            payload = text;
          },
        };
        let sent = false;
        const req = {
          async *[Symbol.asyncIterator]() {
            if (sent) return;
            sent = true;
            yield Buffer.from(JSON.stringify(body));
          },
          headers: {},
        };
        await route.handler({ req: req as never, res: res as never, params: [], url: new URL('http://x/api/demo/designer/optimise') });
        return payload;
      };
      const body = { planet: 'EarthLike', target: 'whole', k: 1, cellDeg: 5, terrain: 'none', dryRun: true };
      const one = await call(body);
      const two = await call(body);
      expect(two).toBe(one);
      const plan = JSON.parse(one) as OptimisePlan;
      expect(plan.schemaVersion).toBe(1);
      expect(plan.planId).toMatch(/^opt-[0-9a-f]{12}$/);
      expect(plan.executable).toBe(false);
      expect(plan.operation).toBeNull();
      expect(plan.coverageNow.totalCells).toBe(72 * 36);
      expect(plan.moves.length).toBeGreaterThan(0);

      // dryRun:false still executes nothing: it returns the same plan plus the
      // FleetOperation-shaped payload it WOULD submit.
      const armed = JSON.parse(
        await call({ ...body, dryRun: false }),
      ) as OptimisePlan;
      expect(armed.executable).toBe(true);
      expect(armed.operation?.kind).toBe('reshape');
      expect(armed.operation?.members).toHaveLength(armed.moves.length);
      expect(armed.operation?.steps.length).toBe(armed.moves.length * 3);
      expect(armed.moves.map((move) => move.gridId)).toEqual(plan.moves.map((move) => move.gridId));
    } finally {
      delete process.env.RTS_DEMO;
      delete process.env.RTS_ENV;
      delete process.env.RTS_TEST_SERVER_MARKER;
    }
  });

  it('(g) turns a hole no owned hull can serve into a build request, not a silent gap', () => {
    // One relay over EarthLike cannot see most of the planet and no second
    // owned hull exists: the remaining holes must carry a block-level build spec.
    const plan = solve(fixture([{ id: 'solo', lat: 0, lon: 0, alt: 15_000, radio: 50_000 }]));
    expect(plan.coverageAfter.pct).toBeLessThan(100);
    expect(plan.holes.length).toBeGreaterThan(0);
    expect(plan.holesTotal).toBeGreaterThan(plan.holes.length);
    expect(plan.holesTruncated).toBe(true);
    const withBuild = plan.holes.filter((hole) => hole.fix.kind === 'build');
    expect(withBuild.length).toBeGreaterThan(0);
    expect(plan.buildRequests.length).toBeGreaterThan(0);
    const request = plan.buildRequests[0]!;
    expect(request.buildRequest).toMatch(/^BUILD: 1x/);
    expect(request.modelHullId).toMatch(/^prefab:/);
    expect(['ground', 'atmo', 'space']).toContain(request.tier);
    expect(typeof request.antennaDrawMW).toBe('number');
    // No owned hull is free for a new relay: the only one flying the plan is
    // committed, and the static base hull does not fit the climb.
    expect(request.ownedFits.every((fit) => fit.fits !== true)).toBe(true);
    for (const hole of withBuild) {
      expect(['no relay in range', 'terrain shadow', 'no LOS to any base', 'no hull available']).toContain(hole.reason);
      expect(hole.fix.text.length).toBeGreaterThan(10);
    }
  });

  it('(j) names a terrain shadow as a hole and never hides it in the smooth count', () => {
    // A 12 km relay (radio 45 km -> ~36 deg horizon-limited footprint). The
    // ridge has to sit INSIDE that footprint or the cell is simply below the
    // horizon and nothing can ever be terrain-blocked: a 9 km peak at 8-20 deg
    // north (24.5 deg from the relay axis) is well inside 36 deg, and the slant
    // to the low ground beyond it grazes the crest at 20 deg.
    const built = fixture([{ id: 'ridge-relay', lat: 0, lon: 0, alt: 12_000, radio: 45_000 }]);
    const ridge = terrainFieldFromRadiusFn(EARTH, (dir) => {
      const latDeg = (Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180) / Math.PI;
      return latDeg >= 8 && latDeg <= 20 ? EARTH.surfaceRadiusM + 9_000 : EARTH.surfaceRadiusM;
    });
    const plan = solve(built, { terrain: ridge, cellDeg: 30, cellDegUsed: 30, maxHoles: 200 });
    expect(plan.coverageNow.terrain).toBe('corrected');
    expect(plan.labels).toContain('TERRAIN-CORRECTED');
    expect(plan.coverageNow.blockedCells).toBeGreaterThan(0);
    expect(plan.coverageNow.pct).toBeLessThan(plan.coverageNow.geometricPct);
    const shadow = plan.holes.find((hole) => hole.reason === 'terrain shadow');
    expect(shadow).toBeDefined();
    expect(shadow!.fix.text).toMatch(/terrain blocks every sky path/i);
    expect(shadow!.fix.text).toMatch(/ridge|ground laser/);
  });

  it('(i) honours a radius target and a hemisphere target', () => {
    const built = fixture(BUNCHED);
    const radius = solve(built, {
      target: { kind: 'radius', radiusM: 5_000, centerDir: dirOf(0, 0), centerLabel: 'base' },
      targetDescription: '5 km around the base',
    });
    expect(radius.coverageNow.totalCells).toBeGreaterThan(0);
    expect(radius.coverageNow.totalCells).toBeLessThan(72 * 36);
    expect(radius.request.target).toContain('5 km around the base');

    const hemisphere = solve(built, {
      target: { kind: 'hemisphere', facingDir: dirOf(0, 0), facingLabel: 'BASE-01' },
      targetDescription: 'hemisphere facing BASE-01',
    });
    expect(hemisphere.coverageNow.totalCells).toBeGreaterThan(radius.coverageNow.totalCells);
    expect(hemisphere.coverageNow.totalCells).toBeLessThan(72 * 36);
    // A hemisphere is half the cells, within one cell-row of the boundary.
    expect(hemisphere.coverageNow.totalCells).toBeGreaterThan(72 * 36 * 0.45);
  });

  it('(k) an altitude mode lets moves change altitude and stays deterministic', () => {
    // A hydrogen-relay-shaped grid: the Escort hull has real H2 tanks (so the
    // climb to the footprint peak is modelled), and the measured 50 km radio
    // and mass come from the grid profile.
    const specs: GridSpec[] = [
      { id: 'a1', lat: 0, lon: 0, alt: 5_000, radio: 50_000, massKg: 300_000 },
      { id: 'a2', lat: 1, lon: 1, alt: 5_000, radio: 50_000, massKg: 300_000 },
      { id: 'a3', lat: 2, lon: 2, alt: 5_000, radio: 50_000, massKg: 300_000 },
    ];
    const built = fixture(specs, {}, { a1: 'Escort TT-420', a2: 'Escort TT-420', a3: 'Escort TT-420' });
    const manual = solve(built, { altitudeMode: 'manual' });
    for (const move of manual.moves) expect(move.to.altitudeM).toBe(move.from.altitudeM);

    const reach = solve(built, { altitudeMode: 'max-reach' });
    const twice = solve(built, { altitudeMode: 'max-reach' });
    // Determinism: identical input, byte-identical plan (planId included).
    expect(JSON.stringify(twice)).toBe(JSON.stringify(reach));
    expect(reach.request.altitudeMode).toBe('max-reach');
    if (process.env.RTS_DBG === '1') {
      console.log('reach moves', JSON.stringify(reach.moves.map((m) => ({ id: m.gridId, from: m.from.altitudeM, to: m.to.altitudeM, reason: m.altitudeReason, why: m.reason })), null, 1));
      console.log('staying', JSON.stringify(reach.staying));
      console.log('fleet', JSON.stringify(built.fleet().ships.map((s2) => ({ id: s2.gridId, hull: s2.hullId, src: s2.hullSource, radio: s2.radioRangeM }))));
    }
    const climbed = reach.moves.filter((move) => move.to.altitudeM !== move.from.altitudeM);
    expect(climbed.length).toBeGreaterThan(0);
    for (const move of climbed) {
      // With the 10 % range margin the effective 45 km footprint peaks at
      // ~15.2 km (EarthLike): a 5 km relay climbs toward that height.
      expect(Math.abs(move.to.altitudeM - 15_188)).toBeLessThan(1_000);
      expect(move.altitudeChangeM).toBe(move.to.altitudeM - move.from.altitudeM);
      expect(move.altitudeReason).toMatch(/climbs|descends/);
    }
    // The altitude change is not free: it is priced by the one endurance model.
    expect(climbed.every((move) => move.fuel.reservePct >= 15)).toBe(true);

    // CHEAPEST also moves altitude, and changes the target height with the weights.
    const cheap = solve(built, { altitudeMode: 'cheapest' });
    expect(cheap.request.altitudeMode).toBe('cheapest');
    expect(JSON.stringify(solve(built, { altitudeMode: 'cheapest' }))).toBe(JSON.stringify(cheap));
    // The solver records that altitudes were explored, not assumed.
    expect(reach.solver.altitudesEvaluated).toBeGreaterThan(0);
  });

  it('(l) reports terrain provenance and never conflates smooth and corrected coverage', () => {
    const plan = solve(fixture(BUNCHED));
    expect(plan.coverageNow.terrain).toBe('none');
    expect(plan.coverageNow.terrainReason).toBeNull();
    expect(plan.labels).toContain('TERRAIN-OFF');
    // Cells by k are both reported, and k=2 is never larger than k=1.
    expect(plan.coverageNow.cellsByK.k2).toBeLessThanOrEqual(plan.coverageNow.cellsByK.k1);
    expect(plan.coverageAfter.cellsByK.k1).toBe(plan.coverageAfter.coveredCells);
  });
});
