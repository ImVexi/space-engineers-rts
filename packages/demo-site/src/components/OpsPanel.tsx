/**
 * T51/T60 operator screens, all inside ONE panel so a phone gets one bottom
 * sheet and the map keeps >= 55 % of the viewport.
 *
 * Tabs (one goal each, one primary button each):
 *   Alerts     — severity, plain reason, concrete fix, acknowledge/resolve
 *   Optimise   — "Optimise my network": proposed constellation, coverage in words
 *   Send to    — destination by name, preflight, one Approve
 *   Fleet ops  — the plan, what each ship will do, execute disabled + reason
 *
 * Everything secondary (planet, k, cell size, margin, altitude mode, abort
 * policy) lives behind one collapsed "Advanced".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { DemoNode, DemoState, Vec3 } from '../types';
import type { OptimisePlan } from '../lib/optimise';
import {
  alertFix,
  alertFixTab,
  alertReason,
  alertsHeadline,
  coverageSource,
  destinations,
  fleetCoverageLine,
  fleetExecuteGate,
  fleetShipLines,
  moveLine,
  optimiseApplyGate,
  optimiseCostLine,
  parseGps,
  preflightLines,
  severityLabel,
  terrainNotice,
  type AlertsResponse,
  type FleetOperation2,
  type OpsAlert,
  type OpsTab,
} from '../lib/ops';

type Toast = (kind: 'ok' | 'err' | 'info', text: string, hint?: string) => void;

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return `${err.message}${err.hint ? ` — ${err.hint}` : ''}`;
  return err instanceof Error ? err.message : 'unexpected error';
}

/** `survivalMode` from /api/health or /api/demo/state; absent = render nothing. */
export function SurvivalBadge({ survivalMode }: { survivalMode: boolean | null }) {
  if (survivalMode === null) return null;
  return (
    <span
      className={`chip survival-badge${survivalMode ? ' survival' : ''}`}
      data-testid="survival-badge"
      data-survival={survivalMode ? 'true' : 'false'}
      title={
        survivalMode
          ? 'Survival mode: test-only actions (spawn, clone, teleport, refill) are refused by the backend.'
          : 'Test world: admin actions are allowed, but every order is still audited.'
      }
    >
      {survivalMode ? 'SURVIVAL MODE' : 'TEST WORLD'}
    </span>
  );
}

/* ------------------------------------------------------------------ alerts */

export function AlertsScreen({
  response,
  error,
  busy,
  onRefresh,
  onAck,
  onResolve,
  onFixTab,
}: {
  response: AlertsResponse | null;
  error: string | null;
  busy: boolean;
  onRefresh: () => void;
  onAck: (alert: OpsAlert) => void;
  onResolve: (alert: OpsAlert) => void;
  onFixTab: (tab: OpsTab) => void;
}) {
  return (
    <section className="ops-screen" data-testid="ops-alerts">
      <p className="ops-headline" data-testid="alerts-headline">
        {error ? `Could not read alerts: ${error}` : alertsHeadline(response)}
      </p>
      {response && !response.enabled && (
        <p className="ops-note bad" data-testid="alerts-disabled">
          {response.reason ?? 'The alerts engine is not attached, so nothing here is a measurement.'}
        </p>
      )}
      <div className="ops-list" data-testid="alerts-list">
        {(response?.alerts ?? []).map((alert) => {
          const tab = alertFixTab(alert);
          return (
            <article key={alert.id} className={`ops-alert ${alert.severity}`} data-testid="ops-alert" data-severity={alert.severity} data-state={alert.state}>
              <header>
                <span className={`sev ${alert.severity}`}>{severityLabel(alert.severity)}</span>
                <strong>{alert.message}</strong>
                {alert.count > 1 && <span className="ops-count">×{alert.count}</span>}
              </header>
              <p className="ops-why" data-testid="alert-reason">
                {alertReason(alert)}
              </p>
              <p className="ops-fix" data-testid="alert-fix">
                Fix: {alertFix(alert)}
              </p>
              <div className="ops-row-actions">
                {tab && (
                  <button type="button" className="chip" data-testid="alert-open-fix" onClick={() => onFixTab(tab)}>
                    Open the fix
                  </button>
                )}
                {alert.state === 'open' && (
                  <button type="button" className="chip" data-testid="alert-ack" disabled={busy} onClick={() => onAck(alert)}>
                    Acknowledge
                  </button>
                )}
                <button type="button" className="chip" data-testid="alert-resolve" disabled={busy} onClick={() => onResolve(alert)}>
                  Resolve
                </button>
              </div>
            </article>
          );
        })}
      </div>
      <button type="button" className="chip ops-refresh" data-testid="alerts-refresh" onClick={onRefresh} disabled={busy}>
        {busy ? 'Refreshing…' : 'Refresh alerts'}
      </button>
    </section>
  );
}

