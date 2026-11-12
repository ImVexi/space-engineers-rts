/**
 * T50 fleet operations: planning + invariants.
 *
 * One operation owns many grids. This module turns a *kind* into an ordered,
 * addressable step list and evaluates the five invariants T50 requires. It is
 * deliberately pure of HTTP and of the executor: it reads telemetry/store and
 * returns a plan, so the same code runs for `dryRun` and for a real approval.
 *
 * Sequencing rules that are enforced here (not by hope):
 *   - swap never flies a member through another: every swapped pair gets its
 *     own temp staging point and the waves are A->temp, B->A, temp->B;
 *   - no two members may be closer than `minSeparationM` at a step boundary;
 *   - a member whose removal would leave another node with no path to a base
 *     is refused (`last_path`);
 *   - a hand-piloted member is excluded and reported (`manual`);
 *   - a member without fuel/charge for its own legs is skipped with the
 *     shortfall (`fuel`), never dispatched and never silently dropped.
 */
import type { NetworkNode, Planet } from '@se-rts/schemas';
import { buildGraph } from '../../planner/index.js';
import { capabilitiesFromStore, networkSnapshot } from '../network.js';
import { evaluateGate, prefabForGrid } from '../gate.js';
import { getStandInByName } from '../standins.js';
import type { DemoWorld } from '../world.js';
import type {
  FleetInvariantFailure,
  FleetInvariants,
  FleetMemberPlan,
  FleetOpKind,
  FleetStep,
  FleetVec3,
  Store,
} from '../../store.js';

/** Model constants, documented where they are used. */
export const FULL_TANK_RANGE_M = 400_000;
/** Reserve a member must still hold after its legs have been flown. */
export const FUEL_RESERVE = 0.02;
/** Arrival tolerance for a move/land/dock step, metres. */
export const ARRIVAL_TOLERANCE_M = 50;
export const LAND_TOLERANCE_M = 80;
/** A dispatched step with no observed arrival for this long is reported, not faked. */
export const ARRIVAL_TIMEOUT_MS = 120_000;
/** Recall flags a ship as needing service below these fractions. */
export const REFUEL_BELOW = 0.5;
export const REPAIR_BELOW = 0.9;
/** Feature flag that gates scuttle *execution*; off unless an operator sets it. */
export const SCUTTLE_EXECUTE_FLAG = 'fleet_scuttle_execute';
/**
 * Feature flag that gates fleet *execution* through the executor. OFF by
 * default: approve still re-checks and plans, but with the flag off nothing is
 * dispatched to the game (and the response says so).
 */
export const FLEET_EXECUTE_FLAG = 'fleet_ops_execute';

export interface PlanInput {
  kind: FleetOpKind;
  members: string[];
  homes: Map<string, FleetVec3>;
  gates: Map<string, { allowed: boolean; reason: string; source: string }>;
  manual: Set<string>;
  membersTelemetry: Map<
    string,
    { fuelFraction: number | null; powerFraction: number | null; health: number | null; isStatic: boolean }
  >;
  minSeparationM: number;
  planet: Planet | null;
  base: FleetVec3 | null;
  slots: { gridId: string; target: FleetVec3 }[];
  region: FleetVec3 | null;
  /** Graph used for last-path checks (current network). */
  nodes: NetworkNode[];
  planets: Planet[];
  now: number;
}

export interface PlanOutput {
  steps: FleetStep[];
  invariants: FleetInvariants;
  /** Where each member ends up, for coverage-after. */
  finalPositions: Map<string, FleetVec3>;
}

export function isManual(store: Store, gridId: string): boolean {
  const raw = store.getKv(`demo:control:${gridId}`);
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as { underControl?: unknown }).underControl === true;
  } catch {
    return false;
  }
}

export function unitPosition(store: Store, world: DemoWorld, gridId: string): FleetVec3 | null {
  const unit = store.getUnit(gridId);
  if (unit?.pos) return { ...unit.pos };
  const node = world.nodes.find((n) => n.id === gridId);
  return node ? { ...node.position } : null;
}

