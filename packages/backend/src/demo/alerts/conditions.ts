/**
 * Pure condition evaluation for T68. One pass over the current world snapshot;
 * no store writes, no network, no clock reads (everything comes from ctx.now).
 *
 * NULL IS NOT ZERO. Every condition requires the reading that proves it:
 *   * a runway needs a non-null component and a fresh snapshot;
 *   * a stale grid needs a lastSeenAt (a grid never seen is unknown, not stale);
 *   * SimSpeed needs a sample and a measured below-threshold duration.
 * Missing evidence means no alert, never an alert with zeros in it.
 */
import { formatRunway } from '../power/rates.js';
import type { AlertCandidate, AlertContext, AlertGrid } from './types.js';
import type { AlertsSettings } from './settings.js';
import {
  fleetViewAction,
  planFixAction,
  powerSaveAction,
  recallAction,
  stopAllAction,
} from './actions.js';

function nameOf(grid: AlertGrid): string {
  return grid.name || grid.id;
}

function formatVec(position: { x: number; y: number; z: number } | null): string {
  if (!position) return 'unknown';
  const round = (value: number): string => String(Math.round(value));
  return `(${round(position.x)}, ${round(position.y)}, ${round(position.z)})`;
}

function describeLinks(links: { id: string; name: string | null; kind: string; distanceM: number | null }[]): string {
  if (links.length === 0) return 'no recorded links';
  return links
    .map((link) => {
      const label = link.name ? `${link.name} (${link.id})` : link.id;
      const distance = link.distanceM === null ? '' : ` ${(link.distanceM / 1000).toFixed(1)} km`;
      return `${label} via ${link.kind}${distance}`;
    })
    .join(', ');
}

/** Which component produced the smallest runway. */
function limitingRunway(grid: AlertGrid): { resource: 'battery' | 'hydrogen' | 'uranium'; minutes: number } | null {
  const parts: { resource: 'battery' | 'hydrogen' | 'uranium'; minutes: number | null }[] = [
    { resource: 'battery', minutes: grid.powerRunwayMin },
    { resource: 'hydrogen', minutes: grid.fuelRunwayMin },
    { resource: 'uranium', minutes: grid.uraniumRunwayMin },
  ];
  const known = parts.filter((p): p is { resource: 'battery' | 'hydrogen' | 'uranium'; minutes: number } =>
    p.minutes !== null && Number.isFinite(p.minutes),
  );
  if (!known.length) return null;
  return known.reduce((a, b) => (b.minutes < a.minutes ? b : a));
}

