import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import { api, ApiError } from '../api';
import type { DemoState } from '../types';
import {
  MAX_ALTITUDE_M,
  MIN_ALTITUDE_M,
  type DesignerAction,
  type DesignerExecuteResponse,
  type DesignerForm,
  type DesignerOption,
  type DesignerPlanResponse,
  type DesignerPoint,
  type DesignerPreview,
  type DesignerSettings,
  type Hull,
  type LaunchMode,
  approvalBlock,
  buildPlanRequest,
  coverageLabel,
  formatGpsString,
  formatKm,
  groundLaunchState,
  hullOptionLabel,
  hullSummary,
  optionPreview,
  parseGpsString,
  pointLabel,
  redundancyLabel,
  sortHulls,
} from '../lib/designer';
import { DesignerOptionCards } from './DesignerOptionCards';
import { DesignerSettingsPanel } from './DesignerSettings';
import { DesignerFollowList } from './DesignerFollowList';

export interface DesignerPanelProps {
  state: DemoState;
  form: DesignerForm;
  dispatch: Dispatch<DesignerAction>;
  pickTarget: 'a' | 'b' | null;
  onPickTarget: (target: 'a' | 'b' | null) => void;
  onPreview: (preview: DesignerPreview | null) => void;
  onClose: () => void;
  onRefresh: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof ApiError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : 'request failed';
}

const PATTERNS: { value: DesignerForm['pattern']; label: string }[] = [
  { value: 'ring', label: 'Equatorial ring' },
  { value: 'inclined-rings', label: 'Two inclined rings' },
  { value: 'shell', label: 'Fibonacci shell' },
  { value: 'chain', label: 'Chain' },
  { value: 'auto', label: 'Auto (planner picks)' },
];