export function memberTelemetry(
  store: Store,
  gridId: string,
): { fuelFraction: number | null; powerFraction: number | null; health: number | null; isStatic: boolean } {
  const unit = store.getUnit(gridId);
  const meta = (unit?.meta ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const cap = capabilitiesFromStore(store).get(gridId);
  const standin = cap?.name ? getStandInByName(cap.name) : null;
  return {
    fuelFraction: num(meta.fuelFraction),
    powerFraction: num(meta.powerFraction),
    health: num(meta.health),
    isStatic: cap?.isStatic === true || standin?.isStatic === true,
  };
}

export function fleetNodes(store: Store, world: DemoWorld, now: number, freshMs: number): NetworkNode[] {
  return networkSnapshot({
    store,
    world,
    now,
    freshMs,
    prefabFor: (id) => prefabForGrid(store, id),
  }).nodes;
}

/** Gate verdict for one grid, same policy as the move/hold routes. */
export function evaluateMemberGate(
  store: Store,
  world: DemoWorld,
  now: number,
  gridId: string,
  freshMs: number,
) {
  const gate = evaluateGate({ store, world, now, nodeId: gridId, freshMs });
  return { allowed: gate.allowed, reason: gate.reason, source: gate.source };
}

export function distanceM(a: FleetVec3, b: FleetVec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Reachability with hypothetical positions: nodes in `overrides` are moved to
 * their new position (or removed when null). Nodes that were reachable before
 * and are not reachable after are the victims of "removing the last path".
 */
export function connectivityAfter(
  nodes: NetworkNode[],
  overrides: Map<string, FleetVec3 | null>,
  planets: Planet[],
): { victims: string[]; unreachableMoved: string[] } {
  const before = buildGraph(nodes, planets);
  const reachableBefore = new Set(before.graph.nodes.filter((n) => n.reachable).map((n) => n.id));
  const next: NetworkNode[] = [];
  for (const node of nodes) {
    if (!overrides.has(node.id)) {
      next.push(node);
      continue;
    }
    const pos = overrides.get(node.id);
    if (pos) next.push({ ...node, position: pos });
  }
  const after = buildGraph(next, planets);
  const reachableAfter = new Set(after.graph.nodes.filter((n) => n.reachable).map((n) => n.id));
  const victims = [...reachableBefore].filter((id) => !reachableAfter.has(id) && !overrides.has(id)).sort();
  const unreachableMoved = [...overrides.keys()]
    .filter((id) => reachableBefore.has(id) && !reachableAfter.has(id))
    .sort();
  return { victims, unreachableMoved };
}

/** Pairwise check over every member position at a boundary. */
export function separationFailure(
  positions: Map<string, FleetVec3>,
  minSeparationM: number,
): FleetInvariantFailure | null {
  const entries = [...positions.entries()].filter(([, pos]) => pos !== null) as [string, FleetVec3][];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [a, pa] = entries[i]!;
      const [b, pb] = entries[j]!;
      const d = distanceM(pa, pb);
      if (d < minSeparationM) {
        return {
          invariant: 'separation',
          severity: 'hard',
          memberId: a,
          reason: `${a} and ${b} would be ${Math.round(d)} m apart at a step boundary (minimum ${minSeparationM} m)`,
        };
      }
    }
  }
  return null;
}

function upAt(point: FleetVec3, planet: Planet | null): FleetVec3 {
  if (!planet) return { x: 0, y: 1, z: 0 };
  const dx = point.x - planet.center.x;
  const dy = point.y - planet.center.y;
  const dz = point.z - planet.center.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  return { x: dx / len, y: dy / len, z: dz / len };
}

/**
 * Temp staging point for a swapped pair: off the A-B axis so that a member
 * parked there is `minSeparationM` clear of BOTH slots (and of every other
 * member already parked). Returns null when no candidate is safe.
 */
