/**
 * T50 fleet operation service: create/plan, approve (with a full re-check),
 * sequenced execution, cancel/abort. All state lives in `fleet_operations`;
 * every method re-reads the row, so a paused operation resumes at the first
 * non-terminal step instead of replaying the sequence.
 *
 * Execution is tick-driven (the runtime timer calls `tickAll`, and the GET
 * route ticks the one operation it returns). Every step that touches a ship is
 * an executor mission, created through the same `createMission` path
 * POST /api/demo/move-to uses (`gridMoveMission`) and approved only because the
 * operation was approved by its owner. The fleet service never sends a raw hub
 * order: it ticks the executor and reads each step's completion from the
 * executor's per-drone state (`holding` / `stationed` / `failed` / `aborted` /
 * `manual`). With feature flag `fleet_ops_execute` OFF nothing is dispatched.
 */
import { randomUUID } from 'node:crypto';
import type { Planet } from '@se-rts/schemas';
import type { Config } from '../../config.js';
import type { PluginHub } from '../../pluginHub.js';
import { loadPlanetCatalog } from '../../planner/index.js';
import { approveMission, cancelMission, createMission, supersedeGridMissions } from '../../missions.js';
import { gridMoveMission, isDesignerMission, type DemoExecutor } from '../executor.js';
import { shipRoles } from '../roles.js';
import type {
  FleetAbortPolicy,
  FleetAbortState,
  FleetCoverage,
  FleetInvariantFailure,
  FleetInvariants,
  FleetOpKind,
  FleetOperation,
  FleetStep,
  FleetStepExecution,
  FleetVec3,
  Store,
} from '../../store.js';
import { loadWorld, type DemoWorld } from '../world.js';
import { getStandIn } from '../standins.js';
import { nearestPlanetTo } from '../moveTo.js';
import { capabilitiesFromStore } from '../network.js';
import { loadTerrainField } from '../terrain.js';
import { computeCoverage, lostCells, type CoverageComputation } from './coverage.js';
import {
  ARRIVAL_TOLERANCE_M,
  ARRIVAL_TIMEOUT_MS,
  FLEET_EXECUTE_FLAG,
  FUEL_RESERVE,
  FULL_TANK_RANGE_M,
  LAND_TOLERANCE_M,
  SCUTTLE_EXECUTE_FLAG,
  connectivityAfter,
  distanceM,
  evaluateMemberGate,
  fleetNodes,
  isManual,
  memberTelemetry,
  planOperation,
  separationFailure,
  unitPosition,
} from './plan.js';

/**
 * T50: cancel every active mission flying one grid before a new one takes it.
 * Fleet and non-fleet missions alike: two missions never fly one grid.
 */
function cancelMissionsOnGrid(store: Store, gridId: string, actor: string, now: number, reason: string): string[] {
  const cancelled: string[] = [];
  for (const mission of store.listMissions({ status: ['queued', 'planned', 'approved', 'executing', 'paused'] })) {
    if (!(mission.assignedUnits ?? []).includes(gridId)) continue;
    if (isDesignerMission(mission)) continue; // designer missions are not single-grid moves
    const res = cancelMission(store, mission.id, actor, now, reason);
    if (res.ok) cancelled.push(mission.id);
  }
  return cancelled;
}

export interface FleetServiceDeps {
  store: Store;
  hub: PluginHub;
  config: Config;
  clock?: () => number;
  fixturePath: string | null;
  /**
   * The demo executor: every fleet flight goes through it. Absent only where
   * the demo stack is not attached (routes are demo-only, so a running service
   * always has one); without it execution refuses instead of sending raw orders.
   */
  executor?: DemoExecutor | null;
}

/**
 * Fleet steps that are one executor mission on one grid. A step is completed
 * only on the executor's verified state, never on telemetry distance.
 * Station steps need `stationed` (the executor's zero -> settle -> convert ->
 * verify isStatic loop); travel steps need a fresh flight order then `holding`.
 */
const EXECUTED_ACTIONS = ['move', 'land', 'dock', 'unstation'] as const;
type ExecutedAction = (typeof EXECUTED_ACTIONS)[number];

/** Fleet actions that hold the grid still: the executor's `holding` is their verified state. */
const HOLD_ACTIONS: readonly FleetStep['action'][] = ['move', 'land', 'dock'];

function isExecuted(step: FleetStep): step is FleetStep & { action: ExecutedAction; target: FleetVec3 } {
  return (EXECUTED_ACTIONS as readonly string[]).includes(step.action) && step.target !== null;
}

function emptyExecution(): FleetStepExecution {
  return { missionId: null, baselineOrders: 0, dispatchedAt: null };
}

/** What the executor's own state says about a dispatched step. */
interface StepOutcome {
  outcome: 'done' | 'pending' | 'failed' | 'aborted' | 'manual' | 'held';
  reason: string;
  verified: { state: string; reason: string | null; at: number };
}

export interface FleetCreateRequest {
  kind: FleetOpKind;
  members?: string[];
  groupId?: string;
  planet?: string;
  minSeparationM?: number;
  dryRun?: boolean;
  abortPolicy?: FleetAbortPolicy;
  base?: { name?: string; position?: FleetVec3 };
  slots?: { gridId: string; target: FleetVec3 }[];
  region?: { center: FleetVec3; label?: string };
  confirm?: boolean;
  /** Ship roles: include PERSONAL ships (the owner must tick and confirm). */
  confirmPersonal?: boolean;
  acceptedCoverageLoss?: boolean;
  includeTerrain?: boolean;
  parentOperationId?: string;
}

export interface FleetActionResult {
  policy?: FleetAbortPolicy;
  policies?: Record<string, FleetAbortPolicy>;
}

export type FleetResult =
  | {
      ok: true;
      operation: FleetOperation;
      execution?: Record<string, unknown>;
      coverage?: { before: FleetCoverage | null; after: FleetCoverage | null };
      note?: string;
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      operation?: FleetOperation | null;
      failure?: FleetInvariantFailure;
      detail?: Record<string, unknown>;
    };

type TravelStep = FleetStep & { target: FleetVec3 };

function isTravel(step: FleetStep): step is TravelStep {
  return (step.action === 'move' || step.action === 'land' || step.action === 'dock') && step.target !== null;
}

const ACTIVE: FleetOperation['status'][] = ['planned', 'approved', 'running', 'paused'];

export class FleetService {
  constructor(private readonly deps: FleetServiceDeps) {}