/* ---------------------------------------------------------------- optimise */

interface OptimiseSettings {
  planet: string;
  target: 'whole' | 'hemisphere' | 'radius';
  radiusM: number;
  k: 1 | 2;
  cellDeg: number;
  rangeMarginPct: number;
  maxMoves: number | null;
  altitudeMode: 'manual' | 'max-reach' | 'cheapest';
}

export function OptimiseScreen({
  state,
  selectedIds,
  onTab,
  onToast,
  planner = api.optimise,
}: {
  state: DemoState;
  selectedIds: string[];
  onTab: (tab: OpsTab) => void;
  onToast: Toast;
  planner?: typeof api.optimise;
}) {
  const planetNames = state.planets.map((p) => p.name);
  const [settings, setSettings] = useState<OptimiseSettings>({
    planet: planetNames[0] ?? 'EarthLike',
    target: 'hemisphere',
    radiusM: 20000,
    k: 1,
    cellDeg: 5,
    rangeMarginPct: 10,
    maxMoves: null,
    altitudeMode: 'cheapest',
  });
  const [advanced, setAdvanced] = useState(false);
  const [plan, setPlan] = useState<OptimisePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<FleetOperation2 | null>(null);
  const seq = useRef(0);

  const run = useCallback(
    async (next: OptimiseSettings, cellDeg: number) => {
      const mine = ++seq.current;
      setBusy(true);
      setError(null);
      try {
        const body = {
          planet: next.planet,
          target:
            next.target === 'radius'
              ? ({ kind: 'radius', radiusM: next.radiusM, center: { latDeg: 0, lonDeg: 0 } } as const)
              : next.target,
          k: next.k,
          cellDeg,
          rangeMarginPct: next.rangeMarginPct,
          maxMoves: next.maxMoves,
          altitudeMode: next.altitudeMode,
        };
        const result = await planner(body);
        if (mine !== seq.current) return;
        setPlan(result);
      } catch (err) {
        if (mine !== seq.current) return;
        setError(messageOf(err));
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    },
    [planner],
  );

  // Live preview: 250 ms debounce on a coarse 10° grid, then a 5° refine.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      void run(settings, 10);
      void run(settings, settings.cellDeg);
      return;
    }
    const coarse = window.setTimeout(() => void run(settings, 10), 250);
    const refine = window.setTimeout(() => void run(settings, settings.cellDeg), 900);
    return () => {
      window.clearTimeout(coarse);
      window.clearTimeout(refine);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const set = <K extends keyof OptimiseSettings>(key: K, value: OptimiseSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const gate = optimiseApplyGate(plan, selectedIds);
  const source = coverageSource(plan?.labels);
  const notice = terrainNotice(plan?.coverageAfter ?? plan?.coverageNow);

  const apply = async () => {
    if (!plan) return;
    setApplying(true);
    try {
      const slots = plan.moves.map((m) => ({ gridId: m.gridId, target: m.to.pos }));
      const res = await api.fleetOpCreate({ kind: 'reshape', slots, dryRun: false, members: plan.moves.map((m) => m.gridId) });
      setApplied(res.operation);
      onToast('ok', `Operation ${res.operation.id} created for ${res.operation.members.length} ship(s).`, 'Review and approve it in Fleet ops — nothing flies until you press Execute.');
    } catch (err) {
      onToast('err', 'Apply was refused.', messageOf(err));
    } finally {
      setApplying(false);
    }
  };

  return (
    <section className="ops-screen" data-testid="ops-optimise">
      <p className="ops-headline" data-testid="optimise-cost">
        {busy && !plan ? 'Working out the best constellation…' : optimiseCostLine(plan)}
      </p>
      {error && (
        <p className="ops-note bad" data-testid="optimise-error">
          The optimiser refused: {error}
        </p>
      )}
      {plan && (
        <>
          <p className="ops-note" data-testid="optimise-source">
            Coverage source: <b>{source === 'UNKNOWN' ? 'not labelled by the backend' : source}</b>
            {plan.labels.length > 0 ? ` (${plan.labels.join(', ')})` : ''} · terrain {plan.coverageAfter.terrain}
          </p>
          {notice && (
            <p className="ops-note warn" data-testid="optimise-terrain">
              {notice}
            </p>
          )}
          <p className="ops-note" data-testid="optimise-count">
            {plan.moves.length === 0
              ? 'No ship needs to move.'
              : `The plan moves ${plan.moves.length} ship(s); ${plan.staying.length} stay put and ${plan.surplus.length} are surplus.`}
            {' '}
            {plan.holesTotal > 0 ? `${plan.holesTotal} cell(s) stay uncovered.` : 'Every target cell is covered after the move.'}
          </p>
          <div className="ops-list" data-testid="optimise-moves">
            {plan.moves.map((move) => {
              const line = moveLine(move);
              return (
                <article key={move.gridId} className="ops-row" data-testid="optimise-move">
                  <strong>{line.title}</strong>
                  <span>{line.detail}</span>
                  <span className={line.warn ? 'ops-warn' : 'ops-muted'}>{line.transit}</span>
                </article>
              );
            })}
            {plan.staying.map((stay) => (
              <article key={stay.gridId} className="ops-row muted" data-testid="optimise-staying">
                <strong>{stay.name} stays put</strong>
                <span>{stay.reason}</span>
              </article>
            ))}
          </div>
          {plan.holes.length > 0 && (
            <div className="ops-block" data-testid="optimise-holes">
              <h3>Holes and their cheapest fix</h3>
              <ul>
                {plan.holes.slice(0, 8).map((hole) => (
                  <li key={`${hole.latDeg}:${hole.lonDeg}`}>
                    {hole.latDeg.toFixed(1)}°, {hole.lonDeg.toFixed(1)}° — {hole.reason}. {hole.fix.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.buildRequests.length > 0 && (
            <div className="ops-block" data-testid="optimise-build">
              <h3>Build requests</h3>
              <ul>
                {plan.buildRequests.map((req) => (
                  <li key={req.slotId}>{req.buildRequest}</li>
                ))}
              </ul>
            </div>
          )}
          {applied && (
            <p className="ops-note ok" data-testid="optimise-applied">
              Operation {applied.id} is waiting for your approval.{' '}
              <button type="button" className="chip" onClick={() => onTab('fleet')}>
                Review it in Fleet ops
              </button>
            </p>
          )}
        </>
      )}
      <div className="ops-primary-row">
        <button
          type="button"
          className="primary ops-primary"
          data-testid="optimise-run"
          disabled={busy}
          onClick={() => void run(settings, settings.cellDeg)}
        >
          {busy ? 'Optimising…' : 'Optimise my network'}
        </button>
        <button
          type="button"
          className="primary ops-primary"
          data-testid="optimise-apply"
          disabled={!gate.enabled || applying}
          title={gate.reason}
          onClick={() => void apply()}
        >
          {applying ? 'Applying…' : 'Apply this layout'}
        </button>
      </div>
      {!gate.enabled && (
        <p className="ops-note muted" data-testid="optimise-apply-reason">
          {gate.reason}
        </p>
      )}
      <details className="ops-advanced" data-testid="optimise-advanced" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary>Advanced</summary>
        <div className="ops-grid">
          <label>
            Planet
            <select data-testid="opt-planet" value={settings.planet} onChange={(e) => set('planet', e.target.value)}>
              {planetNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Target
            <select data-testid="opt-target" value={settings.target} onChange={(e) => set('target', e.target.value as OptimiseSettings['target'])}>
              <option value="hemisphere">Hemisphere facing the base</option>
              <option value="whole">Whole planet</option>
              <option value="radius">Radius around the base</option>
            </select>
          </label>
          {settings.target === 'radius' && (
            <label>
              Radius (km)
              <input
                type="number"
                min={1}
                max={60}
                data-testid="opt-radius"
                value={Math.round(settings.radiusM / 1000)}
                onChange={(e) => set('radiusM', Math.max(1, Number(e.target.value)) * 1000)}
              />
            </label>
          )}
          <label>
            Redundancy k
            <select data-testid="opt-k" value={settings.k} onChange={(e) => set('k', Number(e.target.value) === 2 ? 2 : 1)}>
              <option value={1}>1 — every cell heard once</option>
              <option value={2}>2 — every cell heard twice</option>
            </select>
          </label>
          <label>
            Cell size (deg)
            <input
              type="number"
              min={2}
              max={15}
              step={1}
              data-testid="opt-cell"
              value={settings.cellDeg}
              onChange={(e) => set('cellDeg', Math.min(15, Math.max(2, Number(e.target.value))))}
            />
          </label>
          <label>
            Range margin (%)
            <input
              type="number"
              min={0}
              max={50}
              data-testid="opt-margin"
              value={settings.rangeMarginPct}
              onChange={(e) => set('rangeMarginPct', Math.max(0, Number(e.target.value)))}
            />
          </label>
          <label>
            Altitude
            <select data-testid="opt-altitude" value={settings.altitudeMode} onChange={(e) => set('altitudeMode', e.target.value as OptimiseSettings['altitudeMode'])}>
              <option value="cheapest">Cheapest that works</option>
              <option value="max-reach">Max reach</option>
              <option value="manual">Keep current</option>
            </select>
          </label>
          <label>
            Max moves
            <input
              type="number"
              min={0}
              data-testid="opt-maxmoves"
              value={settings.maxMoves ?? ''}
              placeholder="no limit"
              onChange={(e) => set('maxMoves', e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
            />
          </label>
        </div>
      </details>
    </section>
  );
}

/* ----------------------------------------------------------------- send-to */

export function SendToScreen({
  state,
  bases,
  selectedIds,
  onToast,
}: {
  state: DemoState;
  bases: { name: string; position: Vec3 }[];
  selectedIds: string[];
  onToast: Toast;
}) {
  const options = useMemo(() => destinations(state, bases), [state, bases]);
  const [query, setQuery] = useState('');
  const [destId, setDestId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>(selectedIds);
  const [gps, setGps] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<ReturnType<typeof preflightLines> | null>(null);

  useEffect(() => {
    setPicked((prev) => (prev.length === 0 ? selectedIds : prev));
  }, [selectedIds]);

  const alive = state.nodes.filter((n) => n.status === 'alive');
  const dest = options.find((o) => o.id === destId) ?? null;
  const gpsPoint = parseGps(gps);
  const target: { planet: string; altitudeM: number } | { gps: Vec3 } | string | null = gpsPoint
    ? { gps: gpsPoint }
    : (dest?.target ?? null);
  const chosen = alive.filter((n) => picked.includes(n.id));
  const filtered = options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 40);

  const targetLabel = gpsPoint
    ? `GPS point (${Math.round(gpsPoint.x)}, ${Math.round(gpsPoint.y)}, ${Math.round(gpsPoint.z)})`
    : (dest?.label ?? null);

  const preview = async () => {
    if (!target || chosen.length === 0) return;
    setBusy(true);
    try {
      const results = await Promise.all(
        chosen.map((node) => api.moveTo({ gridId: node.id, target, dryRun: true })),
      );
      const refused = results.filter((r) => r.preflight.ok === false);
      setLines(results[0] ? preflightLines(results[0].preflight) : null);
      setConfirming(refused.length === 0);
      if (refused.length > 0) {
        onToast('err', `${refused.length} of ${results.length} ship(s) cannot make it.`, refused[0]!.preflight.block?.message ?? undefined);
      }
    } catch (err) {
      onToast('err', 'Preflight failed.', messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!target || chosen.length === 0) return;
    setBusy(true);
    try {
      for (const node of chosen) {
        const res = await api.moveTo({ gridId: node.id, target });
        if (res.preflight.ok === false) {
          onToast('err', `${node.name} was refused.`, res.preflight.block?.message ?? undefined);
          setBusy(false);
          return;
        }
      }
      onToast('ok', `Sent ${chosen.length} ship(s) to ${targetLabel ?? 'the target'}.`, 'Open the fleet page to watch progress.');
      setConfirming(false);
    } catch (err) {
      onToast('err', 'Send was refused.', messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ops-screen" data-testid="ops-send">
      <p className="ops-headline">Tell a ship where to go by name — not by clicking a pixel in deep space.</p>
      <div className="ops-block">
        <h3>1 · Ships</h3>
        <div className="ops-chips" data-testid="send-ships">
          {alive.map((node) => {
            const on = picked.includes(node.id);
            return (
              <button
                key={node.id}
                type="button"
                className={`chip${on ? ' active' : ''}`}
                data-testid="send-ship"
                aria-pressed={on}
                onClick={() => setPicked((prev) => (on ? prev.filter((id) => id !== node.id) : [...prev, node.id]))}
              >
                {node.name}
              </button>
            );
          })}
          {alive.length === 0 && <span className="ops-muted">No live ship to send.</span>}
        </div>
      </div>
      <div className="ops-block">
        <h3>2 · Destination</h3>
        <input
          type="search"
          placeholder="Search planets, bases, ships…"
          data-testid="send-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="ops-list short" data-testid="send-destinations">
          {filtered.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`ops-row select${destId === option.id ? ' active' : ''}`}
              data-testid="send-destination"
              onClick={() => {
                setDestId(option.id);
                setGps('');
                setConfirming(false);
              }}
            >
              <strong>{option.label}</strong>
              <span className="ops-muted">{option.note}</span>
            </button>
          ))}
          {filtered.length === 0 && <span className="ops-muted">Nothing matches that search.</span>}
        </div>
        <label className="ops-inline">
          or paste a GPS
          <input
            type="text"
            placeholder="GPS:name:x:y:z:#FF75C9F1"
            data-testid="send-gps"
            value={gps}
            onChange={(e) => {
              setGps(e.target.value);
              setConfirming(false);
            }}
          />
        </label>
        {gps.trim() !== '' && !gpsPoint && (
          <p className="ops-note warn" data-testid="send-gps-bad">
            That is not a GPS string. Expected GPS:name:x:y:z.
          </p>
        )}
      </div>
      <div className="ops-primary-row">
        <button
          type="button"
          className="primary ops-primary"
          data-testid="send-preview"
          disabled={busy || !target || chosen.length === 0}
          onClick={() => void preview()}
        >
          {busy ? 'Checking…' : `Preview route for ${chosen.length} ship(s)`}
        </button>
        <button
          type="button"
          className="primary ops-primary"
          data-testid="send-approve"
          disabled={busy || !confirming}
          title={confirming ? `Send ${chosen.length} ship(s)` : 'Preview the route first — the preflight must pass.'}
          onClick={() => void send()}
        >
          Approve and send
        </button>
      </div>
      {lines && <PreflightCard preflight={lines} />}
      {!confirming && (
        <p className="ops-note muted" data-testid="send-reason">
          {!target
            ? 'Pick a destination — by name, base, ship or GPS.'
            : chosen.length === 0
              ? 'Pick at least one ship.'
              : 'Preview the route: distance, ETA, fuel left and the link path appear here before you approve.'}
        </p>
      )}
      {confirming && dest && (
        <p className="ops-note ok" data-testid="send-preflight-ok">
          {chosen.length} ship(s) can reach {dest.label}: {dest.note} Every check passed; approve to fly.
        </p>
      )}
    </section>
  );
}

/** One preflight block, rendered from the backend's dry-run answer. */
export function PreflightCard({ preflight }: { preflight: ReturnType<typeof preflightLines> }) {
  return (
    <dl className="ops-preflight" data-testid="send-preflight">
      <div>
        <dt>Distance</dt>
        <dd>{preflight.distance}</dd>
      </div>
      <div>
        <dt>ETA</dt>
        <dd>{preflight.eta}</dd>
      </div>
      <div>
        <dt>Fuel left</dt>
        <dd>{preflight.fuel}</dd>
      </div>
      <div>
        <dt>Link path</dt>
        <dd>{preflight.link}</dd>
      </div>
      {preflight.refusal && <p className="ops-note bad">{preflight.refusal}</p>}
    </dl>
  );
}

/* ---------------------------------------------------------------- fleet ops */

export function FleetOpsScreen({
  state,
  selectedIds,
  onToast,
}: {
  state: DemoState;
  selectedIds: string[];
  onToast: Toast;
}) {
  const [kind, setKind] = useState<'swap' | 'recall' | 'reshape' | 'relocate'>('recall');
  const [operation, setOperation] = useState<FleetOperation2 | null>(null);
  const [operations, setOperations] = useState<FleetOperation2[]>([]);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [abortPolicy, setAbortPolicy] = useState<'hold' | 'return' | 'continue'>('hold');

  const names = useMemo(() => Object.fromEntries(state.nodes.map((n) => [n.id, n.name])), [state.nodes]);
  const gate = fleetExecuteGate(state.flags, operation);
  const ships = fleetShipLines(operation, names);

  const loadOperations = useCallback(async () => {
    try {
      const res = await api.fleetOps();
      setOperations(res.operations);
    } catch {
      setOperations([]);
    }
  }, []);

  useEffect(() => {
    void loadOperations();
  }, [loadOperations]);

  const plan = async () => {
    setBusy(true);
    try {
      const res = await api.fleetOpCreate({
        kind,
        members: selectedIds.length > 0 ? selectedIds : undefined,
        dryRun: true,
        abortPolicy,
      });
      setOperation(res.operation);
      onToast('info', `Plan ${res.operation.id} built for ${res.operation.members.length} ship(s).`, 'Nothing flies until you press Execute — and execution must be enabled on the server.');
      void loadOperations();
    } catch (err) {
      onToast('err', 'The plan was refused.', messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!operation) return;
    setBusy(true);
    try {
      const res = await api.fleetOpApprove(operation.id, true);
      setOperation(res.operation);
      onToast('ok', `Operation ${res.operation.id} is ${res.operation.status}.`, res.note ?? 'Watch per-ship progress below.');
      void loadOperations();
    } catch (err) {
      onToast('err', 'Execute was refused.', messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!operation) return;
    setBusy(true);
    try {
      const res = await api.fleetOpCancel(operation.id);
      setOperation(res.operation);
      onToast('info', `Operation ${res.operation.id} cancelled.`, res.note ?? undefined);
      void loadOperations();
    } catch (err) {
      onToast('err', 'Cancel failed.', messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ops-screen" data-testid="ops-fleet">
      <p className="ops-headline">
        {operation
          ? `${operation.kind} for ${operation.members.length} ship(s): ${operation.status.replace(/_/g, ' ')}.`
          : 'Plan one fleet operation, see what each ship will do, then approve it once.'}
      </p>
      <div className="ops-block">
        <h3>1 · What should the group do?</h3>
        <div className="ops-chips" data-testid="fleet-kind">
          {(['recall', 'swap', 'reshape', 'relocate'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`chip${kind === value ? ' active' : ''}`}
              data-testid={`fleet-kind-${value}`}
              aria-pressed={kind === value}
              onClick={() => {
                setKind(value);
                setOperation(null);
              }}
            >
              {value === 'recall' ? 'Come home' : value === 'swap' ? 'Swap places' : value === 'reshape' ? 'Reshape' : 'Relocate'}
            </button>
          ))}
        </div>
        <p className="ops-muted" data-testid="fleet-members">
          {selectedIds.length > 0 ? `${selectedIds.length} selected ship(s) will be planned.` : 'Select ships on the map first; with nothing selected the backend plans the whole fleet.'}
        </p>
      </div>
      {operation && (
        <>
          <div className="ops-block" data-testid="fleet-plan">
            <h3>2 · What each ship will do</h3>
            <div className="ops-list">
              {ships.map((ship) => (
                <article key={ship.name} className="ops-row" data-testid="fleet-ship">
                  <strong>{ship.name}</strong>
                  <span className={ship.warn ? 'ops-warn' : ''}>{ship.will}</span>
                </article>
              ))}
              {ships.length === 0 && <span className="ops-muted">The plan lists no member.</span>}
            </div>
            <p className="ops-note" data-testid="fleet-coverage">
              {fleetCoverageLine(operation)}
            </p>
            {operation.invariants.failures.length > 0 && (
              <ul className="ops-failures" data-testid="fleet-failures">
                {operation.invariants.failures.map((failure, i) => (
                  <li key={`${failure.invariant}-${i}`}>
                    {failure.invariant}
                    {failure.memberId ? ` (${names[failure.memberId] ?? failure.memberId})` : ''}: {failure.reason}
                  </li>
                ))}
              </ul>
            )}
            <p className="ops-muted" data-testid="fleet-abort">
              If a step fails: {operation.abortPolicy}.
            </p>
          </div>
          <div className="ops-primary-row">
            <button type="button" className="primary ops-primary" data-testid="fleet-execute" disabled={!gate.enabled || busy} title={gate.reason} onClick={() => void execute()}>
              {busy ? 'Working…' : 'Execute this operation'}
            </button>
            <button type="button" className="chip" data-testid="fleet-cancel" disabled={busy} onClick={() => void cancel()}>
              Cancel
            </button>
          </div>
          {!gate.enabled && (
            <p className="ops-note warn" data-testid="fleet-execute-reason">
              {gate.reason}
            </p>
          )}
        </>
      )}
      {!operation && (
        <div className="ops-primary-row">
          <button type="button" className="primary ops-primary" data-testid="fleet-plan-run" disabled={busy} onClick={() => void plan()}>
            {busy ? 'Planning…' : 'Plan this operation'}
          </button>
        </div>
      )}
      <details className="ops-advanced" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary>Advanced</summary>
        <label className="ops-inline">
          If a step fails
          <select data-testid="fleet-abort-policy" value={abortPolicy} onChange={(e) => setAbortPolicy(e.target.value as typeof abortPolicy)}>
            <option value="hold">Hold position</option>
            <option value="return">Fly home</option>
            <option value="continue">Keep flying</option>
          </select>
        </label>
      </details>
      {operations.length > 0 && (
        <div className="ops-block" data-testid="fleet-history">
          <h3>Operations</h3>
          <ul className="ops-history">
            {operations.slice(0, 8).map((op) => (
              <li key={op.id}>
                <button type="button" className="chip" data-testid="fleet-history-open" onClick={() => setOperation(op)}>
                  {op.id}
                </button>
                <span className="ops-muted">
                  {op.kind} · {op.members.length} ship(s) · {op.status.replace(/_/g, ' ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------- shell */

export interface OpsPanelProps {
  state: DemoState;
  selectedIds: string[];
  bases: { name: string; position: Vec3 }[];
  tab: OpsTab;
  onTab: (tab: OpsTab) => void;
  onClose: () => void;
  onToast: Toast;
}

const TABS: { id: OpsTab; label: string }[] = [
  { id: 'alerts', label: 'Alerts' },
  { id: 'optimise', label: 'Optimise' },
  { id: 'send', label: 'Send to' },
  { id: 'fleet', label: 'Fleet ops' },
];

export function OpsPanel({ state, selectedIds, bases, tab, onTab, onClose, onToast }: OpsPanelProps) {
  const [alerts, setAlerts] = useState<AlertsResponse | null>(null);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [alertsBusy, setAlertsBusy] = useState(false);

  const loadAlerts = useCallback(async () => {
    setAlertsBusy(true);
    try {
      const res = await api.alerts({ limit: 100 });
      setAlerts(res);
      setAlertsError(null);
    } catch (err) {
      setAlertsError(messageOf(err));
    } finally {
      setAlertsBusy(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== 'alerts' || alerts) return;
    void loadAlerts();
  }, [tab, alerts, loadAlerts]);

  const act = async (alert: OpsAlert, action: 'ack' | 'resolve') => {
    setAlertsBusy(true);
    try {
      if (action === 'ack') await api.alertAck(alert.id);
      else await api.alertResolve(alert.id);
      onToast('ok', action === 'ack' ? 'Alert acknowledged.' : 'Alert resolved.', alert.message);
      setAlerts(null);
      await loadAlerts();
    } catch (err) {
      onToast('err', 'The alert update was refused.', messageOf(err));
    } finally {
      setAlertsBusy(false);
    }
  };

  return (
    <aside className="ops-panel" data-testid="ops-panel" aria-label="Operator screens">
      <header className="ops-head">
        <div>
          <h2>Operator screens</h2>
          <p className="ops-sub">One goal at a time; the map stays in front of you.</p>
        </div>
        <button type="button" className="ops-close" data-testid="ops-close" onClick={onClose} aria-label="Close operator screens">
          ✕
        </button>
      </header>
      <nav className="ops-tabs" data-testid="ops-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`chip${tab === t.id ? ' active' : ''}`}
            data-testid={`ops-tab-${t.id}`}
            onClick={() => onTab(t.id)}
          >
            {t.label}
            {t.id === 'alerts' && alerts && alerts.alerts.length > 0 && <span className="ops-badge">{alerts.alerts.length}</span>}
          </button>
        ))}
      </nav>
      {tab === 'alerts' && (
        <AlertsScreen
          response={alerts}
          error={alertsError}
          busy={alertsBusy}
          onRefresh={() => void loadAlerts()}
          onAck={(alert) => void act(alert, 'ack')}
          onResolve={(alert) => void act(alert, 'resolve')}
          onFixTab={onTab}
        />
      )}
      {tab === 'optimise' && <OptimiseScreen state={state} selectedIds={selectedIds} onTab={onTab} onToast={onToast} />}
      {tab === 'send' && <SendToScreen state={state} bases={bases} selectedIds={selectedIds} onToast={onToast} />}
      {tab === 'fleet' && <FleetOpsScreen state={state} selectedIds={selectedIds} onToast={onToast} />}
    </aside>
  );
}

export type { DemoNode };