export function stagingPoint(
  a: FleetVec3,
  b: FleetVec3,
  occupied: FleetVec3[],
  minSeparationM: number,
  planet: Planet | null,
): FleetVec3 | null {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
  const axis = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const axisLen = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const u = upAt(a, planet);
  const perpRaw = {
    x: axis.y * u.z - axis.z * u.y,
    y: axis.z * u.x - axis.x * u.z,
    z: axis.x * u.y - axis.y * u.x,
  };
  const perpLen = Math.hypot(perpRaw.x, perpRaw.y, perpRaw.z);
  const perp =
    perpLen > 1e-6
      ? { x: perpRaw.x / perpLen, y: perpRaw.y / perpLen, z: perpRaw.z / perpLen }
      : { x: 1, y: 0, z: 0 };
  // A second perpendicular (axis x perp) gives candidates in two planes, so a
  // crowded staging area can still find a legal point.
  const alt = {
    x: axis.y / axisLen * perp.z - axis.z / axisLen * perp.y,
    y: axis.z / axisLen * perp.x - axis.x / axisLen * perp.z,
    z: axis.x / axisLen * perp.y - axis.y / axisLen * perp.x,
  };
  const offsets = [
    Math.max(minSeparationM * 1.6, axisLen * 0.75),
    Math.max(minSeparationM * 2.6, axisLen * 1.2),
    Math.max(minSeparationM * 4, axisLen * 2),
  ];
  const candidates: FleetVec3[] = [];
  for (const offset of offsets) {
    for (const dir of [perp, alt, { x: -perp.x, y: -perp.y, z: -perp.z }, u]) {
      candidates.push({
        x: mid.x + dir.x * offset,
        y: mid.y + dir.y * offset,
        z: mid.z + dir.z * offset,
      });
    }
  }
  for (const candidate of candidates) {
    if (distanceM(candidate, a) < minSeparationM) continue;
    if (distanceM(candidate, b) < minSeparationM) continue;
    if (occupied.some((p) => distanceM(candidate, p) < minSeparationM)) continue;
    return candidate;
  }
  return null;
}

function step(input: {
  wave: number;
  memberId: string;
  action: FleetStep['action'];
  target: FleetVec3 | null;
  suffix: string;
  reason?: string;
  status?: FleetStep['status'];
  flags?: string[];
}): FleetStep {
  return {
    id: `w${input.wave}:${input.memberId}:${input.action}:${input.suffix}`,
    wave: input.wave,
    memberId: input.memberId,
    action: input.action,
    target: input.target,
    status: input.status ?? 'pending',
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.flags ? { flags: input.flags } : {}),
  };
}

function flagsFor(
  fuelFraction: number | null,
  health: number | null,
): { flags: string[]; notes: string[] } {
  const flags: string[] = [];
  const notes: string[] = [];
  if (fuelFraction !== null && fuelFraction < REFUEL_BELOW) flags.push('NEEDS_REFUEL');
  if (health !== null && health < REPAIR_BELOW) flags.push('NEEDS_REPAIR');
  if (fuelFraction === null) notes.push('fuel/charge unknown at recall: NEEDS_REFUEL not asserted');
  if (health === null) notes.push('health unknown at recall: NEEDS_REPAIR not asserted');
  return { flags, notes };
}

/** Distance the member's steps will fly (unstation/flag legs are free). */
function plannedDistance(steps: FleetStep[], memberId: string, home: FleetVec3 | null): number {
  let total = 0;
  let at = home;
  for (const s of steps) {
    if (s.memberId !== memberId || !s.target) continue;
    if (s.action !== 'move' && s.action !== 'land' && s.action !== 'dock') continue;
    if (at) total += distanceM(at, s.target);
    else total = Math.max(total, 0);
    at = s.target;
  }
  return Math.round(total);
}

function cross(a: FleetVec3, b: FleetVec3): FleetVec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(v: FleetVec3): FleetVec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * Tangent basis at `up`. Axis-aligned up vectors (a base at x=y=0, the common
 * case on a planet) would collapse a naive cross product to zero, so pick a
 * helper axis that is not parallel.
 */