  private get store(): Store {
    return this.deps.store;
  }

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  private get freshMs(): number {
    return Math.max(this.deps.config.demo.gateFreshMs, 60_000);
  }

  private fail(
    status: number,
    code: string,
    message: string,
    extra: { operation?: FleetOperation | null; failure?: FleetInvariantFailure; detail?: Record<string, unknown> } = {},
  ): FleetResult {
    return { ok: false, status, code, message, ...extra };
  }

  /** `fleet_ops_execute`: OFF unless an operator sets it. Gates every dispatch. */
  private executionEnabled(): boolean {
    return this.store.getFlags()[FLEET_EXECUTE_FLAG] === true;
  }

  /** T50: the executor is constructed after the hub; the runtime attaches it here. */
  attachExecutor(executor: DemoExecutor): void {
    this.deps.executor = executor;
  }

  // ------------------------------------------------------------------ create

  async create(req: FleetCreateRequest, actor: string): Promise<FleetResult> {
    const now = this.now();
    const kind = req.kind;
    let members = (req.members ?? []).filter((m) => typeof m === 'string' && m.length > 0);
    if (req.groupId) {
      const group = this.store.getGroup(req.groupId);
      if (!group) return this.fail(404, 'unknown_group', `unknown group ${req.groupId}`);
      if (!members.length) members = group.members;
    }
    members = [...new Set(members)];
    if (!members.length) {
      return this.fail(400, 'invalid', 'at least one member grid id (or a non-empty group) is required');
    }
    if (kind === 'swap' && (members.length < 2 || members.length % 2 !== 0)) {
      return this.fail(400, 'invalid', 'swap needs an even number of members: each pair exchanges two slots');
    }
    const minSeparationM = req.minSeparationM ?? 100;
    const dryRun = req.dryRun !== false;
    const abortPolicy = req.abortPolicy ?? 'hold';

    const world = loadWorld(this.store, this.deps.fixturePath, now);
    const planets = loadPlanetCatalog();
    const homes = new Map<string, FleetVec3>();
    for (const gridId of members) {
      const pos = unitPosition(this.store, world, gridId);
      if (pos) homes.set(gridId, pos);
    }
    const firstHome = [...homes.values()][0] ?? null;
    const planet = req.planet
      ? planets.find((p) => p.name.toLowerCase() === req.planet!.toLowerCase() || p.id === req.planet) ?? null
      : firstHome
        ? nearestPlanetTo(firstHome, planets)
        : null;
    if (req.planet && !planet) {
      return this.fail(400, 'unknown_planet', `unknown planet ${req.planet}`);
    }

    const base = this.resolveBase(req.base, world);
    if (kind === 'recall' && !base) {
      return this.fail(400, 'invalid', 'recall needs a base: pass base.name (a base in the network) or base.position');
    }
    if (kind === 'reshape' && !(req.slots?.length)) {
      return this.fail(400, 'invalid', 'reshape needs slots: [{ gridId, target: {x,y,z} }]');
    }
    if (kind === 'relocate' && !req.region?.center) {
      return this.fail(400, 'invalid', 'relocate needs region.center {x,y,z}');
    }

    const gates = new Map<string, { allowed: boolean; reason: string; source: string }>();
    const manual = new Set<string>();
    const telemetry = new Map<
      string,
      { fuelFraction: number | null; powerFraction: number | null; health: number | null; isStatic: boolean }
    >();
    for (const gridId of members) {
      gates.set(gridId, evaluateMemberGate(this.store, world, now, gridId, this.deps.config.demo.gateFreshMs));
      if (isManual(this.store, gridId)) manual.add(gridId);
      telemetry.set(gridId, memberTelemetry(this.store, gridId));
    }

    const plan = planOperation({
      kind,
      members,
      homes,
      gates,
      manual,
      membersTelemetry: telemetry,
      minSeparationM,
      planet,
      base,
      slots: req.slots ?? [],
      region: req.region?.center ?? null,
      nodes: fleetNodes(this.store, world, now, this.freshMs),
      planets,
      now,
    });
    plan.invariants.minSeparationM = minSeparationM;

    // Nested scuttle: refuse when it is asked to run inside another operation.
    if (kind === 'scuttle') {
      const parent = req.parentOperationId ?? null;
      const overlapping = this.store
        .listFleetOps({ status: ACTIVE })
        .filter((other) => other.invariants.ok && other.members.some((m) => members.includes(m)));
      if (parent || overlapping.length) {
        plan.invariants.failures.push({
          invariant: 'nested_operation',
          severity: 'hard',
          reason: parent
            ? `scuttle refuses to run inside operation ${parent}`
            : `scuttle refuses to run while ${overlapping.map((o) => o.id).join(', ')} already owns ${members.filter((m) => overlapping.some((o) => o.members.includes(m))).join(', ')}`,
        });
      }
      plan.invariants.ok = !plan.invariants.failures.some((f) => f.severity === 'hard');
    }

    // Coverage: always the terrain-corrected core, never a local re-count.
    let terrain = null;
    if (planet && req.includeTerrain !== false) {
      try {
        terrain = await loadTerrainField(planet);
      } catch {
        terrain = null;
      }
    }
    const beforeComp = planet ? this.coverageFor(planet, world, members, new Map(homes), terrain) : null;
    const afterComp = planet ? this.coverageFor(planet, world, members, plan.finalPositions, terrain, true) : null;
    const lost = lostCells(beforeComp, afterComp);
    if (kind === 'scuttle') {
      plan.invariants.coverageLoss = {
        cells: lost.slice(0, 100),
        count: lost.length,
        accepted: req.acceptedCoverageLoss === true,
      };
      if (lost.length > 0 && req.acceptedCoverageLoss !== true) {
        plan.invariants.failures.push({
          invariant: 'coverage_loss',
          severity: 'hard',
          reason: `${lost.length} cell(s) would lose coverage; pass acceptedCoverageLoss=true to accept, or replan`,
        });
      }
      plan.invariants.notes.push(
        `coverage loss: ${lost.length} cell(s)${lost.length ? ` (first: ${lost.slice(0, 5).map((c) => `${c.latDeg},${c.lonDeg}`).join(' ')})` : ''}; accepted=${req.acceptedCoverageLoss === true}`,
      );
    }
    plan.invariants.ok = !plan.invariants.failures.some((f) => f.severity === 'hard');

    const operation: FleetOperation = {
      id: `fleet-${randomUUID()}`,
      kind,
      planetId: planet?.name ?? null,
      members,
      steps: plan.steps,
      status: 'planned',
      dryRun,
      coverageBefore: beforeComp?.snapshot ?? null,
      coverageAfter: afterComp?.snapshot ?? null,
      invariants: plan.invariants,
      abortPolicy,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      lastError: null,
      ...(req.confirmPersonal === true ? { confirmedPersonal: true } : {}),
    };
    const stored = this.store.createFleetOp(operation);
    if (!stored) return this.fail(409, 'operation_exists', `fleet operation ${operation.id} already exists`);

    const hard = stored.invariants.failures.find((f) => f.severity === 'hard');
    if (hard) {
      this.store.updateFleetOp(stored.id, { lastError: hard.reason }, now);
      return this.fail(409, 'invariant_failed', `plan refused: ${hard.reason}`, {
        operation: this.store.getFleetOp(stored.id),
        failure: hard,
      });
    }
    const skipped = stored.invariants.members.filter((m) => m.verdict === 'skipped');
    return {
      ok: true,
      operation: this.store.getFleetOp(stored.id) ?? stored,
      coverage: { before: stored.coverageBefore, after: stored.coverageAfter },
      note: `${stored.steps.length} step(s) planned for ${members.length} member(s)` +
        `${skipped.length ? `; ${skipped.length} member(s) skipped with the reason listed` : ''}` +
        `${dryRun ? '; dry run, nothing will be dispatched' : ''}`,
    };
  }

