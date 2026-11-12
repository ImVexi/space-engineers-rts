import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { DemoNode, NamingGrid, Planet, ProvisionGrid } from '../types';
import type { DesignerOption, DesignerPlanResponse, DesignerPreview, DesignerSettingsResponse, Hull, LaunchMode, Redundancy } from '../lib/designer';
import { formatDurationS, formatKm, optionPreview, shortRedundancyLabel, sortHulls } from '../lib/designer';
import { LOW_ORBIT_KM, ZERO_G_ORBIT_KM, orbitCards } from '../lib/flows';

export interface LaunchFlowProps {
  nodes: DemoNode[];
  naming: NamingGrid[];
  planets: Planet[];
  bases: ProvisionGrid[];
  initialIds: string[];
  onClose: () => void;
  onLaunched: (text: string) => void;
  onComingSoon: () => void;
  onPreview: (preview: DesignerPreview | null) => void;
}

type Step = 1 | 2 | 3 | 4;
type OrbitChoice = 'low' | 'zero' | 'custom';

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'unexpected error';
}

/**
 * Four plain steps in ONE panel: satellites -> ground station -> orbit ->
 * review. Nothing is hidden behind a second menu. Pattern is 'auto' unless the
 * owner opens Advanced.
 */
export function LaunchFlow({ nodes, naming, planets, bases, initialIds, onClose, onLaunched, onComingSoon, onPreview }: LaunchFlowProps) {
  const [step, setStep] = useState<Step>(1);
  const [hulls, setHulls] = useState<Hull[]>([]);
  const [settings, setSettings] = useState<DesignerSettingsResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialIds));
  const [station, setStation] = useState<string>(bases[0]?.name ?? naming.find((n) => n.kind === 'BASE')?.name ?? 'BASE-01');
  const [orbit, setOrbit] = useState<OrbitChoice>('zero');
  const [customKm, setCustomKm] = useState(50);
  const [redundancy, setRedundancy] = useState<Redundancy>(1);
  const [margin, setMargin] = useState(0.9);
  const [maxActive, setMaxActive] = useState(5);
  const [simMin, setSimMin] = useState(0.95);
  const [plan, setPlan] = useState<DesignerPlanResponse | null>(null);
  const [option, setOption] = useState<DesignerOption | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [comingSoon, setComingSoon] = useState(false);

  const namedById = useMemo(() => new Map(naming.map((n) => [n.gridId, n])), [naming]);
  const hullById = useMemo(() => new Map(hulls.map((h) => [h.id, h])), [hulls]);

  // Candidate satellites: named SAT grids that have live telemetry first, then
  // any live owner grid so a freshly pasted grid is still launchable.
  const candidates = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const named = naming
      .filter((n) => n.kind === 'SAT')
      .map((n) => byId.get(n.gridId))
      .filter((n): n is DemoNode => Boolean(n));
    const seen = new Set(named.map((n) => n.id));
    const others = nodes.filter(
      (n) => !seen.has(n.id) && n.source === 'GAME' && (n.telemetry?.ageMs ?? Infinity) < 120_000 && !n.controlSource,
    );
    return [...named, ...others].map((n) => ({
      id: n.id,
      name: namedById.get(n.id)?.name ?? n.name,
      prefab: n.prefab,
      hull: hullById.get(`tagged:${n.id}`) ?? null,
      live: n.telemetry ?? null,
    }));
  }, [nodes, naming, namedById, hullById]);

  useEffect(() => {
    let cancelled = false;
    api
      .designerHulls()
      .then((res) => {
        if (!cancelled) setHulls(sortHulls(res.hulls));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setComingSoon(true);
      });
    api
      .designerSettings()
      .then((res) => {
        if (cancelled) return;
        setSettings(res);
        setMaxActive(res.maxActive);
        setSimMin(res.simSpeedMin);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // No preselection and no explicit choice: start with every named satellite.
  useEffect(() => {
    if (selected.size === 0 && candidates.length > 0) setSelected(new Set(candidates.map((c) => c.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.length]);

  const selectedCandidates = candidates.filter((c) => selected.has(c.id));
  const altitudeM = orbit === 'zero' ? ZERO_G_ORBIT_KM * 1000 : orbit === 'low' ? LOW_ORBIT_KM * 1000 : Math.max(1, customKm) * 1000;
  const planetName = orbit === 'zero' || orbit === 'low' ? 'EarthLike' : planets.find((p) => p.name === 'EarthLike')?.name ?? planets[0]?.name ?? 'EarthLike';
  const hullId = selectedCandidates.length
    ? hullById.has(`tagged:${selectedCandidates[0]!.id}`)
      ? `tagged:${selectedCandidates[0]!.id}`
      : hullById.has(`prefab:${selectedCandidates[0]!.prefab}`)
        ? `prefab:${selectedCandidates[0]!.prefab}`
        : null
    : null;

  const paramKey = `${planetName}|${altitudeM}|${selectedCandidates.length}|${hullId}|${redundancy}|${margin}|${station}`;

  // Plan only on the review step: one POST /designer/plan, no mission.
  useEffect(() => {
    if (step !== 4 || !hullId || selectedCandidates.length === 0) return;
    let cancelled = false;
    setPlanning(true);
    setError(null);
    api
      .designerPlan({
        mode: 'constellation',
        planet: planetName,
        pattern: 'auto',
        altitudeM,
        count: Math.max(2, selectedCandidates.length),
        hullId,
        rangeMargin: margin,
        redundancy,
      })
      .then((res) => {
        if (cancelled) return;
        setPlan(res);
        const feasible = res.options.find((o) => o.feasible) ?? res.options[0] ?? null;
        setOption(feasible);
        onPreview(optionPreview(feasible));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setComingSoon(true);
          onComingSoon();
        } else setError(err instanceof ApiError ? `${err.message}${err.hint ? ` — ${err.hint}` : ''}` : errorText(err));
      })
      .finally(() => {
        if (!cancelled) setPlanning(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, paramKey]);

  const launch = async () => {
    if (!option) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.designerExecute({
        optionId: option.id,
        launch: 'surface' as LaunchMode,
        useGridIds: selectedCandidates.map((c) => c.id),
        maxActive,
        fillWithClones: false,
      });
      const id = res.missionId ?? res.mission?.id ?? res.planId ?? 'mission';
      onLaunched(`Launch mission ${id} queued for ${selectedCandidates.length} satellites.`);
      onPreview(null);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.hint ? ` — ${err.hint}` : ''}` : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const linkCount = option?.links.filter((l) => l.kind === 'laser').length ?? 0;
  const radioCount = option?.links.filter((l) => l.kind === 'radio').length ?? 0;
  const hold = option?.endurance?.holdEnduranceText ?? null;
  const cards = orbitCards(
    orbit === 'low' ? formatDurationS(option?.endurance?.holdEnduranceS ?? null) : null,
    orbit === 'zero' ? formatDurationS(option?.endurance?.holdEnduranceS ?? null) : null,
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="flow-panel wide" data-testid="launch-flow" aria-label="Launch satellites">
      <header className="flow-head">
        <div>
          <h2>Launch satellites</h2>
          <p className="flow-sub">Automatic by default: the planner picks the orbit, pattern and links.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close launch panel" data-testid="launch-close">
          ✕
        </button>
      </header>

      <ol className="steps" data-testid="launch-steps">
        {(['Satellites', 'Ground station', 'Orbit', 'Review'] as const).map((label, i) => (
          <li key={label} className={step === i + 1 ? 'active' : step > i + 1 ? 'done' : ''}>
            <button type="button" onClick={() => setStep((i + 1) as Step)} disabled={i + 1 > 1 && selected.size === 0}>
              <span>{i + 1}</span>
              {label}
            </button>
          </li>
        ))}
      </ol>

      <div className="flow-body">
        {step === 1 && (
          <div data-testid="launch-step-1">
            <div className="row space">
              <p className="muted small">
                {selected.size} of {candidates.length} satellites picked. H2 and battery come from live telemetry.
              </p>
              <label className="check">
                <input
                  type="checkbox"
                  data-testid="launch-all-sats"
                  checked={selected.size === candidates.length && candidates.length > 0}
                  onChange={(e) => setSelected(e.target.checked ? new Set(candidates.map((c) => c.id)) : new Set())}
                />
                All my satellites
              </label>
            </div>
            {candidates.length === 0 && <p className="muted">No satellites found. Tag a grid [HERMES-TEST] and reload.</p>}
            <ul className="sat-list">
              {candidates.map((sat) => {
                const h2 = sat.hull?.live?.h2Pct ?? null;
                const battery = sat.hull?.live?.batteryPct ?? null;
                const twr = sat.hull?.twrAtSurface ?? null;
                return (
                  <li key={sat.id}>
                    <label className="sat-row">
                      <input
                        type="checkbox"
                        checked={selected.has(sat.id)}
                        onChange={() => toggle(sat.id)}
                        data-testid={`launch-sat-${sat.id}`}
                      />
                      <span className="sat-name">{sat.name}</span>
                      <span className={`sat-stat${h2 !== null && h2 < 20 ? ' bad' : ''}`}>H2 {h2 === null ? '—' : `${Math.round(h2)}%`}</span>
                      <span className="sat-stat">Batt {battery === null ? '—' : `${Math.round(battery)}%`}</span>
                      <span className="sat-stat">TWR {twr === null ? '—' : twr < 0 ? 'n/a' : twr.toFixed(1)}</span>
                      <span className="sat-stat muted">{sat.hull?.radioRangeM ? formatKm(sat.hull.radioRangeM) : 'no radio'}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {hullId === null && hulls.length > 0 && (
              <p className="error small">The selected grids are not in the hull catalogue; the planner needs a profiled hull.</p>
            )}
            {comingSoon && (
              <p className="warn small" data-testid="launch-coming-soon">
                The planner route is not deployed on this backend yet — this flow is coming soon.
              </p>
            )}
          </div>
        )}

        {step === 2 && (
          <div data-testid="launch-step-2">
            <p className="muted small">The satellites keep a link down to this station. BASE-01 is the home base.</p>
            <ul className="station-list">
              {(bases.length > 0
                ? bases.map((b) => ({ id: b.gridId, name: namedById.get(b.gridId)?.name ?? b.name, radio: b.radio?.radiusM ?? null }))
                : naming
                    .filter((n) => n.kind === 'BASE')
                    .map((b) => ({ id: b.gridId, name: b.name, radio: null as number | null }))
              ).map((base) => (
                <li key={base.id}>
                  <label className={`station-row${station === base.name ? ' active' : ''}`}>
                    <input
                      type="radio"
                      name="station"
                      checked={station === base.name}
                      onChange={() => setStation(base.name)}
                      data-testid={`launch-base-${base.name}`}
                    />
                    <span className="station-name">{base.name}</span>
                    <span className="muted small">{base.radio ? `radio ${formatKm(base.radio)}` : 'control station'}</span>
                  </label>
                </li>
              ))}
            </ul>
            {bases.length === 0 && naming.every((n) => n.kind !== 'BASE') && (
              <p className="muted">No base reported yet — the plan will use BASE-01 by name.</p>
            )}
          </div>
        )}

        {step === 3 && (
          <div data-testid="launch-step-3" className="orbit-cards">
            {cards.map((card) => (
              <button
                key={card.id}
                type="button"
                className={`orbit-card${orbit === card.id ? ' active' : ''}`}
                data-testid={`launch-orbit-${card.id}`}
                onClick={() => setOrbit(card.id)}
              >
                <strong>{card.title}</strong>
                <span className="orbit-headline">{card.headline}</span>
                <span className="muted small">{card.detail}</span>
                <span className={`small ${card.id === 'low' ? 'warn' : 'ok'}`}>{card.caution}</span>
              </button>
            ))}
            <div className="orbit-custom">
              <label className="check">
                <input
                  type="radio"
                  name="orbit"
                  checked={orbit === 'custom'}
                  onChange={() => setOrbit('custom')}
                  data-testid="launch-orbit-custom"
                />
                Custom altitude
              </label>
              <div className="inline-fields">
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={customKm}
                  onChange={(e) => {
                    setCustomKm(Number(e.target.value) || 0);
                    setOrbit('custom');
                  }}
                  data-testid="launch-custom-km"
                />
                <span className="muted small">km above EarthLike</span>
              </div>
              <p className="muted small">Below {ZERO_G_ORBIT_KM} km gravity is not fully gone; the planner will still compute the hold.</p>
            </div>
          </div>
        )}

        {step === 4 && (
          <div data-testid="launch-step-4">
            {planning && <p className="muted small" data-testid="launch-planning">Planning the launch…</p>}
            {error && (
              <p className="error" data-testid="launch-error">
                {error}
              </p>
            )}
            {comingSoon && (
              <p className="warn" data-testid="launch-coming-soon">
                The designer plan route is not deployed on this backend yet — this flow is coming soon.
              </p>
            )}
            {option && (
              <div className="plan-summary" data-testid="launch-review">
                <h3>The planner decided</h3>
                <p>{option.summary}</p>
                <dl>
                  <div className="preflight-row">
                    <dt>Orbit</dt>
                    <dd>
                      {option.altitudeM / 1000} km above {planetName} · {shortRedundancyLabel(option.redundancyAchieved)} redundancy
                    </dd>
                  </div>
                  <div className="preflight-row">
                    <dt>Links</dt>
                    <dd>
                      {option.count} slots · {option.spofs.length} single points of failure · {radioCount} radio / {linkCount} laser edges
                    </dd>
                  </div>
                  <div className="preflight-row">
                    <dt>Ground link</dt>
                    <dd>
                      {station}: {option.coveragePct === null ? 'point-to-point chain' : `${Math.round(option.coveragePct)}% surface coverage`} · max gap{' '}
                      {formatKm(option.maxGapM)}
                    </dd>
                  </div>
                  <div className="preflight-row">
                    <dt>Fuel reserve</dt>
                    <dd>
                      {option.endurance
                        ? `${option.endurance.reservePct === null ? 'unknown' : `${option.endurance.reservePct}%`} after ascent · ${option.endurance.holdEnduranceText} hold`
                        : 'endurance model unavailable'}
                    </dd>
                  </div>
                  <div className="preflight-row">
                    <dt>ETA</dt>
                    <dd>{option.endurance?.etaS ? formatDurationS(option.endurance.etaS) : 'from live telemetry'}</dd>
                  </div>
                </dl>
                {hold && <p className="muted small">Hold at this orbit: {hold}.</p>}
                {!option.feasible && (
                  <div className="block-note">
                    <p>{option.reasons[0] ?? 'The planner marked this option infeasible.'}</p>
                    <p className="hint">Fix: try Zero-g orbit, fewer satellites, or a lower range margin under Advanced.</p>
                  </div>
                )}
                {option.endurance?.failureReason && <p className="warn small">{option.endurance.failureReason}</p>}
                {option.reasons.length > 0 && option.feasible && (
                  <ul className="warn-list">
                    {option.reasons.slice(0, 3).map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {plan && plan.options.length > 1 && (
              <div className="option-chips">
                {plan.options.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={option?.id === o.id ? 'active' : ''}
                    onClick={() => {
                      setOption(o);
                      onPreview(optionPreview(o));
                    }}
                  >
                    {o.pattern} · {o.count} sats · {o.feasible ? 'feasible' : 'infeasible'}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <details className="flow-advanced advanced-box">
        <summary>Advanced</summary>
        <div className="inline-fields">
          <label>
            Redundancy
            <select value={String(redundancy)} onChange={(e) => setRedundancy(e.target.value === '2' ? 2 : e.target.value === 'no-spof' ? 'no-spof' : 1)}>
              <option value="1">Single path</option>
              <option value="2">Two paths (k=2)</option>
              <option value="no-spof">No single point of failure</option>
            </select>
          </label>
          <label>
            Range margin {(margin * 100).toFixed(0)}%
            <input type="range" min={0.5} max={1} step={0.01} value={margin} onChange={(e) => setMargin(Number(e.target.value))} />
          </label>
          <label>
            Max active
            <input type="number" min={1} max={10} value={maxActive} onChange={(e) => setMaxActive(Number(e.target.value) || 1)} />
          </label>
          <label>
            Min sim speed
            <input type="number" min={0.5} max={1} step={0.01} value={simMin} onChange={(e) => setSimMin(Number(e.target.value))} />
          </label>
          {settings && <span className="muted small">saved: {settings.simSpeedMin} / max {settings.maxActive}</span>}
        </div>
        <p className="muted small">
          Advanced only changes the inputs; the planner still decides laser vs radio per link and the final pattern.
        </p>
      </details>

      <footer className="flow-foot">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <div className="row">
          {step > 1 && (
            <button type="button" onClick={() => setStep((step - 1) as Step)} data-testid="launch-back">
              Back
            </button>
          )}
          {step < 4 ? (
            <button
              type="button"
              className="primary"
              data-testid="launch-next"
              disabled={step === 1 && selected.size === 0}
              onClick={() => setStep((step + 1) as Step)}
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              className="primary big"
              data-testid="launch-go"
              disabled={busy || !option || comingSoon}
              onClick={() => void launch()}
            >
              {busy ? 'Launching…' : `Launch ${selectedCandidates.length} satellites`}
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
