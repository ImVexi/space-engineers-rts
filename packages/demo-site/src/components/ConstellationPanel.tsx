import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { DemoState, Planet } from '../types';
import type { DesignerOption, DesignerPreview } from '../lib/designer';
import { formatKm } from '../lib/designer';
import {
  ALTITUDE_MODES,
  CONSTELLATION_PATTERNS,
  CONSTELLATION_WHY,
  COVER_TARGETS,
  MAX_CONSTELLATION_COUNT,
  MAX_MEMBERS_PER_EXECUTE,
  MIN_CONSTELLATION_COUNT,
  type ConstellationForm,
  assignToSlots,
  buildConstellationPlan,
  constellationReducer,
  constellationSentence,
  DEFAULT_CONSTELLATION,
  estimateCost,
  ghostSlots,
  groundReachM,
  matchHullId,
  patternLabel,
} from '../lib/constellation';
import {
  alternativeLines,
  applyGuard,
  countLabel,
  decidePlannedShips,
  formatCoverage,
  memberEstimatesFromMoves,
  slotLines,
} from '../lib/constellationView';
import { liveCoverage, previewCoverage, type CoverageCell } from '../lib/coverage';
import type { OptimisePlan } from '../lib/optimise';
import type { ShipGroup } from '../lib/groups';

interface ConstellationPanelProps {
  state: DemoState;
  group: ShipGroup;
  hullIds: string[];
  /** a red coverage cell the owner asked to fix */
  fix: { planet: string; latDeg: number; lonDeg: number; altitudeM: number | null } | null;
  names: Record<string, string>;
  onClose: () => void;
  onPreview: (preview: DesignerPreview | null) => void;
  /** the proposed layout's heatmap, k-aware (null clears it) */
  onPreviewCells?: (cells: { planet: string; cells: CoverageCell[]; k: 1 | 2 } | null) => void;
  onRefresh: () => void;
  onToast: (kind: 'ok' | 'err' | 'info', text: string, hint?: string | null) => void;
}

function messageOf(err: unknown): string {
  return err instanceof ApiError ? `${err.message}${err.hint ? ` — ${err.hint}` : ''}` : err instanceof Error ? err.message : 'request failed';
}

function clonePlanet(planet: Planet) {
  return { center: planet.center, surfaceRadiusM: planet.surfaceRadiusM > 0 ? planet.surfaceRadiusM : planet.maxHillRadiusM };
}

/** How many relays one pattern slot reaches, from the backend's own readout. */
function slotRadiusM(option: DesignerOption | null, fallbackM: number): number {
  const radii = option?.slotAltitudes?.map((slot) => slot.radioRadiusM).filter((value) => value > 0) ?? [];
  return radii.length ? Math.max(...radii) : fallbackM;
}