  private resolveBase(base: FleetCreateRequest['base'], world: DemoWorld): FleetVec3 | null {
    if (!base) return null;
    if (base.position) return base.position;
    const name = base.name?.trim().toLowerCase();
    if (!name) return null;
    const node = world.nodes.find((n) => n.name.toLowerCase() === name || n.id.toLowerCase() === name);
    if (node) return { ...node.position };
    const unit = this.store.listUnits().find((u) => u.name.toLowerCase() === name || u.id.toLowerCase() === name);
    if (unit?.pos) return { ...unit.pos };
    return null;
  }

  private radioFor(world: DemoWorld, gridId: string): number | null {
    const cap = capabilitiesFromStore(this.store).get(gridId);
    if (cap?.radioRadiusM && cap.radioRadiusM > 0) return cap.radioRadiusM;
    const node = world.nodes.find((n) => n.id === gridId);
    const standin = node ? getStandIn(node.prefab) : null;
    return standin?.radioRadiusM ?? null;
  }

  private coverageFor(
    planet: Planet,
    world: DemoWorld,
    members: string[],
    positions: Map<string, FleetVec3>,
    terrain: Awaited<ReturnType<typeof loadTerrainField>> | null,
    allowEmpty = false,
  ): CoverageComputation | null {
    const nodes = members.flatMap((gridId) => {
      const position = positions.get(gridId);
      if (!position) return [];
      return [{ id: gridId, position, radioRangeM: this.radioFor(world, gridId) }];
    });
    if (!nodes.length && !allowEmpty) return null;
    return computeCoverage({ planet, nodes, terrain });
  }

  // ---------------------------------------------------------------- read/tick

  list(): FleetOperation[] {
    return this.store.listFleetOps();
  }

  get(id: string): FleetOperation | null {
    const op = this.store.getFleetOp(id);
    if (!op) return null;
    return this.tick(op);
  }