export function tangentBasis(up: FleetVec3): { east: FleetVec3; north: FleetVec3 } {
  const helper: FleetVec3 = Math.abs(up.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  let east = cross(helper, up);
  if (Math.hypot(east.x, east.y, east.z) < 1e-6) east = cross({ x: 1, y: 0, z: 0 }, up);
  const eastUnit = normalize(east);
  const northUnit = normalize(cross(up, eastUnit));
  return { east: eastUnit, north: northUnit };
}

function recallRing(base: FleetVec3, count: number, minSeparationM: number, planet: Planet | null): FleetVec3[] {
  if (count <= 1) return [base];
  const u = upAt(base, planet);
  const { east, north } = tangentBasis(u);
  const sinHalf = Math.sin(Math.PI / count);
  const radius = Math.max((minSeparationM / (2 * Math.max(sinHalf, 0.05))) * 1.25, 150);
  const out: FleetVec3[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (2 * Math.PI * i) / count;
    out.push({
      x: base.x + east.x * Math.cos(angle) * radius + north.x * Math.sin(angle) * radius,
      y: base.y + east.y * Math.cos(angle) * radius + north.y * Math.sin(angle) * radius,
      z: base.z + east.z * Math.cos(angle) * radius + north.z * Math.sin(angle) * radius,
    });
  }
  return out;
}

export function planOperation(input: PlanInput): PlanOutput {
  const { kind, members, homes, minSeparationM } = input;
  const steps: FleetStep[] = [];
  const failures: FleetInvariantFailure[] = [];
  const notes: string[] = [];
  const finalPositions = new Map<string, FleetVec3>();
  for (const [id, pos] of homes) finalPositions.set(id, pos);

  // ---------------------------------------------------------- per-member veto
  const memberPlans: FleetMemberPlan[] = members.map((gridId) => {
    const tel = input.membersTelemetry.get(gridId) ?? {
      fuelFraction: null,
      powerFraction: null,
      health: null,
      isStatic: false,
    };
    const gate = input.gates.get(gridId) ?? { allowed: false, reason: 'gate was not evaluated', source: 'SIMULATED' };
    const home = homes.get(gridId) ?? null;
    const plan: FleetMemberPlan = {
      gridId,
      home,
      verdict: 'ok',
      gate,
      isStatic: tel.isStatic,
      fuelFraction: tel.fuelFraction,
      powerFraction: tel.powerFraction,
      health: tel.health,
    };
    if (!home) {
      plan.verdict = 'skipped';
      plan.reason = 'no position telemetry: the grid cannot be placed in the formation';
      failures.push({ invariant: 'commandable', severity: 'hard', memberId: gridId, reason: plan.reason });
    } else if (input.manual.has(gridId)) {
      plan.verdict = 'skipped';
      plan.reason = 'under manual control (the pilot owns this grid)';
      failures.push({ invariant: 'manual', severity: 'member', memberId: gridId, reason: plan.reason });
    } else if (!gate.allowed) {
      plan.verdict = 'skipped';
      plan.reason = `comms gate denied: ${gate.reason}`;
      failures.push({ invariant: 'commandable', severity: 'member', memberId: gridId, reason: plan.reason });
    }
    return plan;
  });
  const planOf = (gridId: string): FleetMemberPlan => memberPlans.find((p) => p.gridId === gridId)!;
  const canMove = (gridId: string): boolean => planOf(gridId).verdict === 'ok';

  // ------------------------------------------------------------------- kinds
  if (kind === 'swap') {
    if (members.length < 2 || members.length % 2 !== 0) {
      failures.push({
        invariant: 'separation',
        severity: 'hard',
        reason: 'swap needs an even number of members (each pair exchanges two slots)',
      });
    }
    const occupied = [...homes.values()];
    for (let pair = 0; pair < Math.floor(members.length / 2); pair += 1) {
      const aId = members[pair * 2]!;
      const bId = members[pair * 2 + 1]!;
      const a = homes.get(aId);
      const b = homes.get(bId);
      if (!a || !b) continue;
      const temp = stagingPoint(a, b, occupied.filter((p) => p !== a && p !== b), minSeparationM, input.planet);
      if (!temp) {
        failures.push({
          invariant: 'separation',
          severity: 'hard',
          memberId: aId,
          reason: `no temp staging point for ${aId}/${bId} keeps ${minSeparationM} m from every occupied slot`,
        });
        continue;
      }
      occupied.push(temp);
      steps.push(
        step({ wave: 0, memberId: aId, action: 'move', target: temp, suffix: `pair${pair}-a-to-temp` }),
        step({ wave: 1, memberId: bId, action: 'move', target: a, suffix: `pair${pair}-b-to-a` }),
        step({ wave: 2, memberId: aId, action: 'move', target: b, suffix: `pair${pair}-temp-to-b` }),
      );
    }
    notes.push('swap sequences A->temp, B->A, temp->B per pair; the temp point is off the A-B axis so no member flies through another.');
  } else if (kind === 'recall') {
    const base = input.base;
    if (!base) {
      failures.push({ invariant: 'commandable', severity: 'hard', reason: 'recall needs a named base or a base position' });
    } else {
      const slots = recallRing(base, members.length, minSeparationM, input.planet);
      const up = upAt(base, input.planet);
      members.forEach((gridId, i) => {
        const plan = planOf(gridId);
        const home = homes.get(gridId);
        const slot = slots[i] ?? base;
        const landing = { x: slot.x - up.x * 50, y: slot.y - up.y * 50, z: slot.z - up.z * 50 };
        const { flags } = flagsFor(plan.fuelFraction ?? null, plan.health ?? null);
        if (plan.isStatic) {
          steps.push(
            step({
              wave: 0,
              memberId: gridId,
              action: 'unstation',
              target: null,
              suffix: 'unstation',
              reason: 'static grid: convert to ship before the transit',
            }),
          );
        }
        if (home) {
          steps.push(
            step({ wave: 1, memberId: gridId, action: 'move', target: slot, suffix: 'transit' }),
            step({
              wave: 2,
              memberId: gridId,
              action: plan.isStatic ? 'dock' : 'land',
              target: landing,
              suffix: plan.isStatic ? 'dock' : 'land',
            }),
          );
        }
        steps.push(
          step({
            wave: 3,
            memberId: gridId,
            action: 'flag',
            target: null,
            suffix: 'service-flags',
            flags,
            reason: flags.length
              ? `park at base and flag ${flags.join(' + ')}; relaunch requires a new operation`
              : 'park at base; no service flags were warranted by telemetry',
          }),
        );
      });
      notes.push('recall is terminal: it lands/docks, sets NEEDS_REFUEL/NEEDS_REPAIR and never auto-relaunches.');
    }
  } else if (kind === 'reshape') {
    if (!input.slots.length) {
      failures.push({ invariant: 'commandable', severity: 'hard', reason: 'reshape needs at least one {gridId, target} slot' });
    }
    for (const slot of input.slots) {
      if (!members.includes(slot.gridId)) {
        failures.push({
          invariant: 'commandable',
          severity: 'member',
          memberId: slot.gridId,
          reason: 'slot target is not a member of this operation',
        });
        continue;
      }
      const home = homes.get(slot.gridId);
      if (!home) continue;
      if (distanceM(home, slot.target) <= 1) continue;
      steps.push(step({ wave: 0, memberId: slot.gridId, action: 'move', target: slot.target, suffix: 'reshape' }));
    }
    notes.push('reshape is the optimiser shape: one wave of moves to the submitted slots.');
  } else if (kind === 'relocate') {
    if (!input.region) {
      failures.push({ invariant: 'commandable', severity: 'hard', reason: 'relocate needs a target region centre' });
    } else {
      const center = input.region;
      const u = upAt(center, input.planet);
      const { east } = tangentBasis(u);
      const spacing = Math.max(minSeparationM * 2, 400);
      // Spine first: the member the most other nodes depend on leads the
      // migration, then the rest nearest-first. Each member is its own wave, so
      // a wave that would leave the base with no path pauses the operation.
      const dependents = members.map((gridId) => {
        const { victims } = connectivityAfter(
          input.nodes,
          new Map([[gridId, null]]),
          input.planets,
        );
        return { gridId, n: victims.length };
      });
      const order = [...members].sort((a, b) => {
        const da = dependents.find((d) => d.gridId === a)?.n ?? 0;
        const db = dependents.find((d) => d.gridId === b)?.n ?? 0;
        return db - da;
      });
      order.forEach((gridId, i) => {
        const target = {
          x: center.x + east.x * i * spacing,
          y: center.y + east.y * i * spacing,
          z: center.z + east.z * i * spacing,
        };
        steps.push(step({ wave: i, memberId: gridId, action: 'move', target, suffix: 'relocate' }));
      });
      notes.push('relocate migrates one wave at a time, spine (most depended-on member) first; a wave that would strand the base pauses the op.');
    }
  } else if (kind === 'scuttle') {
    for (const gridId of members) {
      const home = homes.get(gridId);
      if (!home) continue;
      const target = input.planet
        ? (() => {
            const u = upAt(home, input.planet);
            return {
              x: input.planet.center.x + u.x * input.planet.surfaceRadiusM,
              y: input.planet.center.y + u.y * input.planet.surfaceRadiusM,
              z: input.planet.center.z + u.z * input.planet.surfaceRadiusM,
            };
          })()
        : { x: home.x, y: home.y - 1_000, z: home.z };
      steps.push(
        step({
          wave: 0,
          memberId: gridId,
          action: 'move',
          target,
          suffix: 'scuttle-ground',
          reason: 'SCUTTLE PLAN ONLY - this build never dispatches a scuttle order',
        }),
      );
      finalPositions.delete(gridId);
    }
    notes.push('scuttle is destructive: this build plans, audits and checks coverage but cannot execute it.');
  }

  // ------------------------------------------------------- distance and fuel
  for (const plan of memberPlans) {
    const dist = plannedDistance(steps, plan.gridId, plan.home ?? null);
    plan.distanceM = dist;
    if (plan.verdict !== 'ok') continue;
    if (dist <= 0) continue;
    const fuel = plan.fuelFraction;
    const power = plan.powerFraction;
    if (fuel === null && power === null) {
      notes.push(`${plan.gridId}: fuel/charge telemetry missing; dispatched with the requirement unverified`);
      continue;
    }
    const available = Math.max(fuel ?? 0, power ?? 0);
    const needed = dist / FULL_TANK_RANGE_M + FUEL_RESERVE;
    if (available + 1e-9 < needed) {
      plan.verdict = 'skipped';
      plan.reason =
        `insufficient fuel/charge for its own step: needs ${(needed * 100).toFixed(1)}% for ${Math.round(dist)} m, ` +
        `has ${(available * 100).toFixed(1)}%`;
      failures.push({ invariant: 'fuel', severity: 'member', memberId: plan.gridId, reason: plan.reason });
    }
  }

  // Skipped members keep their steps, marked skipped, so nothing is dropped
  // silently and a later resume can still see what was refused.
  for (const s of steps) {
    const plan = planOf(s.memberId);
    if (plan && plan.verdict === 'skipped') {
      s.status = 'skipped';
      s.reason = plan.reason ?? 'member skipped by an invariant';
    }
  }

  // ------------------------------------------------------- separation (plan)
  const boundary = new Map<string, FleetVec3>();
  for (const [id, pos] of homes) boundary.set(id, pos);
  const initial = separationFailure(boundary, minSeparationM);
  if (initial) {
    notes.push(`members are already ${initial.reason}; it is recorded, not fatal before any movement.`);
  }
  const waves = [...new Set(steps.map((s) => s.wave))].sort((a, b) => a - b);
  for (const wave of waves) {
    for (const s of steps) {
      if (s.wave !== wave || !s.target) continue;
      if (s.action !== 'move' && s.action !== 'land' && s.action !== 'dock') continue;
      boundary.set(s.memberId, s.target);
    }
    const violation = separationFailure(boundary, minSeparationM);
    if (violation) {
      failures.push({ ...violation, reason: `wave ${wave}: ${violation.reason}` });
    }
  }

  // -------------------------------------------------------- last path / base
  const wavesForConnectivity = waves.filter((wave) => steps.some((s) => s.wave === wave && s.target));
  for (const wave of wavesForConnectivity) {
    const overrides = new Map<string, FleetVec3 | null>();
    for (const s of steps) {
      if (s.wave !== wave || !s.target) continue;
      if (s.action !== 'move' && s.action !== 'land' && s.action !== 'dock') continue;
      overrides.set(s.memberId, s.target);
    }
    if (!overrides.size) continue;
    const { victims, unreachableMoved } = connectivityAfter(input.nodes, overrides, input.planets);
    if (kind === 'relocate') {
      // A relocation legitimately walks the network across regions one wave at
      // a time; the *wave* check pauses if a wave would strand a node, so the
      // plan itself only records where that will happen.
      for (const victim of victims) {
        notes.push(
          `wave ${wave}: relocating ${[...overrides.keys()].join(', ')} would leave ${victim} with no path; the wave will pause instead of dispatching`,
        );
      }
    } else {
      for (const victim of victims) {
        failures.push({
          invariant: 'last_path',
          severity: 'hard',
          reason: `wave ${wave}: moving ${[...overrides.keys()].join(', ')} removes the last path to ${victim}`,
        });
      }
      for (const moved of unreachableMoved) {
        failures.push({
          invariant: 'last_path',
          severity: 'hard',
          memberId: moved,
          reason: `wave ${wave}: ${moved} would fly out of every control path to a base`,
        });
      }
    }
  }

  return {
    steps,
    finalPositions,
    invariants: {
      ok: !failures.some((f) => f.severity === 'hard'),
      checkedAt: input.now,
      members: memberPlans,
      failures,
      notes,
    },
  };
}
