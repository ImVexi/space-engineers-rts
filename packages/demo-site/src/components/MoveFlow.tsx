import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { MovePreflight, MoveToResponse, Planet, Vec3 } from '../types';
import { parseGpsString } from '../lib/designer';
import { moveRoleCheck } from '../lib/shipRoles';
import {
  LOW_ORBIT_KM,
  ZERO_G_ORBIT_KM,
  blockText,
  preflightRows,
  targetSpecLabel,
  wireTarget,
  type TargetSpec,
} from '../lib/flows';

export interface MoveFlowProps {
  ships: { id: string; name: string; role?: 'managed' | 'personal' | 'base' | 'off' }[];
  planets: Planet[];
  /** a point the owner right-clicked on the map, if any */
  pickedTarget: Vec3 | null;
  /** quick orbit chosen by an action bar / context menu shortcut */
  initialPreset?: 'orbit-zero-g' | 'orbit-low' | null;
  onPickOnMap: () => void;
  picking: boolean;
  onClose: () => void;
  onMoved: (text: string) => void;
  onComingSoon: () => void;
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'unexpected error';
}

/**
 * One panel, one decision. Destination (map click or quick pick) -> plain
 * preflight -> Go. Refusals show the backend's message plus its fix hint, and
 * the test-only Admin override, off by default.
 */