  tickAll(): void {
    for (const op of this.store.listFleetOps({ status: ['running'], limit: 50 })) {
      try {
        this.tick(op);
      } catch (err) {
        this.store.updateFleetOp(op.id, {
          status: 'failed',
          lastError: `tick failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // ----------------------------------------------------------------- approve

  approve(id: string, actor: string, body: { confirm?: boolean }): FleetResult {
    const op = this.store.getFleetOp(id);
    if (!op) return this.fail(404, 'unknown_operation', `unknown fleet operation ${id}`);
    if (op.status !== 'planned') {
      return this.fail(409, 'illegal_status', `operation ${id} is ${op.status}; only a planned operation can be approved`);
    }
    const now = this.now();
    const recheck = this.recheck(op);

    // A plan refused at creation must never become approvable later (notably a
    // scuttle whose coverage loss was never accepted).
    const storedHard = op.invariants.failures.find(
      (f) => f.severity === 'hard' && f.invariant !== 'confirm_required',
    );
    if (storedHard) {
      return this.fail(409, 'invariant_failed', `plan was refused when it was created: ${storedHard.reason}`, {
        operation: op,
        failure: storedHard,
      });
    }
    if (
      op.kind === 'scuttle' &&
      op.invariants.coverageLoss &&
      !op.invariants.coverageLoss.accepted
    ) {
      return this.fail(409, 'invariant_failed', 'plan is stale: the coverage loss was never accepted', {
        operation: op,
        failure: {
          invariant: 'coverage_loss',
          severity: 'hard',
          reason: `${op.invariants.coverageLoss.count} cell(s) would lose coverage and acceptedCoverageLoss is not set`,
        },
      });
    }

    if (op.kind === 'scuttle') {
      if (body.confirm !== true) {
        return this.fail(409, 'confirm_required', 'scuttle is destructive: approval requires confirm=true', {
          operation: op,
          failure: { invariant: 'confirm_required', severity: 'hard', reason: 'confirm=true is required for a scuttle plan' },
        });
      }
      if (this.store.getFlags()[SCUTTLE_EXECUTE_FLAG] !== true) {
        return this.fail(409, 'scuttle_flag_off', `scuttle execution is disabled: feature flag ${SCUTTLE_EXECUTE_FLAG} is OFF (it defaults off)`, {
          operation: op,
          failure: { invariant: 'scuttle_execution', severity: 'hard', reason: `feature flag ${SCUTTLE_EXECUTE_FLAG} is OFF` },
        });
      }
      if (recheck.length) {
        return this.fail(409, 'invariant_failed', `plan is stale: ${recheck[0]!.reason}`, { operation: op, failure: recheck[0] });
      }
      // Even with confirm AND the flag, this build refuses to execute: the
      // plan is approved for review only. The guard below re-asserts it on tick.
      const approved = this.store.updateFleetOp(
        op.id,
        {
          status: 'approved',
          invariants: { ...op.invariants, ok: true, checkedAt: now },
          lastError: 'scuttle approved for review only: this build cannot execute a scuttle',
        },
        now,
      )!;
      return {
        ok: true,
        operation: approved,
        execution: { mode: 'plan-only', destructive: true, executed: false, auditRequired: true },
        note: 'scuttle planned and audited; execution is hard-disabled in this build',
      };
    }

    if (recheck.length) {
      const failure = recheck[0]!;
      return this.fail(409, 'invariant_failed', `plan is stale: ${failure.reason}`, { operation: op, failure });
    }

    const nextStatus: FleetOperation['status'] = op.dryRun || !this.executionEnabled() ? 'approved' : 'running';
    let updated = this.store.updateFleetOp(
      op.id,
      {
        status: nextStatus,
        invariants: { ...op.invariants, ok: true, checkedAt: now },
        lastError: null,
      },
      now,
    )!;
    if (!op.dryRun && this.executionEnabled()) updated = this.tick(updated, actor);
    if (op.dryRun) {
      return {
        ok: true,
        operation: updated,
        execution: {
          mode: 'dry-run',
          dispatched: 0,
          total: updated.steps.length,
          note: 'dry run: approve re-checked the invariants, no order was sent',
        },
      };
    }
    if (!this.executionEnabled()) {
      this.store.audit({
        actor,
        action: 'fleet_op_execute_flag_off',
        subject: op.id,
        detail: { operationId: op.id, flag: FLEET_EXECUTE_FLAG, executed: false },
        at: now,
      });
      return {
        ok: true,
        operation: updated,
        execution: {
          mode: 'plan-only',
          executed: false,
          flag: FLEET_EXECUTE_FLAG,
          dispatched: 0,
          total: updated.steps.length,
          note: `approved and planned, but execution is held: feature flag ${FLEET_EXECUTE_FLAG} is OFF (it defaults off); nothing was dispatched`,
        },
        note: `approved for review only: ${FLEET_EXECUTE_FLAG} is OFF, no order was sent`,
      };
    }
    return {
      ok: true,
      operation: updated,
      execution: {
        mode: 'executor',
        executed: true,
        flag: FLEET_EXECUTE_FLAG,
        dispatched: updated.steps.filter((s) => s.status === 'dispatched' || s.status === 'done').length,
        total: updated.steps.length,
        missions: updated.steps.map((s) => s.execution?.missionId ?? null).filter((m): m is string => Boolean(m)),
      },
    };
  }

  /**
   * Approve-time invariant re-run over the *stored* plan. A member whose verdict
   * changed (gate lost, now manual, fuel dropped) or a structural boundary that
   * no longer holds makes the plan stale: 409 instead of approving it.
   */
  private recheck(op: FleetOperation): FleetInvariantFailure[] {
    const now = this.now();
    const world = loadWorld(this.store, this.deps.fixturePath, now);
    const planets = loadPlanetCatalog();
    const nodes = fleetNodes(this.store, world, now, this.freshMs);
    const minSep = op.invariants.minSeparationM ?? 100;
    const failures: FleetInvariantFailure[] = [];

    for (const member of op.invariants.members) {
      const manual = isManual(this.store, member.gridId);
      const gate = evaluateMemberGate(this.store, world, now, member.gridId, this.deps.config.demo.gateFreshMs);
      const tel = memberTelemetry(this.store, member.gridId);
      const reasons: FleetInvariantFailure[] = [];
      if (manual) {
        reasons.push({ invariant: 'manual', severity: 'member', memberId: member.gridId, reason: 'now under manual control' });
      } else if (!gate.allowed) {
        reasons.push({
          invariant: 'commandable',
          severity: 'member',
          memberId: member.gridId,
          reason: `comms gate now denies the grid: ${gate.reason}`,
        });
      }
      const dist = member.distanceM ?? 0;
      if (dist > 0) {
        const fuel = tel.fuelFraction ?? member.fuelFraction ?? null;
        const power = tel.powerFraction ?? member.powerFraction ?? null;
        if (fuel !== null || power !== null) {
          const available = Math.max(fuel ?? 0, power ?? 0);
          const needed = dist / FULL_TANK_RANGE_M + FUEL_RESERVE;
          if (available + 1e-9 < needed) {
            reasons.push({
              invariant: 'fuel',
              severity: 'member',
              memberId: member.gridId,
              reason:
                `no longer has fuel/charge for its step: needs ${(needed * 100).toFixed(1)}%, ` +
                `has ${(available * 100).toFixed(1)}%`,
            });
          }
        }
      }
      const wasSkipped = member.verdict === 'skipped';
      if (!wasSkipped && reasons.length) {
        failures.push(reasons[0]!);
      } else if (wasSkipped && !reasons.length) {
        failures.push({
          invariant: 'commandable',
          severity: 'member',
          memberId: member.gridId,
          reason: 'member is commandable again: the planned skip is stale, replan the operation',
        });
      }
    }

    // Replay the stored trajectory from where the members are NOW.
    const boundary = new Map<string, FleetVec3>();
    for (const gridId of op.members) {
      const pos = unitPosition(this.store, world, gridId);
      if (pos) boundary.set(gridId, pos);
    }
    const active = op.steps.filter((s) => s.status !== 'skipped');
    const waves = [...new Set(active.filter(isTravel).map((s) => s.wave))].sort((a, b) => a - b);
    for (const wave of waves) {
      for (const step of active) {
        if (step.wave !== wave || !isTravel(step)) continue;
        boundary.set(step.memberId, step.target);
      }
      const violation = separationFailure(boundary, minSep);
      if (violation) failures.push({ ...violation, reason: `wave ${wave}: ${violation.reason}` });
    }

    for (const wave of waves) {
      const overrides = new Map<string, FleetVec3 | null>();
      for (const step of active) {
        if (step.wave !== wave || !isTravel(step)) continue;
        overrides.set(step.memberId, step.target);
      }
      if (!overrides.size) continue;
      const { victims, unreachableMoved } = connectivityAfter(nodes, overrides, planets);
      if (op.kind !== 'relocate') {
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
    return failures;
  }

  // -------------------------------------------------------------------- tick

  tick(opIn: FleetOperation, actor?: string): FleetOperation {
    let op = this.store.getFleetOp(opIn.id) ?? opIn;
    if (op.status !== 'running') return op;
    if (this.store.isKillSwitchOn()) return op;
    const now = this.now();
    if (op.kind === 'scuttle') {
      return (
        this.store.setFleetOpStatus(
          op.id,
          'approved',
          'scuttle execution is disabled in this build: no order was sent',
        ) ?? op
      );
    }
    // Without the flag an approved operation is a plan: nothing is dispatched.
    if (!this.executionEnabled()) return op;

    const steps = op.steps.map((s) => ({ ...s }));
    let changed = false;
    // Step completion comes from the executor's per-drone state only.
    for (const step of steps) {
      if (!isExecuted(step) || step.status !== 'dispatched') continue;
      const state = this.executorState(step, now);
      if (!state || state.outcome === 'pending') continue;
      if (state.outcome === 'done') {
        step.status = 'done';
        step.completedAt = now;
        step.execution = { ...(step.execution ?? emptyExecution()), verified: state.verified };
        changed = true;
        continue;
      }
      step.status = state.outcome === 'failed' ? 'failed' : 'skipped';
      step.completedAt = now;
      step.reason = state.reason;
      step.execution = { ...(step.execution ?? emptyExecution()), verified: state.verified };
      changed = true;
      if (state.outcome !== 'held') {
        const failure: FleetInvariantFailure = {
          invariant: state.outcome === 'aborted' ? 'executor_abort' : state.outcome === 'manual' ? 'manual' : 'executor_failed',
          severity: 'member',
          memberId: step.memberId,
          reason: state.reason,
        };
        if (!op.invariants.failures.some((f) => f.memberId === failure.memberId && f.reason === failure.reason)) {
          op.invariants.failures.push(failure);
        }
      }
    }
    const inFlight = steps.filter((s) => s.status === 'dispatched');
    if (inFlight.length) {
      const waiting = inFlight.find((s) => now - (s.dispatchedAt ?? now) > ARRIVAL_TIMEOUT_MS);
      const lastError = waiting
        ? `waiting for the executor to verify ${waiting.memberId}'s ${waiting.action} step (dispatched ${Math.round((now - (waiting.dispatchedAt ?? now)) / 1000)} s ago); not assuming arrival`
        : op.lastError;
      if (changed || lastError !== op.lastError) {
        return this.store.updateFleetOp(op.id, { steps, lastError }, now) ?? op;
      }
      return op;
    }

    let pending = steps.filter((s) => s.status === 'pending');
    if (!pending.length) {
      const anyFailed = steps.some((s) => s.status === 'failed');
      return this.store.updateFleetOp(op.id, { steps, status: 'done', lastError: anyFailed ? op.lastError : null }, now) ?? op;
    }
    const wave = Math.min(...pending.map((s) => s.wave));
    const waveSteps = pending.filter((s) => s.wave === wave);
    const world = loadWorld(this.store, this.deps.fixturePath, now);

    // --- invariant: separation at this wave boundary.
    const boundary = this.currentPositions(op, steps, world);
    for (const step of waveSteps) {
      if (isTravel(step)) boundary.set(step.memberId, step.target);
    }
    const minSep = op.invariants.minSeparationM ?? 100;
    const separation = separationFailure(boundary, minSep);
    if (separation) {
      return this.pauseAt(op, steps, now, wave, { ...separation, reason: `wave ${wave}: ${separation.reason}` });
    }

    // --- invariant: never remove the last path to a base.
    const overrides = new Map<string, FleetVec3 | null>();
    for (const step of waveSteps) {
      if (isTravel(step)) overrides.set(step.memberId, step.target);
    }
    if (overrides.size) {
      const { victims, unreachableMoved } = connectivityAfter(
        fleetNodes(this.store, world, now, this.freshMs),
        overrides,
        loadPlanetCatalog(),
      );
      const blocked =
        victims.length > 0
          ? {
              invariant: 'last_path' as const,
              severity: 'hard' as const,
              reason: `wave ${wave} would leave ${victims.join(', ')} with no path to a base`,
            }
          : op.kind !== 'relocate' && unreachableMoved.length > 0
            ? {
                invariant: 'last_path' as const,
                severity: 'hard' as const,
                memberId: unreachableMoved[0]!,
                reason: `wave ${wave} would fly ${unreachableMoved.join(', ')} out of every control path`,
              }
            : null;
      if (blocked) return this.pauseAt(op, steps, now, wave, blocked);
    }

    // --- invariants: commandable / manual / fuel, re-checked before the step.
    const memberSkip = new Map<string, FleetInvariantFailure>();
    for (const step of waveSteps) {
      // `flag` is bookkeeping (no order leaves the backend), so a lost antenna
      // must not swallow NEEDS_REFUEL/NEEDS_REPAIR after a recall has landed.
      if (step.action === 'flag' || step.action === 'abort') continue;
      if (memberSkip.has(step.memberId)) continue;
      if (isManual(this.store, step.memberId)) {
        memberSkip.set(step.memberId, {
          invariant: 'manual',
          severity: 'member',
          memberId: step.memberId,
          reason: 'under manual control: the pilot owns this grid, it is excluded',
        });
        continue;
      }
      const gate = evaluateMemberGate(this.store, world, now, step.memberId, this.deps.config.demo.gateFreshMs);
      if (!gate.allowed) {
        memberSkip.set(step.memberId, {
          invariant: 'commandable',
          severity: 'member',
          memberId: step.memberId,
          reason: `comms gate denied: ${gate.reason}`,
        });
        continue;
      }
      if (isTravel(step)) {
        const tel = memberTelemetry(this.store, step.memberId);
        const from = this.currentPositions(op, steps, world).get(step.memberId) ?? step.target;
        const dist = distanceM(from, step.target);
        const fuel = tel.fuelFraction;
        const power = tel.powerFraction;
        if (fuel !== null || power !== null) {
          const available = Math.max(fuel ?? 0, power ?? 0);
          const needed = dist / FULL_TANK_RANGE_M + FUEL_RESERVE;
          if (available + 1e-9 < needed) {
            memberSkip.set(step.memberId, {
              invariant: 'fuel',
              severity: 'member',
              memberId: step.memberId,
              reason:
                `insufficient fuel/charge: needs ${(needed * 100).toFixed(1)}% for ${Math.round(dist)} m, ` +
                `has ${(available * 100).toFixed(1)}%`,
            });
          }
        }
      }
    }

    if (!this.deps.hub.isConnected()) {
      return (
        this.store.updateFleetOp(op.id, { steps, lastError: 'plugin offline: wave not dispatched' }, now) ?? op
      );
    }

    const failures = [...op.invariants.failures];
    let sentAny = false;
    let sendFailed = false;
    for (const step of waveSteps) {
      if (step.action === 'flag') {
        step.status = 'done';
        step.completedAt = now;
        step.reason = step.reason ?? `flag ${step.flags?.join(', ') || 'none'}; no relaunch is planned`;
        continue;
      }
      if (step.action === 'abort') {
        step.status = 'skipped';
        step.reason = step.reason ?? 'abort steps resolve through cancel/abort, never on a tick';
        step.completedAt = now;
        continue;
      }
      const skip = memberSkip.get(step.memberId);
      if (skip) {
        step.status = 'skipped';
        step.reason = skip.reason;
        step.completedAt = now;
        if (!failures.some((f) => f.memberId === skip.memberId && f.reason === skip.reason)) failures.push(skip);
        continue;
      }
      // A ship-touching step is one executor mission; it is dispatched only here.
      if (!isExecuted(step)) {
        step.status = 'done';
        step.completedAt = now;
        step.reason = step.reason ?? `${step.action}: no executor mission needed`;
        continue;
      }
      if (this.dispatchStep(op, step, now, actor)) sentAny = true;
      else if (step.status === 'failed') sendFailed = true;
    }
    // Let the executor pick the new missions up now (its own timer also ticks;
    // a tick is idempotent and never sends on a manual or flag-gated grid).
    if (sentAny) this.deps.executor?.tick();

    pending = steps.filter((s) => s.status === 'pending');
    const allTerminal = steps.every((s) => s.status === 'done' || s.status === 'skipped' || s.status === 'failed');
    const nextStatus: FleetOperation['status'] = allTerminal ? 'done' : 'running';
    const lastError = sendFailed
      ? 'one or more steps could not become an executor mission; the wave will retry'
      : sentAny
        ? null
        : op.lastError;
    op = this.store.updateFleetOp(
      op.id,
      { steps, status: nextStatus, invariants: { ...op.invariants, failures }, lastError },
      now,
    )!;
    return op;
  }

  private pauseAt(
    op: FleetOperation,
    steps: FleetStep[],
    now: number,
    wave: number,
    failure: FleetInvariantFailure,
  ): FleetOperation {
    const invariants: FleetInvariants = {
      ...op.invariants,
      ok: false,
      failures: [...op.invariants.failures, failure],
    };
    return (
      this.store.updateFleetOp(
        op.id,
        { steps, status: 'paused', invariants, lastError: `wave ${wave} paused: ${failure.reason}` },
        now,
      ) ?? op
    );
  }

  /** Last planned position per member, falling back to live telemetry then home. */
  private currentPositions(op: FleetOperation, steps: FleetStep[], world: DemoWorld): Map<string, FleetVec3> {
    const out = new Map<string, FleetVec3>();
    for (const gridId of op.members) {
      const done = steps
        .filter((s) => s.memberId === gridId && isTravel(s) && (s.status === 'done' || s.status === 'dispatched'))
        .sort((a, b) => a.wave - b.wave);
      const last = done[done.length - 1];
      const pos =
        (last && isTravel(last) ? last.target : null) ??
        unitPosition(this.store, world, gridId) ??
        op.invariants.members.find((m) => m.gridId === gridId)?.home ??
        null;
      if (pos) out.set(gridId, pos);
    }
    return out;
  }

  /**
   * T50: fly one step by handing it to the executor as a mission.
   *
   * The mission is the same `move:` mission POST /api/demo/move-to creates, so
   * the executor applies every guard it applies to any other flight. Its
   * approval IS this operation's approval: the mission is approved as the fleet
   * service's own owner command (never `auto`), and the audit names the
   * operation id so the owner can trace who approved what.
   */
  private dispatchStep(op: FleetOperation, step: FleetStep, now: number, actor?: string): boolean {
    if (step.status !== 'pending' || !isExecuted(step)) {
      this.store.audit({
        actor: actor ?? op.createdBy,
        action: 'fleet_op_step_refused',
        subject: `fleet:${op.id}:${step.id}`,
        detail: { operationId: op.id, gridId: step.memberId, action: step.action, reason: 'not an executed step' },
        at: now,
      });
      return false;
    }
    // SHIP ROLE: fleet operations are an automatic feature. A PERSONAL ship is
    // only included when the owner selected it AND confirmed the operation; a
    // BASE is never moved and an OFF grid receives nothing.
    const shipRole = shipRoles.roleOf(step.memberId);
    if (shipRole === 'off') {
      step.status = 'skipped';
      step.reason = 'marked OFF in game: this grid receives no orders';
      step.completedAt = now;
      this.auditRefusal(op, step, now, actor, step.reason);
      return false;
    }
    if (shipRole === 'base') {
      step.status = 'skipped';
      step.reason = 'a base is never moved by a fleet operation';
      step.completedAt = now;
      this.auditRefusal(op, step, now, actor, step.reason);
      return false;
    }
    if (shipRole === 'personal' && op.confirmedPersonal !== true) {
      step.status = 'skipped';
      step.reason = 'personal ship: select and confirm it before including it in a fleet operation';
      step.completedAt = now;
      this.auditRefusal(op, step, now, actor, step.reason);
      return false;
    }
    const executor = this.deps.executor;
    if (!executor) return this.executionFailed(op, step, now, actor, 'executor not attached: nothing was dispatched');
    if (isManual(this.store, step.memberId)) {
      step.status = 'skipped';
      step.reason = 'under manual control: no executable mission for this grid';
      step.completedAt = now;
      this.auditRefusal(op, step, now, actor, step.reason);
      return false;
    }
    const gate = evaluateMemberGate(this.store, loadWorld(this.store, this.deps.fixturePath, now), now, step.memberId, this.deps.config.demo.gateFreshMs);
    const gateNodeId = this.worldNodeFor(step.memberId) ?? gate.source;
    const created = createMission(
      this.store,
      gridMoveMission({
        gridId: step.memberId,
        target: step.target,
        gateNodeId,
        ...(shipRole === 'personal' && op.confirmedPersonal === true ? { personalConfirmed: true } : {}),
      }),
      { now, actor: actor ?? op.createdBy, autoMissionTypes: this.deps.config.autoMissionTypes, maxQueuedBuilds: this.deps.config.caps.maxQueuedBuilds },
    );
    if (!created.ok) return this.executionFailed(op, step, now, actor, `mission could not be created: ${created.message}`);
    // One grid, one mission: this step's mission supersedes whatever flew it.
    const superseded = supersedeGridMissions(
      this.store,
      step.memberId,
      created.mission.id,
      actor ?? op.createdBy,
      now,
      `superseded by fleet operation ${op.id}`,
    );
    const approved = approveMission(this.store, created.mission.id, `fleet-op:${op.id}`, now);
    if (!approved.ok) return this.executionFailed(op, step, now, actor, `mission could not be approved: ${approved.message}`);
    const orders = executor.gridStates(step.memberId).find((s) => s.missionId === created.mission.id)?.ordersSent ?? 0;
    step.orderId = created.mission.id;
    step.dispatchedAt = now;
    step.status = 'dispatched';
    step.execution = { missionId: created.mission.id, baselineOrders: orders, dispatchedAt: now };
    this.store.audit({
      actor: actor ?? 'fleet-op',
      action: 'fleet_op_step_dispatched',
      subject: created.mission.id,
      detail: {
        operationId: op.id,
        kind: op.kind,
        gridId: step.memberId,
        stepId: step.id,
        action: step.action,
        target: step.target,
        missionId: created.mission.id,
        superseded,
        approvedBy: `fleet-op:${op.id}`,
      },
      at: now,
    });
    if (superseded.length) op.invariants.notes.push(`${step.memberId}: superseded ${superseded.join(', ')}`);
    return true;
  }

  /** Fixture/world node id for a grid, so the mission carries a real gate node. */
  private worldNodeFor(gridId: string): string | null {
    const world = loadWorld(this.store, this.deps.fixturePath, this.now());
    return world.nodes.find((n) => n.id === gridId)?.id ?? null;
  }

  private auditRefusal(op: FleetOperation, step: FleetStep, now: number, actor: string | undefined, reason: string): void {
    this.store.audit({
      actor: actor ?? op.createdBy,
      action: 'fleet_op_step_refused',
      subject: `fleet:${op.id}:${step.id}`,
      detail: { operationId: op.id, gridId: step.memberId, action: step.action, reason },
      at: now,
    });
  }

  private executionFailed(
    op: FleetOperation,
    step: FleetStep,
    now: number,
    actor: string | undefined,
    reason: string,
  ): false {
    step.status = 'failed';
    step.reason = reason;
    step.completedAt = now;
    this.auditRefusal(op, step, now, actor, reason);
    return false;
  }

  /**
   * T50: the executor's verified state for a dispatched step. Completion is
   * `holding` after this step's mission has flown (or `stationed` for a station
   * step which the executor only reaches through zero -> settle -> convert ->
   * verify isStatic). A state left over from an earlier mission does not count.
   */
  private executorState(step: FleetStep, now: number): StepOutcome | null {
    const executor = this.deps.executor;
    if (!executor) return null;
    const missionId = step.execution?.missionId ?? null;
    if (!missionId) {
      return { outcome: 'failed', reason: 'step has no executor mission recorded', verified: { state: 'missing', reason: null, at: now } };
    }
    const states = executor.gridStates(step.memberId).filter((s) => s.missionId === missionId);
    if (!states.length) {
      // A grid the executor recreated keeps flying but reports from its new
      // grid id; its own audit trail still says the flight was aborted.
      const verdict = this.executorAbortVerdict(missionId);
      if (verdict) {
        return {
          outcome: 'aborted',
          reason: `executor aborted the flight: ${verdict.reason ?? 'safety guard'}`,
          verified: { state: 'aborted', reason: verdict.reason, at: now },
        };
      }
      return { outcome: 'pending', reason: 'executor has not synced this mission yet', verified: { state: 'not_synced', reason: null, at: now } };
    }
    const freshFlights = states.some((s) => s.ordersSent > (step.execution?.baselineOrders ?? 0));
    for (const s of states) {
      const verified = { state: s.state, reason: s.reason, at: now };
      if (s.state === 'holding' && freshFlights) {
        return { outcome: 'done', reason: s.reason ?? 'executor verified arrival: holding at its slot', verified };
      }
      if (s.state === 'aborted') {
        return { outcome: 'aborted', reason: `executor aborted the flight: ${s.reason ?? 'safety guard'}`, verified };
      }
      if (s.state === 'failed') {
        return { outcome: 'failed', reason: `executor failed the mission: ${s.reason ?? 'no reason given'}`, verified };
      }
      if (s.state === 'manual') {
        return { outcome: 'manual', reason: `player took control: ${s.reason ?? 'manual handoff'}; no order has or will be sent`, verified };
      }
      if (s.state === 'stopped' && step.execution?.aborting === 'hold') {
        return { outcome: 'held', reason: `held by ${s.reason ?? 'executor'}`, verified };
      }
      if (s.state === 'stopped') {
        return { outcome: 'failed', reason: `executor stopped the drone: ${s.reason ?? 'released'}`, verified };
      }
    }
    return { outcome: 'pending', reason: 'executor is still flying this step', verified: { state: states[0]!.state, reason: states[0]!.reason, at: now } };
  }

  // ------------------------------------------------------------ cancel/abort

  cancel(id: string, actor: string, body: FleetActionResult = {}): FleetResult {
    const op = this.store.getFleetOp(id);
    if (!op) return this.fail(404, 'unknown_operation', `unknown fleet operation ${id}`);
    if (op.status === 'cancelled' || op.status === 'done') {
      return { ok: true, operation: op, note: `operation is already ${op.status}` };
    }
    if (op.status === 'planned' || op.status === 'approved') {
      const cancelled = this.store.updateFleetOp(
        op.id,
        {
          status: 'cancelled',
          steps: op.steps.map((s) =>
            s.status === 'pending' ? { ...s, status: 'skipped' as const, reason: `cancelled by ${actor} before execution` } : s,
          ),
          lastError: `cancelled by ${actor} before execution; no order was sent`,
        },
        this.now(),
      )!;
      return { ok: true, operation: cancelled, note: 'cancelled before execution: no order was sent' };
    }
    return this.abortInternal(op, actor, body, 'cancelled');
  }

  abort(id: string, actor: string, body: FleetActionResult = {}): FleetResult {
    const op = this.store.getFleetOp(id);
    if (!op) return this.fail(404, 'unknown_operation', `unknown fleet operation ${id}`);
    if (op.status !== 'running' && op.status !== 'paused') {
      return this.fail(409, 'illegal_status', `operation ${id} is ${op.status}; only a running or paused operation can be aborted`);
    }
    return this.abortInternal(op, actor, body, 'aborted');
  }

  private abortInternal(
    op: FleetOperation,
    actor: string,
    body: FleetActionResult,
    verb: 'cancelled' | 'aborted',
  ): FleetResult {
    const now = this.now();
    const defaultPolicy = body.policy ?? op.abortPolicy;
    const abort: FleetAbortState[] = [];
    const steps = op.steps.map((s) =>
      s.status === 'pending' ? { ...s, status: 'skipped' as const, reason: `${verb} by ${actor}; step never dispatched` } : s,
    );
    for (const gridId of op.members) {
      const policy = body.policies?.[gridId] ?? defaultPolicy;
      const home = op.invariants.members.find((m) => m.gridId === gridId)?.home ?? null;
      let state: FleetAbortState;
      if (policy === 'continue') {
        state = {
          gridId,
          policy,
          action: 'continue',
          reason: 'left flying: policy continue leaves the executor mission running',
        };
      } else if (isManual(this.store, gridId)) {
        state = {
          gridId,
          policy,
          action: 'hold',
          reason: 'under manual control: no abort order was sent to the pilot',
        };
      } else if (!this.executionEnabled()) {
        state = {
          gridId,
          policy,
          action: policy,
          reason: `execution held: feature flag ${FLEET_EXECUTE_FLAG} is OFF, no abort order was sent`,
        };
      } else {
        const resolved = this.resolveAbort(op, steps, gridId, policy, home, now, actor);
        state = { gridId, policy, action: policy === 'hold' || !home ? 'hold' : 'return', ...resolved };
      }
      abort.push(state);
    }
    const updated = this.store.updateFleetOp(
      op.id,
      {
        steps,
        status: 'cancelled',
        invariants: { ...op.invariants, abort },
        lastError: `${verb} by ${actor} (policy ${defaultPolicy})`,
      },
      now,
    )!;
    // Abort steps are appended after the status write so they land in the row
    // the owner reads, and each one is individually addressable by step id.
    for (const state of abort) {
      this.store.appendFleetOpStep(op.id, {
        id: `abort:${state.gridId}`,
        wave: 999,
        memberId: state.gridId,
        action: 'abort',
        target: op.invariants.members.find((m) => m.gridId === state.gridId)?.home ?? null,
        status: state.orderId ? 'done' : 'skipped',
        reason: state.reason,
        ...(state.orderId ? { orderId: state.orderId } : {}),
        completedAt: now,
      });
    }
    const final = this.store.getFleetOp(op.id) ?? updated;
    return { ok: true, operation: final, note: `${verb}: ${abort.length} member(s) resolved by the abort policy` };
  }

  /**
   * T50: resolve one member's abort through the executor, never a raw order.
   *
   * hold   -> cancel whatever is flying, then a mission to park the grid where
   *           it is now; its executor `holding` is the hold.
   * return -> cancel whatever is flying, then a mission to the member's home
   *           slot; the executor flies it with every flight guard.
   */
  private resolveAbort(
    op: FleetOperation,
    steps: FleetStep[],
    gridId: string,
    policy: FleetAbortPolicy,
    home: FleetVec3 | null,
    now: number,
    actor: string,
  ): { orderId?: string; reason: string } {
    const executor = this.deps.executor;
    if (!executor) return { reason: 'executor not attached: no abort mission was created' };
    const world = loadWorld(this.store, this.deps.fixturePath, now);
    const target = policy === 'return' && home ? home : (unitPosition(this.store, world, gridId) ?? home);
    if (!target) return { reason: 'no position or home recorded: nothing to hold or return to' };
    const verb = policy === 'return' && home ? 'return' : 'hold';
    // Cancel every mission flying this grid (fleet or not): the abort replaces it.
    const cancelled: string[] = [];
    for (const s of steps) {
      if (s.memberId !== gridId) continue;
      if (s.execution?.missionId) {
        const res = cancelMission(this.store, s.execution.missionId, actor, now, `fleet operation ${op.id} ${verb}`);
        if (res.ok) cancelled.push(s.execution.missionId);
      }
      if (s.status === 'dispatched') {
        s.status = 'skipped';
        s.reason = `${verb} by ${actor}; executor mission cancelled`;
        s.completedAt = now;
        s.execution = { ...(s.execution ?? emptyExecution()), aborting: policy };
      }
    }
    cancelled.push(...cancelMissionsOnGrid(this.store, gridId, actor, now, `fleet operation ${op.id} ${verb}`));
    const gateNodeId = this.worldNodeFor(gridId) ?? 'unknown';
    const created = createMission(
      this.store,
      gridMoveMission({ gridId, target, gateNodeId }),
      { now, actor, autoMissionTypes: this.deps.config.autoMissionTypes, maxQueuedBuilds: this.deps.config.caps.maxQueuedBuilds },
    );
    if (!created.ok) return { reason: `abort mission could not be created: ${created.message}` };
    const approved = approveMission(this.store, created.mission.id, `fleet-op:${op.id}`, now);
    if (!approved.ok) return { reason: `abort mission could not be approved: ${approved.message}` };
    executor.tick();
    this.store.audit({
      actor,
      action: 'fleet_op_abort_mission',
      subject: created.mission.id,
      detail: { operationId: op.id, gridId, policy: verb, target, cancelled, missionId: created.mission.id },
      at: now,
    });
    return {
      orderId: created.mission.id,
      reason:
        verb === 'return'
          ? 'return: executor mission to the member home slot created'
          : 'hold: flying mission cancelled, executor mission parking the grid in place created',
    };
  }

  /**
   * T50: watch for a step mission that ended without a drone state (the
   * executor only writes one when the state changes, e.g. a re-created grid).
   * Uses the executor's own audit trail, never telemetry distance.
   */
  private executorAbortVerdict(missionId: string): { reason: string | null } | null {
    const row = this.store.db
      .prepare(
        `SELECT detail FROM audit_log
         WHERE subject = ? AND action = 'demo_drone_state'
           AND detail LIKE '%"state":"aborted"%'
         ORDER BY at DESC, rowid DESC LIMIT 1`,
      )
      .get(missionId) as { detail: string | null } | undefined;
    if (!row) return null;
    try {
      const detail = JSON.parse(row.detail ?? '{}') as { reason?: unknown };
      return { reason: typeof detail.reason === 'string' ? detail.reason : null };
    } catch {
      return { reason: null };
    }
  }
}