export function evaluateConditions(ctx: AlertContext, settings: AlertsSettings): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const now = ctx.now;

  // ---------------------------------------------------------- plugin link down
  // A frozen telemetry stream is the link's fault, not the grids': one system
  // alert here, and every liveness condition below stays silent.
  if (!ctx.pluginConnected) {
    out.push({
      kind: 'plugin-link-down',
      severity: 'critical',
      subjectType: 'system',
      subjectId: 'plugin',
      message:
        'Plugin link is down: telemetry is frozen, so grid-lost, telemetry and coverage changes ' +
        'cannot be judged until the plugin reconnects.',
      evidence: {
        source: 'plugin hub',
        pluginConnected: false,
      },
      actions: [fleetViewAction()],
    });
  }

  // ---------------------------------------------------------------- grid lost
  // `ctx.grids` only contains grids that are still here, so disappearance has to
  // be judged against the last state this engine saw (knownGrids). Absence from
  // the list while the link is up is proof; otherwise it is 2 poll intervals
  // without a telemetry sample.
  const deleted = new Set(ctx.deletedGridIds ?? []);
  const currentById = new Map(ctx.grids.map((grid) => [grid.id, grid]));
  const lostIds = new Set<string>();
  for (const known of ctx.knownGrids ?? []) {
    if (deleted.has(known.id)) continue; // deleted through our own API: deliberate
    if (!ctx.pluginConnected) continue; // the link alert covers this outage
    const current = currentById.get(known.id);
    const lastSeenAt = current?.lastSeenAt ?? known.lastSeenAt;
    const age = Math.max(0, now - lastSeenAt);
    const absent = current === undefined;
    if (!absent && age <= settings.gridLostAfterMs) continue;
    lostIds.add(known.id);
    const altitude = known.altitudeM === null ? 'altitude unknown' : `${Math.round(known.altitudeM)} m AGL`;
    const planet = known.planet ? ` over ${known.planet}` : '';
    out.push({
      kind: 'grid-lost',
      severity: 'critical',
      subjectType: 'grid',
      subjectId: known.id,
      message:
        `${known.name} (${known.id}) is lost: ` +
        (absent
          ? 'absent from the live grid list'
          : `no telemetry for ${Math.round(age / 1000)} s (limit ${Math.round(settings.gridLostAfterMs / 1000)} s)`) +
        `. Last known position ${formatVec(known.position)}, ${altitude}${planet}; ` +
        `was linked to ${describeLinks(known.linkedTo)}.`,
      evidence: {
        source: 'plugin telemetry + live link graph (last known state)',
        gridId: known.id,
        name: known.name,
        reason: absent ? 'absent-from-grid-list' : 'telemetry-age',
        lastSeenAt,
        ageMs: age,
        thresholdMs: settings.gridLostAfterMs,
        position: known.position,
        altitudeM: known.altitudeM,
        planet: known.planet,
        linkedTo: known.linkedTo,
        pluginConnected: ctx.pluginConnected,
      },
      actions: [fleetViewAction()],
    });
  }

  for (const grid of ctx.grids) {
    const name = nameOf(grid);

    // ---------------------------------------------------------- energy runway
    const power = grid.power;
    const snapshotFresh = power !== null && now - power.at <= settings.readingStaleMs;
    if (grid.runwayMin !== null && grid.runwayMin <= settings.runwayHours * 60 && snapshotFresh && power) {
      const limiting = limitingRunway(grid);
      if (limiting) {
        const critical = grid.runwayMin < settings.runwayCriticalMin;
        out.push({
          kind: 'energy-runway',
          severity: critical ? 'critical' : 'warn',
          subjectType: 'grid',
          subjectId: grid.id,
          message:
            `${name} runs out of ${limiting.resource} in ${formatRunway(limiting.minutes)} ` +
            `(projected from the live profile: ` +
            [
              grid.powerRunwayMin !== null ? `battery ${formatRunway(grid.powerRunwayMin)}` : null,
              grid.fuelRunwayMin !== null ? `hydrogen ${formatRunway(grid.fuelRunwayMin)}` : null,
              grid.uraniumRunwayMin !== null ? `uranium ${formatRunway(grid.uraniumRunwayMin)}` : null,
            ]
              .filter(Boolean)
              .join(', ') +
            ').',
          evidence: {
            source: 'power profile (30 s poll)',
            sampledAt: power.at,
            runwayMin: grid.runwayMin,
            powerRunwayMin: grid.powerRunwayMin,
            fuelRunwayMin: grid.fuelRunwayMin,
            uraniumRunwayMin: grid.uraniumRunwayMin,
            limiting: limiting.resource,
            batteryPct: power.batteryPct,
            netMw: power.netMw,
            h2Pct: power.h2Pct,
            uraniumPct: power.uraniumPct,
            thresholdHours: settings.runwayHours,
          },
          actions: [powerSaveAction(grid.id), recallAction(grid.id)],
        });
      }
    }

    // ------------------------------------------------------------- fuel flags
    // Null-safe by construction: `null < 15` is false in JS but the explicit
    // check keeps the intent readable.
    if (power && snapshotFresh) {
      const h2Low = power.h2Pct !== null && power.h2Pct < 10 && power.isStatic !== true;
      const uraniumLow = power.uraniumPct !== null && power.uraniumPct < 10;
      if (h2Low || uraniumLow) {
        out.push({
          kind: 'needs-refuel',
          severity: 'warn',
          subjectType: 'grid',
          subjectId: grid.id,
          message:
            `${name} needs fuel: ` +
            [
              h2Low ? `hydrogen at ${power.h2Pct!.toFixed(1)}%` : null,
              uraniumLow ? `reactor uranium at ${power.uraniumPct!.toFixed(1)}%` : null,
            ]
              .filter(Boolean)
              .join(', ') +
            '.',
          evidence: {
            source: 'power profile (30 s poll)',
            sampledAt: power.at,
            h2Pct: power.h2Pct,
            uraniumPct: power.uraniumPct,
            h2Litres: power.h2Litres,
            uraniumKg: power.uraniumKg,
          },
          actions: [recallAction(grid.id), powerSaveAction(grid.id)],
        });
      }
    }

    // ------------------------------------------------------ isolated from base
    // Bases are the sources by definition; a base with no path to itself is a
    // graph bug, not an alert. A grid with no known position is unknown, and a
    // stale grid is already covered by the telemetry condition (the graph
    // drops stale nodes, so it would otherwise read as "isolated" too).
    const telemetryAge = grid.lastSeenAt === null ? null : Math.max(0, now - grid.lastSeenAt);
    const telemetryKnown = telemetryAge === null || telemetryAge <= settings.telemetryStaleMs;
    if (
      !grid.reachable &&
      !grid.isBase &&
      ctx.baseCount > 0 &&
      telemetryKnown &&
      !lostIds.has(grid.id) &&
      (grid.position !== null || grid.lastSeenAt !== null)
    ) {
      out.push({
        kind: 'grid-isolated',
        severity: 'warn',
        subjectType: 'grid',
        subjectId: grid.id,
        message:
          `${name} is isolated from every base: no path through the antenna/laser graph ` +
          `(${ctx.baseCount} base${ctx.baseCount === 1 ? '' : 's'} known). Commands are refused by the gate.`,
        evidence: {
          source: 'comms gate / live link graph',
          reachable: false,
          baseCount: ctx.baseCount,
          gate: grid.gate,
          lastSeenAt: grid.lastSeenAt,
          planet: grid.planet,
          altitudeM: grid.altitudeM,
        },
        actions: [planFixAction(grid.planet ?? 'EarthLike'), fleetViewAction()],
      });
    }

    // ------------------------------------------------------ player in control
    if (grid.underControl) {
      out.push({
        kind: 'grid-under-control',
        severity: 'warn',
        subjectType: 'grid',
        subjectId: grid.id,
        message:
          `${name} is under player control` +
          (grid.controlledBy ? ` (${grid.controlledBy})` : '') +
          ': the fleet sends no orders and its mission is paused.',
        evidence: {
          source: grid.power ? 'power profile (control block)' : 'telemetry',
          controlledBy: grid.controlledBy,
          sampledAt: grid.power?.at ?? null,
        },
        actions: [fleetViewAction()],
      });
    }

    // ------------------------------------------------------- stale telemetry
    const age = grid.lastSeenAt === null ? null : Math.max(0, now - grid.lastSeenAt);
    if (
      ctx.pluginConnected &&
      grid.shouldReport &&
      !lostIds.has(grid.id) &&
      age !== null &&
      age > settings.telemetryStaleMs
    ) {
      const critical = age > settings.telemetryStaleMs * 4;
      out.push({
        kind: 'telemetry-stale',
        severity: critical ? 'critical' : 'warn',
        subjectType: 'grid',
        subjectId: grid.id,
        message:
          `${name} has not reported telemetry for ${formatRunway(age / 60_000)} ` +
          `(expected every ~2 s while the plugin is connected).`,
        evidence: {
          source: 'plugin telemetry',
          lastSeenAt: grid.lastSeenAt,
          ageMs: age,
          thresholdMs: settings.telemetryStaleMs,
          pluginConnected: ctx.pluginConnected,
        },
        actions: [fleetViewAction()],
      });
    }
  }

  // ------------------------------------------------------------- coverage holes
  for (const cov of ctx.coverage) {
    if (cov.totalCells <= 0) continue;
    // "Nothing deployed here yet" is not a hole. A constellation that vanished
    // is reported as grid-lost (per node) and as a coverage drop, not as a hole
    // with no nodes in it.
    if (cov.nodeIds.length === 0) continue;
    if (cov.uncoveredCells < settings.coverageHoleCells) continue;
    const critical = cov.coveragePct < 50;
    out.push({
      kind: 'coverage-hole',
      severity: critical ? 'critical' : 'warn',
      subjectType: 'planet',
      subjectId: cov.planet,
      message:
        `${cov.planet}: ${cov.uncoveredCells} of ${cov.totalCells} surface cells are uncovered ` +
        `(${cov.coveragePct.toFixed(1)}% covered, ${cov.cellDeg}° cells, k=${cov.k}).`,
      evidence: {
        source: 'coverage grid over live node positions',
        terrain: cov.terrain,
        planId: cov.planId,
        uncoveredCells: cov.uncoveredCells,
        totalCells: cov.totalCells,
        coveragePct: cov.coveragePct,
        cellDeg: cov.cellDeg,
        k: cov.k,
        nodeIds: cov.nodeIds,
        thresholdCells: settings.coverageHoleCells,
      },
      actions: [planFixAction(cov.planet)],
    });
  }

  // ------------------------------------------------------------- coverage drop
  // The hole above is absolute ("too many cells uncovered") and, once open,
  // dedupe keeps updating the same row — it can never say "this got worse".
  // This compares the stored percentage from the previous evaluation and also
  // reports a planet that is simply below the goal while its plan is active.
  const baselineByPlanet = new Map((ctx.coverageBaseline ?? []).map((sample) => [sample.planet, sample]));
  for (const cov of ctx.coverage) {
    if (cov.totalCells <= 0) continue;
    const previous = baselineByPlanet.get(cov.planet);
    const inWindow = previous !== undefined && now - previous.at <= settings.coverageDropWindowMs;
    const deltaPct =
      previous !== undefined && inWindow
        ? Math.round((cov.coveragePct - previous.coveragePct) * 10) / 10
        : null;
    const dropped = deltaPct !== null && deltaPct < -settings.coverageDropPct;
    const underGoal = cov.planId !== null && cov.coveragePct < settings.coverageGoalPct;
    if (!dropped && !underGoal) continue;

    const parts: string[] = [];
    if (dropped && previous) {
      parts.push(
        `coverage fell ${Math.abs(deltaPct!).toFixed(1)} points to ${cov.coveragePct.toFixed(1)}% ` +
          `(delta ${deltaPct!.toFixed(1)}, was ${previous.coveragePct.toFixed(1)}% ` +
          `${Math.round((now - previous.at) / 1000)} s ago)`,
      );
    }
    if (underGoal) {
      parts.push(`below the ${settings.coverageGoalPct.toFixed(0)}% goal for its active plan`);
    }
    out.push({
      kind: 'coverage-drop',
      severity: 'warn',
      subjectType: 'planet',
      subjectId: cov.planet,
      message:
        `${cov.planet}: ${parts.join('; ')} ` +
        `(${cov.coveragePct.toFixed(1)}% covered, ${cov.uncoveredCells} of ${cov.totalCells} cells uncovered, ` +
        `${cov.nodeIds.length} live node${cov.nodeIds.length === 1 ? '' : 's'}).`,
      evidence: {
        source: 'coverage grid over live node positions (previous sample kept in kv)',
        planId: cov.planId,
        coveragePct: cov.coveragePct,
        previousPct: previous?.coveragePct ?? null,
        previousAt: previous?.at ?? null,
        deltaPct,
        thresholdPct: settings.coverageDropPct,
        windowMs: settings.coverageDropWindowMs,
        goalPct: settings.coverageGoalPct,
        underGoal,
        uncoveredCells: cov.uncoveredCells,
        totalCells: cov.totalCells,
        cellDeg: cov.cellDeg,
        k: cov.k,
        nodeIds: cov.nodeIds,
      },
      actions: [planFixAction(cov.planet)],
    });
  }

  // ------------------------------------------------------ failed/aborted mission
  for (const failure of ctx.executions) {
    if (now - failure.at > settings.missionFailWindowMs) continue;
    const gridId = failure.gridId;
    out.push({
      kind: failure.state === 'aborted' ? 'mission-aborted' : 'mission-failed',
      severity: 'warn',
      subjectType: gridId ? 'grid' : 'system',
      subjectId: gridId ?? `mission:${failure.missionId}`,
      message:
        `${failure.name ?? gridId ?? failure.missionId} ${failure.state === 'aborted' ? 'was aborted by a safety guard' : 'failed'}` +
        ` (mission ${failure.missionId})` +
        (failure.reason ? `: ${failure.reason}` : '.'),
      evidence: {
        source: 'demo executor',
        missionId: failure.missionId,
        gridId,
        state: failure.state,
        reason: failure.reason,
        at: failure.at,
        windowMs: settings.missionFailWindowMs,
      },
      actions: gridId ? [recallAction(gridId), fleetViewAction()] : [fleetViewAction()],
    });
  }

  // --------------------------------------------------------------- sim speed
  const sim = ctx.simSpeed;
  if (
    sim &&
    sim.value !== null &&
    sim.value < sim.threshold &&
    sim.belowForMs >= settings.simSpeedHoldMs
  ) {
    const critical = sim.value < sim.threshold * 0.75;
    out.push({
      kind: 'sim-speed',
      severity: critical ? 'critical' : 'warn',
      subjectType: 'system',
      subjectId: 'sim',
      message:
        `Sim speed ${sim.value.toFixed(2)} is below ${sim.threshold.toFixed(2)} for ` +
        `${formatRunway(sim.belowForMs / 60_000)}: new flight orders are held.`,
      evidence: {
        source: 'SimSpeed monitor (Remote API)',
        value: sim.value,
        threshold: sim.threshold,
        belowForMs: sim.belowForMs,
        sampleAt: sim.sampleAt,
        holdMs: settings.simSpeedHoldMs,
      },
      actions: [stopAllAction(), fleetViewAction()],
    });
  }

  // -------------------------------------------------- come-to-me waited too long
  // INFO, never a flight decision: the ship is holding exactly where it was
  // told to. The alert exists so the owner knows nobody walked over to it.
  for (const wait of ctx.comeToMeWaits ?? []) {
    const waitedMs = now - wait.readyAt;
    if (waitedMs < wait.timeoutMs) continue;
    const who = wait.playerName ?? wait.player ?? 'the player';
    out.push({
      kind: 'come-to-me-timeout',
      severity: 'info',
      subjectType: 'grid',
      subjectId: wait.gridId,
      message:
        `${wait.name ?? wait.gridId} has been hovering for ${who} for ${formatRunway(waitedMs / 60_000)} ` +
        `(timeout ${formatRunway(wait.timeoutMs / 60_000)}) and nobody has taken control. ` +
        'It keeps hovering: it never lands or leaves on its own.',
      evidence: {
        source: 'come-to-me mission (desiredState.comeToMe.phase = waiting_for_pilot)',
        missionId: wait.missionId,
        gridId: wait.gridId,
        player: wait.player,
        playerName: wait.playerName,
        readyAt: wait.readyAt,
        waitedMs,
        timeoutMs: wait.timeoutMs,
        hoverAglM: wait.hoverAglM,
        position: wait.position,
      },
      actions: [],
    });
  }

  return out;
}