export function MoveFlow({ ships, planets, pickedTarget, initialPreset, onPickOnMap, picking, onClose, onMoved, onComingSoon }: MoveFlowProps) {
  const [spec, setSpec] = useState<TargetSpec | null>(
    pickedTarget ? { kind: 'gps', pos: pickedTarget } : initialPreset ? { kind: 'preset', preset: initialPreset } : null,
  );
  const [planet, setPlanet] = useState('EarthLike');
  const [altitudeKm, setAltitudeKm] = useState(ZERO_G_ORBIT_KM);
  const [gpsText, setGpsText] = useState('');
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<MovePreflight | null>(null);
  const [resolved, setResolved] = useState<MoveToResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  /** PERSONAL ships need one explicit confirmation before any order is sent. */
  const [confirmPersonal, setConfirmPersonal] = useState(false);

  const lead = ships[0] ?? null;
  const specKey = useMemo(() => (spec ? JSON.stringify(spec) : ''), [spec]);
  const block = blockText(preflight);
  const rows = preflightRows(preflight);

  useEffect(() => {
    if (pickedTarget) setSpec({ kind: 'gps', pos: pickedTarget });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedTarget]);

  useEffect(() => {
    if (!spec || !lead) {
      setPreflight(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    setError(null);
    api
      .moveTo({ gridId: lead.id, target: wireTarget(spec), dryRun: true })
      .then((result) => {
        if (cancelled) return;
        setPreflight(result.preflight);
        setResolved(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPreflight(null);
        setResolved(null);
        if (err instanceof ApiError && err.status === 404) onComingSoon();
        else setError(errorText(err));
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, lead?.id]);

  const applyGps = () => {
    const parsed = parseGpsString(gpsText);
    if (!parsed) {
      setGpsError('Paste a GPS string like GPS:name:123:456:789: or three numbers.');
      return;
    }
    setGpsError(null);
    setSpec({ kind: 'gps', pos: parsed.pos });
  };

  const roleCheck = moveRoleCheck(ships);
  const personalShips = roleCheck.personal;
  const blockedShips = roleCheck.blocked;

  const go = async () => {
    if (!spec || ships.length === 0) return;
    if (blockedShips.length > 0) return;
    if (personalShips.length > 0 && !confirmPersonal) {
      setConfirmPersonal(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let last: MoveToResponse | null = null;
      for (const ship of ships) {
        last = await api.moveTo({
          gridId: ship.id,
          target: wireTarget(spec),
          ignoreReach: override,
          ...(ship.role === 'personal' ? { confirmPersonal: true } : {}),
        });
      }
      const label = last?.target.label ?? targetSpecLabel(spec);
      onMoved(ships.length === 1 ? `Moving ${ships[0]!.name} to ${label}.` : `Moving ${ships.length} ships to ${label}.`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.hint ? ` — ${err.hint}` : ''}` : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flow-panel" data-testid="move-flow" aria-label="Move a ship">
      <header className="flow-head">
        <div>
          <h2>Move {ships.length === 1 ? lead?.name ?? 'ship' : `${ships.length} ships`}</h2>
          <p className="flow-sub">Pick a destination on the map, or use a quick orbit below.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close move panel" data-testid="move-close">
          ✕
        </button>
      </header>

      <div className="flow-body">
        <div className="ship-chips">
          {ships.slice(0, 3).map((s) => (
            <span key={s.id} className="chip">
              {s.name}
            </span>
          ))}
          {ships.length > 3 && <span className="chip muted">+{ships.length - 3} more</span>}
        </div>

        <div className="quick-row">
          <button
            type="button"
            className={`quick${spec?.kind === 'preset' && spec.preset === 'orbit-zero-g' ? ' active' : ''}`}
            data-testid="move-target-zero-g"
            onClick={() => setSpec({ kind: 'preset', preset: 'orbit-zero-g' })}
          >
            <strong>Zero-g orbit</strong>
            <span>~{ZERO_G_ORBIT_KM} km · free hold</span>
          </button>
          <button
            type="button"
            className={`quick${spec?.kind === 'preset' && spec.preset === 'orbit-low' ? ' active' : ''}`}
            data-testid="move-target-low"
            onClick={() => setSpec({ kind: 'preset', preset: 'orbit-low' })}
          >
            <strong>Low orbit</strong>
            <span>~{LOW_ORBIT_KM} km · hovers, burns fuel</span>
          </button>
          <button
            type="button"
            className={`quick${picking ? ' active' : ''}`}
            data-testid="move-pick-map"
            onClick={onPickOnMap}
          >
            <strong>{picking ? 'Click the map…' : 'Pick on map'}</strong>
            <span>right-click any point too</span>
          </button>
        </div>

        <details className="flow-advanced">
          <summary>Other altitude or GPS</summary>
          <div className="inline-fields">
            <label>
              Planet
              <select value={planet} onChange={(e) => setPlanet(e.target.value)} data-testid="move-planet">
                {planets.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Altitude (km)
              <input
                type="number"
                min={1}
                max={500}
                value={altitudeKm}
                onChange={(e) => setAltitudeKm(Number(e.target.value) || 0)}
                data-testid="move-altitude"
              />
            </label>
            <button
              type="button"
              data-testid="move-use-altitude"
              onClick={() => setSpec({ kind: 'planet', planet, altitudeM: Math.max(1, altitudeKm) * 1000 })}
            >
              Use
            </button>
          </div>
          <div className="inline-fields">
            <label className="grow">
              GPS string
              <input
                value={gpsText}
                onChange={(e) => setGpsText(e.target.value)}
                placeholder="GPS:name:123:456:789:"
                data-testid="move-gps"
              />
            </label>
            <button type="button" onClick={applyGps} data-testid="move-use-gps">
              Use GPS
            </button>
          </div>
          {gpsError && <p className="error small">{gpsError}</p>}
        </details>

        <div className="target-line" data-testid="move-target-label">
          <span className="muted small">Destination</span>
          <strong>{targetSpecLabel(spec)}</strong>
        </div>

        {blockedShips.length > 0 && (
          <p className="error" data-testid="move-role-block">
            {blockedShips.map((s) => `${s.name}: ${s.reason}`).join(' · ')}
          </p>
        )}

        {personalShips.length > 0 && (
          <div className="role-confirm" data-testid="personal-confirm">
            <p>
              <strong>{personalShips.join(', ')}</strong>{' '}
              {personalShips.length === 1 ? 'is a personal ship' : 'are personal ships'}: the system never moves
              {personalShips.length === 1 ? ' it' : ' them'} on its own. This is your explicit order, flown gently
              (dampened, 60 m/s, no free fall).
            </p>
            {!confirmPersonal ? (
              <p className="muted small">Press Go once to review, then Confirm to send.</p>
            ) : (
              <p className="muted small" data-testid="personal-confirm-mark">
                Confirmed — Go sends the order.
              </p>
            )}
          </div>
        )}

        {checking && <p className="muted small" data-testid="move-checking">Checking reach, fuel and ETA…</p>}

        {error && (
          <p className="error" data-testid="move-error">
            {error}
          </p>
        )}

        {preflight && (
          <div className={`preflight${preflight.ok ? ' ok' : ' blocked'}`} data-testid="move-preflight">
            <h3>{preflight.ok ? 'Ready to go' : 'Cannot go as planned'}</h3>
            <dl>
              {rows.map((row) => (
                <div key={row.label} className={`preflight-row tone-${row.tone}`}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            {block && (
              <div className="block-note" data-testid="move-block">
                <p>{block.message}</p>
                <p className="hint">Fix: {block.hint}</p>
              </div>
            )}
            {preflight.warnings.length > 0 && (
              <ul className="warn-list">
                {preflight.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {!preflight.ok && (
              <label className="override">
                <input
                  type="checkbox"
                  checked={override}
                  onChange={(e) => setOverride(e.target.checked)}
                  data-testid="move-override"
                />
                <span>
                  <strong>Admin override</strong> — test server only. Flies the ship even though the reach check failed.
                </span>
              </label>
            )}
          </div>
        )}

        {resolved && (
          <p className="muted small" data-testid="move-resolved">
            Destination: {resolved.target.label}
            {resolved.target.altitudeM !== null ? ` · ${Math.round(resolved.target.altitudeM / 1000)} km altitude` : ''}
          </p>
        )}
      </div>

      <footer className="flow-foot">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary big"
          data-testid="move-go"
          disabled={!spec || busy || blockedShips.length > 0 || !preflight || (!preflight.ok && !override)}
          onClick={() => void go()}
        >
          {busy ? 'Sending…' : confirmPersonal && personalShips.length > 0 ? 'Confirm & go' : 'Go'}
        </button>
      </footer>
    </section>
  );
}