export function ConstellationPanel({
  state,
  group,
  hullIds,
  fix,
  names,
  onClose,
  onPreview,
  onPreviewCells,
  onRefresh,
  onToast,
}: ConstellationPanelProps) {
  const planets = state.planets;
  const defaultPlanet = fix?.planet ?? (planets.find((p) => p.name === 'EarthLike') ?? planets[0])?.name ?? '';
  const [form, dispatch] = useReducer(constellationReducer, {
    ...DEFAULT_CONSTELLATION,
    planet: defaultPlanet,
    hullId: matchHullId(group.members, hullIds) ?? hullIds[0] ?? '',
  } as ConstellationForm);
  const [plan, setPlan] = useState<{ sig: string; option: DesignerOption } | null>(null);
  const [optimise, setOptimise] = useState<{ sig: string; plan: OptimisePlan } | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [relayOnly, setRelayOnly] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [mission, setMission] = useState<{ id: string | null; members: string[]; coverageAtApply: number | null; note: string | null } | null>(null);
  const [cells, setCells] = useState<{ planet: string; cells: CoverageCell[] } | null>(null);
  const [stopArm, setStopArm] = useState(false);
  const requestSeq = useRef(0);

  const planet = planets.find((p) => p.name === form.planet || p.id === form.planet) ?? planets[0] ?? null;
  const surfaceRadiusM = planet ? (planet.surfaceRadiusM > 0 ? planet.surfaceRadiusM : planet.maxHillRadiusM) : 0;
  const members = useMemo(
    () => group.members.map((id) => state.nodes.find((n) => n.id === id)).filter((n): n is DemoState['nodes'][number] => Boolean(n)),
    [group.members, state.nodes],
  );
  const memberIds = useMemo(() => members.map((m) => m.id), [members]);
  const memberIdKey = memberIds.join(',');
  const sig = useMemo(
    () =>
      JSON.stringify([
        form.planet,
        form.goal,
        form.target,
        form.targetRadiusM,
        form.count,
        form.altitudeMode,
        form.altitudeM,
        form.redundancy,
        form.pattern,
        form.hullId,
        form.spacingM,
        form.inclinationDeg,
      ]),
    [form],
  );

  // Debounced planner call. Cover goal: the coverage-first solve; manual
  // shape: the pattern planner. The optimiser runs alongside so Apply moves
  // exactly the ships the backend assigns (T51.9a).
  useEffect(() => {
    if (!planet) return;
    const { body, error } = buildConstellationPlan(form);
    if (!body) {
      setPlanErr(error);
      setPlan(null);
      setOptimise(null);
      return;
    }
    const seq = ++requestSeq.current;
    setPlanning(true);
    const timer = window.setTimeout(() => {
      const optimiseBody = {
        planet: planet.name,
        target:
          form.target === 'whole'
            ? ('whole' as const)
            : form.target === 'hemisphere'
              ? ('hemisphere' as const)
              : { kind: 'radius' as const, radiusM: form.targetRadiusM, center: { latDeg: 0, lonDeg: 0 } },
        k: form.redundancy === 2 ? (2 as const) : (1 as const),
        cellDeg: 10,
        maxMoves: null,
        includeGridIds: memberIds.length ? memberIds : undefined,
        altitudeMode: form.altitudeMode,
      };
      api
        .designerPlan(body)
        .then(async (res) => {
          if (seq !== requestSeq.current) return;
          const option = res.options.find((o) => o.feasible) ?? res.options[0] ?? null;
          if (!option) {
            setPlan(null);
            setPlanErr('The planner returned no option for these values.');
            return;
          }
          setPlan({ sig, option });
          setPlanErr(option.feasible ? null : option.reasons[0] ?? 'Planner marked this option infeasible.');
          try {
            const best = await api.optimise(optimiseBody);
            if (seq === requestSeq.current) setOptimise({ sig, plan: best });
          } catch {
            if (seq === requestSeq.current) setOptimise(null);
          }
        })
        .catch((err) => {
          if (seq !== requestSeq.current) return;
          setPlan(null);
          setOptimise(null);
          setPlanErr(messageOf(err));
        })
        .finally(() => {
          if (seq === requestSeq.current) setPlanning(false);
        });
    }, 450);
    return () => window.clearTimeout(timer);
    // sig covers every field the request depends on; memberIdKey the pool
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, memberIdKey]);

  const currentOption = plan && plan.sig === sig ? plan.option : null;
  const currentOptimise = optimise && optimise.sig === sig ? optimise.plan : null;

  const slots = useMemo(() => {
    if (!planet) return [];
    if (currentOption && currentOption.positions.length > 0) {
      return currentOption.positions.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    }
    return ghostSlots(clonePlanet(planet), form);
  }, [planet, currentOption, form]);

  const assignments = useMemo(
    () => assignToSlots(members.map((m) => ({ id: m.id, position: m.position })), slots),
    [members, slots],
  );

  // ---- T51.9a: the real planned count and which ships move -----------------
  const planned = useMemo(
    () => decidePlannedShips({ members: members.map((m) => ({ id: m.id })), optimise: currentOptimise, option: currentOption, names }),
    [members, currentOptimise, currentOption, names],
  );

  // ---- T51.9c/d: per-member cost next to the coverage gain ------------------
  const cost = useMemo(() => {
    const estimates = currentOptimise
      ? memberEstimatesFromMoves(currentOptimise.moves, names)
      : planned.ships.map((ship) => {
          const assignment = assignments.find((a) => a.gridId === ship.gridId);
          const distanceM = ship.distanceM ?? assignment?.distanceM ?? 0;
          return {
            id: ship.gridId,
            name: ship.name,
            distanceM,
            etaS: distanceM / 100,
            h2L: null,
            batteryMWh: null,
            altitudeChangeM: 0,
            reason: 'pattern fallback: no optimiser estimate',
          };
        });
    return estimateCost(estimates, {
      gainPct: currentOptimise ? currentOptimise.gainPct : null,
      fromPct: currentOptimise ? currentOptimise.coverageNow.pct : null,
      toPct: currentOptimise ? currentOptimise.coverageAfter.pct : null,
    });
  }, [currentOptimise, planned.ships, assignments, names]);

  // ---- T51.3: every coverage figure carries its provenance ------------------
  const coverage = currentOptimise
    ? {
        before: { pct: currentOptimise.coverageNow.pct, label: 'SIMULATED' as const, terrainNote: currentOptimise.coverageNow.terrain === 'unavailable' ? `terrain unavailable${currentOptimise.coverageNow.terrainReason ? ` (${currentOptimise.coverageNow.terrainReason})` : ''}` : currentOptimise.coverageNow.terrain === 'corrected' ? 'terrain-corrected' : null },
        after: { pct: currentOptimise.coverageAfter.pct, label: 'SIMULATED' as const, terrainNote: currentOptimise.coverageAfter.terrain === 'unavailable' ? `terrain unavailable${currentOptimise.coverageAfter.terrainReason ? ` (${currentOptimise.coverageAfter.terrainReason})` : ''}` : currentOptimise.coverageAfter.terrain === 'corrected' ? 'terrain-corrected' : null },
      }
    : null;
  const planCoverage = currentOption
    ? { pct: currentOption.coveragePct ?? 0, label: 'SIMULATED' as const, terrainNote: currentOption.terrain === 'unavailable' ? 'terrain unavailable' : currentOption.terrain === 'corrected' ? 'terrain-corrected' : null }
    : null;
  const displayCoverage = coverage ? coverage.after : planCoverage;

  // ---- preview: ghost slots with their own radii, heatmap k-aware -----------
  const preview = useMemo<DesignerPreview | null>(() => {
    if (slots.length === 0) return null;
    return { slots: slots.map((pos, i) => ({ id: `c${i + 1}`, pos })), links: [] };
  }, [slots]);
  const previewSig = useMemo(() => preview?.slots.map((s) => `${s.pos.x.toFixed(1)},${s.pos.y.toFixed(1)},${s.pos.z.toFixed(1)}`).join('|') ?? '', [preview]);
  useEffect(() => {
    onPreview(preview);
    return () => onPreview(null);
    // previewSig captures the geometry; the object identity is rebuilt each poll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSig]);

  const previewNodes = useMemo(() => {
    const k = form.redundancy === 2 ? 2 : 1;
    const radio = slotRadiusM(currentOption, members[0]?.capability?.radioRadiusM ?? 50_000);
    void k;
    return slots.map((pos, index) => {
      const readout = currentOption?.slotAltitudes?.[index];
      return {
        id: `c${index + 1}`,
        position: pos,
        altitudeM: readout?.altitudeM ?? form.altitudeM,
        radioRangeM: readout?.radioRadiusM ?? radio,
        groundRadiusM: readout?.groundRadiusM,
      };
    });
  }, [slots, currentOption, form.redundancy, form.altitudeM, members]);

  const previewCells = useMemo(() => {
    if (!planet || previewNodes.length === 0) return null;
    const grid = cells?.planet === planet.name ? cells.cells : null;
    if (!grid) return null;
    return previewCoverage(grid, previewNodes, planet.center, surfaceRadiusM);
  }, [planet, previewNodes, cells, surfaceRadiusM]);

  const previewCellKey = useMemo(
    () => (previewCells ? `${planet?.name ?? ''}:${form.redundancy}:${previewCells.pct}:${previewCells.pctK2}` : ''),
    [previewCells, planet?.name, form.redundancy],
  );
  const previewCellsSig = previewCellKey;
  useEffect(() => {
    if (!planet || !previewCells) {
      onPreviewCells?.({ planet: planet?.name ?? '', cells: [], k: form.redundancy === 2 ? 2 : 1 });
      return;
    }
    onPreviewCells!({ planet: planet.name, cells: previewCells.cells, k: form.redundancy === 2 ? 2 : 1 });
    return () => onPreviewCells!({ planet: planet.name, cells: [], k: form.redundancy === 2 ? 2 : 1 });
    // the payload is identified by planet + k + the two percentages
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewCellsSig]);

  // Cells for any heatmap (preview or live): fetched once per planet.
  useEffect(() => {
    if (!planet) return;
    let cancelled = false;
    api
      .coverage({ planet: planet.name, mode: 'cover-planet', k: 1, cellDeg: 10 })
      .then((res) => {
        if (!cancelled) setCells({ planet: planet.name, cells: res.cells ?? [] });
      })
      .catch(() => {
        if (!cancelled) setCells(null);
      });
    return () => {
      cancelled = true;
    };
    // planet only: the grid is geometry, state polls must not refetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planet?.name]);

  const live = useMemo(() => {
    if (!planet || !cells || cells.planet !== planet.name) return null;
    return liveCoverage(
      cells.cells,
      members.map((m) => ({ id: m.id, position: m.position, radioRangeM: m.capability?.radioRadiusM ?? null })),
      planet.center,
      planet.surfaceRadiusM,
      form.redundancy === 2 ? 2 : 1,
    );
  }, [cells, members, planet, form.redundancy]);

  const execution = mission?.id ? state.executions?.executions.find((e) => e.missionId === mission.id) ?? null : null;
  const droneByGrid = useMemo(() => {
    const map = new Map<string, NonNullable<typeof execution>['drones'][number]>();
    for (const drone of execution?.drones ?? []) {
      if (drone.gridId) map.set(drone.gridId, drone);
    }
    return map;
  }, [execution]);

  // ---- T51.9b: Apply guard with a visible reason ---------------------------
  const guard = applyGuard({
    members: members.length,
    planet: Boolean(planet),
    hull: Boolean(form.hullId),
    overLimit: members.length > MAX_MEMBERS_PER_EXECUTE,
    planning,
    planError: planErr ?? (currentOption && currentOption.feasible === false ? 'Planner marked this option infeasible.' : null),
    coveragePct: displayCoverage ? displayCoverage.pct : null,
    manualAltitudeM: form.altitudeMode === 'manual' ? form.altitudeM : null,
    radioRangeM: members[0]?.capability?.radioRadiusM ?? null,
    surfaceRadiusM: planet ? surfaceRadiusM : null,
    relayOnly,
  });

  const apply = async () => {
    if (!planet || members.length === 0 || guard.disabled) return;
    const ships = planned.ships.slice(0, MAX_MEMBERS_PER_EXECUTE);
    if (ships.length === 0) {
      onToast('info', 'Nothing to move.', 'The plan needs no ships from this group.');
      return;
    }
    setApplying(true);
    try {
      const { body, error } = buildConstellationPlan(form);
      if (!body) throw new Error(error ?? 'plan is not ready');
      // Re-plan right before execute: the backend executes the LAST stored plan.
      const plannedRes = await api.designerPlan(body);
      const option = plannedRes.options.find((o) => o.feasible) ?? plannedRes.options[0] ?? null;
      if (!option) throw new Error('The planner returned no option for these values.');
      const res = await api.designerExecute({
        optionId: option.id,
        launch: 'orbital',
        useGridIds: ships.map((ship) => ship.gridId),
        maxActive: Math.min(10, state.executions?.maxActiveStandIns ?? 5),
      });
      const id = res.missionId ?? res.mission?.id ?? null;
      setMission({
        id,
        members: ships.map((ship) => ship.gridId),
        coverageAtApply: live?.pct ?? null,
        note: res.execution?.note ?? res.note ?? res.execution?.detail ?? null,
      });
      onToast(
        'ok',
        id ? `Constellation mission ${id} queued.` : 'Constellation mission queued.',
        `${ships.length} ship(s) moving · ${planned.staying.length} staying · ${form.goal === 'cover' ? `${COVER_TARGETS.find((t) => t.value === form.target)?.label.toLowerCase() ?? form.target}` : patternLabel(form.pattern)}`,
      );
      onRefresh();
    } catch (err) {
      onToast('err', 'Apply failed.', messageOf(err));
    } finally {
      setApplying(false);
    }
  };

  const stop = async () => {
    if (!stopArm) {
      setStopArm(true);
      window.setTimeout(() => setStopArm(false), 4000);
      return;
    }
    setStopArm(false);
    try {
      await api.groupStop(group.id, group.members);
      onToast('ok', `Stop sent to ${group.name}.`, 'Only this group’s members were addressed.');
      onRefresh();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
        onToast('info', 'Scoped stop is coming soon.', 'Nothing was sent. The global STOP sits under the map.');
        return;
      }
      onToast('err', 'Group stop failed.', messageOf(err));
    }
  };

  const planetLabel = planet?.name ?? (form.planet || 'the planet');
  const countNeeded = currentOption?.countNeeded ?? currentOption?.goal?.countNeeded ?? null;
  const radioM = members[0]?.capability?.radioRadiusM ?? null;
  const manualReachM = form.altitudeMode === 'manual' && radioM !== null && planet ? groundReachM(surfaceRadiusM, form.altitudeM, radioM) : null;
  const alternatives = alternativeLines(currentOption?.alternatives ?? currentOption?.goal?.alternatives);
  const slotsReadout = slotLines(currentOption);
  const surplus = currentOption?.goal?.requestedCount && countNeeded !== null && currentOption.goal.requestedCount > countNeeded
    ? currentOption.goal.requestedCount - countNeeded
    : null;

  return (
    <aside className="flow-panel constellation" data-testid="constellation-panel" aria-label="Constellation control">
      <header className="flow-head">
        <div>
          <h2>Constellation · {group.name}</h2>
          <p className="flow-sub" data-testid="constellation-members">
            {members.length} live member(s) · applies to this group only
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close constellation panel" data-testid="constellation-close">
          ✕
        </button>
      </header>

      <div className="flow-body">
        <p className="constellation-sentence" data-testid="constellation-sentence" title={CONSTELLATION_WHY}>
          {constellationSentence(form, planetLabel, countNeeded)}
        </p>

        {/* Six controls at most: goal, target, count, altitude mode, redundancy, relay-only. */}
        <div className="constellation-grid">
          <label>
            Goal
            <select
              value={form.goal}
              data-testid="constellation-goal"
              onChange={(e) => dispatch({ type: 'patch', patch: { goal: e.target.value as ConstellationForm['goal'] } })}
            >
              <option value="cover">Cover the planet</option>
              <option value="pattern">Manual shape</option>
            </select>
          </label>
          {form.goal === 'cover' && (
            <label>
              Target
              <select
                value={form.target}
                data-testid="constellation-target"
                title={COVER_TARGETS.find((t) => t.value === form.target)?.hint ?? ''}
                onChange={(e) => dispatch({ type: 'patch', patch: { target: e.target.value as ConstellationForm['target'] } })}
              >
                {COVER_TARGETS.map((target) => (
                  <option key={target.value} value={target.value}>
                    {target.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label title="Auto lets the solver choose how many ships the goal needs.">
            Count · {countLabel(form.count, countNeeded)}
            <span className="row">
              <input
                type="number"
                min={MIN_CONSTELLATION_COUNT}
                max={MAX_CONSTELLATION_COUNT}
                value={form.count ?? ''}
                placeholder={countNeeded !== null ? `Auto (${countNeeded})` : 'Auto'}
                data-testid="constellation-count"
                onChange={(e) =>
                  dispatch({ type: 'patch', patch: { count: e.target.value === '' ? null : Number(e.target.value) } })
                }
              />
              <button type="button" data-testid="constellation-count-auto" onClick={() => dispatch({ type: 'patch', patch: { count: null } })}>
                Auto
              </button>
            </span>
          </label>
          <label>
            Altitude
            <select
              value={form.altitudeMode}
              data-testid="constellation-altitude-mode"
              title={ALTITUDE_MODES.find((m) => m.value === form.altitudeMode)?.hint ?? ''}
              onChange={(e) => dispatch({ type: 'patch', patch: { altitudeMode: e.target.value as ConstellationForm['altitudeMode'] } })}
            >
              {ALTITUDE_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Redundancy
            <select
              value={String(form.redundancy)}
              data-testid="constellation-redundancy"
              title="Cell coverage: two relays over every cell, and two disjoint paths home."
              onChange={(e) => dispatch({ type: 'patch', patch: { redundancy: Number(e.target.value) as 1 | 2 } })}
            >
              <option value="1">1 relay / cell</option>
              <option value="2">2 relays / cell</option>
            </select>
          </label>
          <label className="checkbox" title="Allow a plan with no ground coverage, e.g. a pure link relay.">
            <input
              type="checkbox"
              checked={relayOnly}
              data-testid="constellation-relay-only"
              onChange={(e) => setRelayOnly(e.target.checked)}
            />
            Relay-only (no ground)
          </label>
        </div>

        {form.altitudeMode === 'manual' && (
          <label>
            Manual altitude · {formatKm(form.altitudeM)}
            <input
              type="number"
              min={100}
              max={500_000}
              step={500}
              value={form.altitudeM}
              data-testid="constellation-altitude"
              onChange={(e) => dispatch({ type: 'patch', patch: { altitudeM: Number(e.target.value) } })}
            />
            <span className="muted small" data-testid="constellation-reach">
              {manualReachM === null
                ? 'Pick a member hull to see the ground reach.'
                : manualReachM < 1
                  ? `Outside the radio's ground reach: 0 km of ground from here.`
                  : `Ground reach ${(manualReachM / 1000).toFixed(1)} km · ${((manualReachM / (surfaceRadiusM * Math.PI * 2)) * 100).toFixed(1)}% of the rim`}
            </span>
          </label>
        )}

        <details className="flow-advanced" data-testid="constellation-advanced" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
          <summary>Advanced</summary>
          <div className="inline-fields">
            {form.goal === 'pattern' && (
              <>
                <label>
                  Pattern
                  <select
                    value={form.pattern}
                    data-testid="constellation-pattern"
                    title={CONSTELLATION_PATTERNS.find((p) => p.value === form.pattern)?.hint ?? ''}
                    onChange={(e) => dispatch({ type: 'patch', patch: { pattern: e.target.value as ConstellationForm['pattern'] } })}
                  >
                    {CONSTELLATION_PATTERNS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Ring inclination · {form.inclinationDeg}°
                  <input
                    type="range"
                    min={0}
                    max={89}
                    value={form.inclinationDeg}
                    data-testid="constellation-inclination"
                    onChange={(e) => dispatch({ type: 'patch', patch: { inclinationDeg: Number(e.target.value) } })}
                  />
                </label>
              </>
            )}
            {form.goal === 'cover' && form.target === 'radius' && (
              <label>
                Radius · {formatKm(form.targetRadiusM)}
                <input
                  type="number"
                  min={1_000}
                  max={2_000_000}
                  step={1_000}
                  value={form.targetRadiusM}
                  data-testid="constellation-radius"
                  onChange={(e) => dispatch({ type: 'patch', patch: { targetRadiusM: Number(e.target.value) } })}
                />
              </label>
            )}
            <label>
              Spacing · {formatKm(form.spacingM)}
              <input
                type="number"
                min={1000}
                max={500_000}
                step={1000}
                value={form.spacingM}
                data-testid="constellation-spacing"
                onChange={(e) => dispatch({ type: 'patch', patch: { spacingM: Number(e.target.value) } })}
              />
            </label>
            <label className="grow">
              Hull model
              <select
                value={form.hullId}
                data-testid="constellation-hull"
                onChange={(e) => dispatch({ type: 'patch', patch: { hullId: e.target.value } })}
              >
                {hullIds.length === 0 && <option value="">no hull profiles</option>}
                {hullIds.map((id) => (
                  <option key={id} value={id}>
                    {id.replace('tagged:grid:', 'member ').replace('prefab:', '')}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted small">
            Ring / inclined rings / arc are manual shapes for when you want a specific formation; the default is coverage-first.
          </p>
        </details>

        {/* Count truth: auto number, plan size, surplus. */}
        <p className="muted small" data-testid="constellation-plan-count">
          {countNeeded !== null
            ? `Needs ${countNeeded} relay(s) · this plan uses ${currentOption?.countUsed ?? currentOption?.positions.length ?? '—'}`
            : 'Auto count: planning…'}
          {surplus !== null && surplus > 0 ? ` · ${surplus} over the need stays put` : ''}
        </p>

        {/* Coverage: always labelled, terrain gaps stated. */}
        <p data-testid="constellation-coverage">
          {currentOptimise
            ? `Preview coverage ${formatCoverage(coverage!.before)} → ${formatCoverage(coverage!.after)} · gain ${currentOptimise.gainPct >= 0 ? '+' : ''}${currentOptimise.gainPct.toFixed(1)} pts`
            : currentOption
              ? `Planner coverage ${formatCoverage(planCoverage)}`
              : 'Coverage: SIMULATED · planning…'}
        </p>

        <p className="constellation-cost" data-testid="constellation-cost" title="Per-member planner estimates (endurance model); the executor picks the real speed.">
          {cost.text}
        </p>
        <p className="muted small" data-testid="constellation-plan-state">
          {planning ? 'Planning exact slots…' : currentOption ? 'Planner slots ready' : 'Instant estimate'}
          {planErr ? ` · ${planErr}` : ''}
        </p>

        {slotsReadout.length > 0 && (
          <ul className="muted small constellation-slots" data-testid="constellation-slot-readout">
            {slotsReadout.slice(0, 6).map((line) => (
              <li key={line}>{line}</li>
            ))}
            {slotsReadout.length > 6 && <li>… {slotsReadout.length - 6} more slot(s)</li>}
          </ul>
        )}

        {alternatives.length > 0 && (
          <ul className="muted small" data-testid="constellation-alternatives">
            {alternatives.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}

        <p className="muted small" data-testid="constellation-apply-plan">
          Apply moves {planned.count} ship(s)
          {planned.staying.length > 0 ? ` · ${planned.staying.length} staying: ${planned.staying.slice(0, 5).map((s) => s.name).join(', ')}${planned.staying.length > 5 ? '…' : ''}` : ''}
        </p>
        {guard.disabled && guard.reason && (
          <p className="muted small" data-testid="constellation-apply-reason" role="status">
            {guard.reason}
          </p>
        )}

        {mission && (
          <section className="constellation-progress" data-testid="constellation-progress" data-mission={mission.id ?? ''}>
            <div className="constellation-progress-head">
              <strong>Live progress</strong>
              <span className="muted small">
                {live ? `Coverage ${live.pct}%` : 'Coverage loading…'}
                {live && mission.coverageAtApply !== null ? ` (was ${mission.coverageAtApply}% at apply)` : ''}
              </span>
            </div>
            <ul>
              {mission.members.map((id) => {
                const drone = droneByGrid.get(id);
                const assignment = assignments.find((a) => a.gridId === id);
                const stateLabel = drone?.state ?? 'queued';
                const distance = drone?.remainingM ?? (assignment ? assignment.distanceM : null);
                return (
                  <li key={id} data-testid="constellation-ship-row" data-state={stateLabel}>
                    <span className="row-name">{names[id] ?? id.replace(/^grid:/, '').slice(0, 12)}</span>
                    <span className={`state-pill ${stateLabel.replace('_', '-')}`}>{stateLabel.replace('_', '-')}</span>
                    <span className="num">{distance === null ? '—' : `${formatKm(distance)} to slot`}</span>
                  </li>
                );
              })}
            </ul>
            {mission.note && <p className="muted small">{mission.note}</p>}
          </section>
        )}
      </div>

      <footer className="flow-foot">
        <button
          type="button"
          className={stopArm ? 'danger armed' : 'danger'}
          data-testid="constellation-stop"
          onClick={() => void stop()}
          title="Send stop only to this group’s members"
        >
          {stopArm ? 'Confirm group STOP' : 'Stop group'}
        </button>
        <div className="row">
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="primary"
            data-testid="constellation-apply"
            disabled={applying || guard.disabled}
            title={guard.reason ?? 'Move exactly the planned ships into the planned slots'}
            onClick={() => void apply()}
          >
            {applying ? 'Applying…' : `Apply to ${planned.count} ships`}
          </button>
        </div>
      </footer>
    </aside>
  );
}