function ConnectPoint({
  which,
  point,
  planets,
  dispatch,
  picking,
  onPick,
}: {
  which: 'a' | 'b';
  point: DesignerPoint | null;
  planets: DemoState['planets'];
  dispatch: Dispatch<DesignerAction>;
  picking: boolean;
  onPick: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    const parsed = parseGpsString(text);
    if (!parsed) {
      setError('Not an SE GPS string (GPS:Name:x:y:z: or x:y:z)');
      return;
    }
    setError(null);
    dispatch({ type: 'point', which, point: { gps: parsed.pos } });
  };

  return (
    <div className={`designer-point${picking ? ' picking' : ''}`} data-testid={`designer-point-${which}`}>
      <div className="designer-point-head">
        <span className="designer-point-tag">{which.toUpperCase()}</span>
        <strong className="designer-point-label" data-testid={`designer-point-${which}-label`}>
          {pointLabel(point)}
        </strong>
        <button
          type="button"
          className={picking ? 'primary' : ''}
          onClick={onPick}
          data-testid={`designer-pick-${which}`}
          aria-pressed={picking}
        >
          {picking ? 'Click the map…' : 'Pick on map'}
        </button>
      </div>
      <div className="designer-point-inputs">
        <select
          value={point?.planet ?? ''}
          onChange={(e) => {
            setError(null);
            dispatch({ type: 'point', which, point: e.target.value ? { planet: e.target.value } : null });
          }}
          aria-label={`Point ${which.toUpperCase()} planet`}
          data-testid={`designer-${which}-planet`}
        >
          <option value="">planet…</option>
          {planets.map((planet) => (
            <option key={planet.id} value={planet.name}>
              {planet.name}
            </option>
          ))}
        </select>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply();
          }}
          placeholder="GPS:Name:x:y:z:"
          aria-label={`Point ${which.toUpperCase()} GPS`}
          data-testid={`designer-gps-${which}`}
        />
        <button type="button" onClick={apply} data-testid={`designer-gps-${which}-apply`}>
          Use GPS
        </button>
      </div>
      {error && (
        <p className="error small" data-testid={`designer-gps-${which}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * T6 Admin / Designer panel.
 *
 * Desktop: its own grid column, so it never covers the map. Phone: a bottom
 * sheet (see styles.css). Everything in here talks to /api/demo/designer/*;
 * slot positions and coverage are planner output labelled SIMULATED.
 */
export function DesignerPanel({
  state,
  form,
  dispatch,
  pickTarget,
  onPickTarget,
  onPreview,
  onClose,
  onRefresh,
}: DesignerPanelProps) {
  const [hulls, setHulls] = useState<Hull[]>([]);
  const [hullsError, setHullsError] = useState<string | null>(null);
  const [hullsLoading, setHullsLoading] = useState(true);
  const [plan, setPlan] = useState<DesignerPlanResponse | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<DesignerOption | null>(null);
  const [launch, setLaunch] = useState<LaunchMode>('orbital');
  const [executing, setExecuting] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);
  const [execResult, setExecResult] = useState<DesignerExecuteResponse | null>(null);
  const [missionId, setMissionId] = useState<string | null>(null);
  const [gpsOn, setGpsOn] = useState(false);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  const [settings, setSettings] = useState<DesignerSettings>({
    simSpeedMin: state.executions?.simSpeedMin ?? 0.95,
    maxActive: state.executions?.maxActiveStandIns ?? 5,
    launchReservePct: 15,
  });
  const [savedSettings, setSavedSettings] = useState<DesignerSettings>(settings);
  const [settingsLive, setSettingsLive] = useState<number | null>(null);
  const [settingsThreshold, setSettingsThreshold] = useState<number | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const sortedHulls = useMemo(() => sortHulls(hulls), [hulls]);
  const hull = sortedHulls.find((h) => h.id === form.hullId) ?? null;
  const selected = plan?.options.find((o) => o.id === selectedId) ?? null;
  const block = approvalBlock(selected, hull, launch);
  const sim = state.executions?.simSpeed ?? null;
  const simThreshold = sim?.threshold ?? settingsThreshold ?? state.executions?.simSpeedMin ?? null;

  // Load hulls + settings once, then poll hulls every 10 s: an owner can paste
  // a ship, tag its programmable block [HERMES-TEST] and expect the designer to
  // offer it without reloading the page.
  useEffect(() => {
    let cancelled = false;
    let first = true;
    const loadHulls = () => {
      api
        .designerHulls()
        .then((res) => {
          if (cancelled) return;
          setHulls(res.hulls);
          setHullsError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          if (first) setHullsError(messageOf(err));
        })
        .finally(() => {
          if (cancelled) return;
          if (first) {
            first = false;
            setHullsLoading(false);
          }
        });
    };
    setHullsLoading(true);
    loadHulls();
    const timer = setInterval(loadHulls, 10_000);
    api
      .designerSettings()
      .then((res) => {
        if (cancelled) return;
        const next = { simSpeedMin: res.simSpeedMin, maxActive: res.maxActive, launchReservePct: res.launchReservePct ?? 15 };
        setSettings(next);
        setSavedSettings(next);
        setSettingsLive(res.liveSimSpeed);
        setSettingsThreshold(res.threshold);
      })
      .catch(() => {
        /* settings stay on the state-derived defaults */
      });
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Default the hull to the first owner-tagged stand-in (they are the ones
  // that can actually be cloned/launched on the test server).
  useEffect(() => {
    if (form.hullId || sortedHulls.length === 0) return;
    dispatch({ type: 'hull', hullId: sortedHulls[0]!.id });
  }, [dispatch, form.hullId, sortedHulls]);

  // Surface launch is only offered when the hull is verified ground-launch
  // capable; otherwise fall back to orbital automatically.
  useEffect(() => {
    if (launch === 'surface' && groundLaunchState(hull) !== 'yes') setLaunch('orbital');
  }, [hull, launch]);

  // Hover wins over selection for the 3D preview; the selection still drives
  // approval, so hovering can never change what gets flown.
  const previewOption = hovered ?? selected;
  useEffect(() => {
    onPreview(optionPreview(previewOption));
  }, [previewOption, onPreview]);

  const runPlan = async () => {
    const { body, error } = buildPlanRequest(form);
    if (!body) {
      setPlanError(error);
      return;
    }
    setPlanning(true);
    setPlanError(null);
    setExecError(null);
    setExecResult(null);
    setMissionId(null);
    setGpsOn(false);
    setGpsNote(null);
    try {
      const res = await api.designerPlan(body);
      setPlan(res);
      const first = res.options.find((o) => o.feasible) ?? res.options[0] ?? null;
      setSelectedId(first?.id ?? null);
      setHovered(null);
      if (!first) setPlanError('Planner returned no options for these parameters');
    } catch (err) {
      setPlanError(messageOf(err));
    } finally {
      setPlanning(false);
    }
  };

  const execute = async () => {
    if (!selected || block) return;
    setExecuting(true);
    setExecError(null);
    try {
      const nearGps = form.mode === 'connect' && form.a?.gps ? form.a.gps : undefined;
      const res = await api.designerExecute({
        optionId: selected.id,
        launch,
        nearGps,
        maxActive: settings.maxActive,
      });
      setExecResult(res);
      const id = res.missionId ?? res.mission?.id ?? null;
      setMissionId(id);
      setGpsOn(false);
      setGpsNote(null);
      // GPS on execute: put the mission's slots on the owner's HUD right away
      // so he can fly to them in-game without touching the toggle.
      if (id) {
        setGpsBusy(true);
        try {
          const gps = await api.designerGps(id, true);
          setGpsOn(true);
          setGpsNote(`GPS markers added on HUD${gps.added !== undefined ? ` (${gps.added})` : ''}`);
        } catch (err) {
          setGpsNote(`execute ok, GPS markers failed: ${messageOf(err)}`);
        } finally {
          setGpsBusy(false);
        }
      }
      onRefresh();
    } catch (err) {
      setExecError(messageOf(err));
    } finally {
      setExecuting(false);
    }
  };

  const toggleGps = async (on: boolean) => {
    if (!missionId) return;
    setGpsBusy(true);
    setGpsNote(null);
    try {
      const res = await api.designerGps(missionId, on);
      setGpsOn(on);
      setGpsNote(on ? `GPS markers added${res.added !== undefined ? ` (${res.added})` : ''}` : 'GPS markers removed');
    } catch (err) {
      setGpsNote(`GPS toggle failed: ${messageOf(err)}`);
    } finally {
      setGpsBusy(false);
    }
  };

  const applySettings = async () => {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const res = await api.designerSaveSettings(settings);
      const next = { simSpeedMin: res.simSpeedMin, maxActive: res.maxActive, launchReservePct: res.launchReservePct ?? 15 };
      setSavedSettings(next);
      setSettings(next);
      setSettingsLive(res.liveSimSpeed);
      setSettingsThreshold(res.threshold);
      onRefresh();
    } catch (err) {
      setSettingsError(messageOf(err));
    } finally {
      setSettingsSaving(false);
    }
  };

  const readyToPlan =
    Boolean(form.hullId) &&
    (form.mode === 'constellation' ? Boolean(form.planet) : Boolean(form.a && form.b));

  return (
    <aside className="designer" data-testid="designer-panel" data-open="true" data-plan-ready={String(readyToPlan)}>
      <header className="designer-head">
        <div>
          <h2>Admin / Designer</h2>
          <p className="muted small">
            Constellation planner · <span className="badge badge-simulated">SIMULATED</span> slots, links, gravity and
            coverage are planner math, not game state.
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close designer" data-testid="designer-close">
          ✕
        </button>
      </header>

      <div className="designer-body">
        <section className="designer-section">
          <div className="designer-modes" role="tablist" aria-label="Designer mode">
            <button
              type="button"
              role="tab"
              aria-selected={form.mode === 'constellation'}
              className={form.mode === 'constellation' ? 'primary' : ''}
              onClick={() => dispatch({ type: 'mode', mode: 'constellation' })}
              data-testid="designer-mode-constellation"
            >
              Constellation
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={form.mode === 'connect'}
              className={form.mode === 'connect' ? 'primary' : ''}
              onClick={() => dispatch({ type: 'mode', mode: 'connect' })}
              data-testid="designer-mode-connect"
            >
              Connect
            </button>
          </div>

          {form.mode === 'constellation' ? (
            <label>
              Planet
              <select
                value={form.planet}
                onChange={(e) => dispatch({ type: 'planet', planet: e.target.value })}
                data-testid="designer-planet"
              >
                <option value="">pick a planet…</option>
                {state.planets.map((planet) => (
                  <option key={planet.id} value={planet.name}>
                    {planet.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="designer-points">
              <ConnectPoint
                which="a"
                point={form.a}
                planets={state.planets}
                dispatch={dispatch}
                picking={pickTarget === 'a'}
                onPick={() => onPickTarget(pickTarget === 'a' ? null : 'a')}
              />
              <ConnectPoint
                which="b"
                point={form.b}
                planets={state.planets}
                dispatch={dispatch}
                picking={pickTarget === 'b'}
                onPick={() => onPickTarget(pickTarget === 'b' ? null : 'b')}
              />
              <p className="muted small">
                Click two planets on the map, click two map points ({pickTarget ? 'pick mode armed' : 'Pick on map'}), or
                paste SE GPS strings.
              </p>
            </div>
          )}

          <label>
            Pattern
            <select
              value={form.pattern}
              onChange={(e) => dispatch({ type: 'pattern', pattern: e.target.value as DesignerForm['pattern'] })}
              data-testid="designer-pattern"
            >
              {PATTERNS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          {form.mode === 'constellation' && (
            <>
              <label>
                Altitude (m) · {formatKm(form.altitudeM)}
                <input
                  type="number"
                  min={MIN_ALTITUDE_M}
                  max={MAX_ALTITUDE_M}
                  step={1000}
                  value={form.altitudeM}
                  onChange={(e) => dispatch({ type: 'altitude', altitudeM: Number(e.target.value) })}
                  data-testid="designer-altitude"
                />
              </label>
              <div className="designer-presets">
                <button type="button" onClick={() => dispatch({ type: 'altitude', altitudeM: 10_000 })} data-testid="designer-preset-10km">
                  10 km
                </button>
                <button type="button" onClick={() => dispatch({ type: 'altitude', altitudeM: 40_000 })} data-testid="designer-preset-40km">
                  40 km
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'gravity-free' })}
                  data-testid="designer-preset-gravity-free"
                  title="At or above ~60 km the slot is on the gravity-free shelf (station-keeping, no orbital mechanics)"
                >
                  Gravity-free
                </button>
              </div>
            </>
          )}

          <div className="designer-sizing">
            <label className="designer-radio">
              <input
                type="radio"
                checked={form.sizing === 'count'}
                onChange={() => dispatch({ type: 'sizing', sizing: 'count' })}
                data-testid="designer-sizing-count"
              />
              Count
            </label>
            <label className="designer-radio">
              <input
                type="radio"
                checked={form.sizing === 'spacing'}
                onChange={() => dispatch({ type: 'sizing', sizing: 'spacing' })}
                data-testid="designer-sizing-spacing"
              />
              Spacing
            </label>
          </div>
          {form.sizing === 'count' ? (
            <label>
              Slot count
              <input
                type="number"
                min={3}
                max={400}
                value={form.count}
                onChange={(e) => dispatch({ type: 'count', count: Number(e.target.value) })}
                data-testid="designer-count"
              />
            </label>
          ) : (
            <label>
              Spacing (m) · {formatKm(form.spacingM)}
              <input
                type="number"
                min={1000}
                max={500_000}
                step={1000}
                value={form.spacingM}
                onChange={(e) => dispatch({ type: 'spacing', spacingM: Number(e.target.value) })}
                data-testid="designer-spacing"
              />
            </label>
          )}

          <label>
            Hull
            <select
              value={form.hullId}
              onChange={(e) => dispatch({ type: 'hull', hullId: e.target.value })}
              disabled={hullsLoading || sortedHulls.length === 0}
              data-testid="designer-hull"
            >
              <option value="">{hullsLoading ? 'loading hulls…' : 'pick a hull…'}</option>
              {sortedHulls.map((h) => (
                <option key={h.id} value={h.id}>
                  {hullOptionLabel(h)}
                </option>
              ))}
            </select>
          </label>
          {hullsError && (
            <p className="error small" data-testid="designer-hulls-error">
              Hulls unavailable — {hullsError}
            </p>
          )}
          {hull && (
            <p className="muted small" data-testid="designer-hull-detail" data-ground-launch={groundLaunchState(hull)}>
              {hullSummary(hull)}
              {hull.twrAtSurface !== null ? ` · TWR ${hull.twrAtSurface.toFixed(2)}` : ' · TWR unknown'}
              {hull.notes ? ` · ${hull.notes}` : ''}
            </p>
          )}

          <label>
            Redundancy
            <select
              value={String(form.redundancy)}
              onChange={(e) => {
                const raw = e.target.value;
                dispatch({ type: 'redundancy', redundancy: raw === 'no-spof' ? 'no-spof' : (Number(raw) as 1 | 2) });
              }}
              data-testid="designer-redundancy"
            >
              <option value="1">Single path (k=1)</option>
              <option value="2">Two node-disjoint paths (k=2)</option>
              <option value="no-spof">No single point of failure</option>
            </select>
          </label>

          <label className="designer-slider">
            <span>
              Range margin <strong data-testid="designer-margin-value">{Math.round(form.rangeMargin * 100)}%</strong>
              {hull?.radioRangeM !== null && hull?.radioRangeM !== undefined ? (
                <span className="muted small"> · usable {formatKm(hull.radioRangeM * form.rangeMargin)}</span>
              ) : null}
            </span>
            <input
              type="range"
              min={0.5}
              max={1}
              step={0.01}
              value={form.rangeMargin}
              onChange={(e) => dispatch({ type: 'margin', rangeMargin: Number(e.target.value) })}
              data-testid="designer-margin"
            />
          </label>

          <div className="row">
            <button
              type="button"
              className="primary big"
              disabled={!readyToPlan || planning}
              onClick={() => void runPlan()}
              data-testid="designer-plan"
            >
              {planning ? 'Planning…' : 'Plan'}
            </button>
          </div>
          {planError && (
            <p className="error small" data-testid="designer-plan-error">
              {planError}
            </p>
          )}
        </section>

        {plan && (
          <section className="designer-section" data-testid="designer-plan-result" data-options={plan.options.length}>
            <div className="designer-section-head">
              <h4>Options</h4>
              <span className="badge">{plan.options.length} / 4</span>
            </div>
            <DesignerOptionCards options={plan.options} selectedId={selectedId} onSelect={(o) => setSelectedId(o.id)} onHover={setHovered} />

            {previewOption && (
              <div
                className="designer-preview"
                data-testid="designer-preview"
                data-slot-count={previewOption.positions.length}
                data-link-count={previewOption.links.length}
                data-pattern={previewOption.pattern}
              >
                <span className="muted small">
                  3D preview: <strong>{previewOption.positions.length}</strong> slots · {previewOption.links.length} links ·
                  magenta octahedra, distinct from live drones
                </span>
                <div className="designer-slot-chips" aria-hidden="true">
                  {previewOption.positions.map((slot) => (
                    <span key={slot.id} data-testid="designer-preview-slot" data-slot-id={slot.id}>
                      {slot.id}
                    </span>
                  ))}
                </div>
              </div>
            )}


            {selected && (
              <div className="designer-exec">
                <div className="designer-launch" role="group" aria-label="Launch mode">
                  <span className="muted small">Launch</span>
                  <label className={`designer-radio${groundLaunchState(hull) !== 'yes' ? ' disabled' : ''}`}>
                    <input
                      type="radio"
                      name="designer-launch"
                      checked={launch === 'surface'}
                      disabled={groundLaunchState(hull) !== 'yes'}
                      onChange={() => setLaunch('surface')}
                      data-testid="designer-launch-surface"
                    />
                    Surface
                  </label>
                  <label className="designer-radio">
                    <input
                      type="radio"
                      name="designer-launch"
                      checked={launch === 'orbital'}
                      onChange={() => setLaunch('orbital')}
                      data-testid="designer-launch-orbital"
                    />
                    Orbital
                  </label>
                </div>
                <p className="muted small" data-testid="designer-selected-summary">
                  Selected: {selected.count} slots · {redundancyLabel(selected.redundancyAchieved)} · coverage{' '}
                  {coverageLabel(selected.coveragePct)} · {selected.summary}
                </p>
                <button
                  type="button"
                  className="primary big"
                  disabled={Boolean(block) || executing}
                  onClick={() => void execute()}
                  title={block ?? 'Queue the mission and let the executor launch it'}
                  data-testid="designer-approve"
                >
                  {executing ? 'Creating mission…' : `Approve & fly — ${selected.count} slots (${launch})`}
                </button>
                {block && (
                  <p className="warn small" data-testid="designer-approve-reason">
                    {block}
                  </p>
                )}
                {execError && (
                  <p className="error small" data-testid="designer-execute-error">
                    {execError}
                  </p>
                )}
              </div>
            )}

            {execResult && (
              <div className="designer-result" data-testid="designer-execute-result" data-mission-id={missionId ?? ''}>
                <div className="designer-result-head">
                  <strong>Mission queued</strong>
                  {(execResult.scaled || execResult.execution?.scaled || execResult.label === 'SCALED') && (
                    <span className="badge badge-warn">SCALED</span>
                  )}
                  {(execResult.labels ?? []).map((label) => (
                    <span key={label} className="badge">
                      {label}
                    </span>
                  ))}
                </div>
                <p className="mono small" data-testid="designer-mission-id">
                  {missionId ?? '(no mission id returned)'}
                </p>
                <p className="muted small">
                  {execResult.execution?.note ??
                    execResult.execution?.detail ??
                    'Launch → secure → move → hold. Progress and per-drone state appear in Mission progress.'}
                </p>
              </div>
            )}
          </section>
        )}

        <DesignerSettingsPanel
          draft={settings}
          liveSimSpeed={sim?.value ?? settingsLive}
          simSpeedThreshold={simThreshold}
          blocked={Boolean(sim?.blocked)}
          dirty={settings.simSpeedMin !== savedSettings.simSpeedMin || settings.maxActive !== savedSettings.maxActive || (settings.launchReservePct ?? 15) !== (savedSettings.launchReservePct ?? 15)}
          saving={settingsSaving}
          error={settingsError}
          onChange={setSettings}
          onApply={() => void applySettings()}
        />

        <section className="designer-section" data-testid="designer-gps-section">
          <h4>In-game markers</h4>
          <label className="designer-toggle">
            <input
              type="checkbox"
              checked={gpsOn}
              disabled={!missionId || gpsBusy}
              onChange={(e) => void toggleGps(e.target.checked)}
              data-testid="designer-gps-toggle"
            />
            GPS to my HUD
          </label>
          <p className="muted small">
            {missionId
              ? 'Adds slot + drone GPS markers to your identity on the test server. Removing them needs no approval.'
              : 'Approve & fly first — markers follow a mission.'}
          </p>
          {gpsNote && (
            <p className="small" data-testid="designer-gps-note">
              {gpsNote}
            </p>
          )}
        </section>

        <DesignerFollowList executions={state.executions?.executions ?? []} />

        <p className="muted small" data-testid="designer-labels-note">
          Labels: planner output is SIMULATED; live grid state stays UNVERIFIED until the plugin reports it. Executions
          are scaled to the active cap and labelled SCALED.
        </p>
      </div>
    </aside>
  );
}
