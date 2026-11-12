import { useMemo, useState } from 'react';
import { SurvivalLoopPanel } from './SurvivalLoopPanel';
import type { DemoState } from '../types';
import type { ShipGroup } from '../lib/groups';
import {
  EMPTY_FILTER,
  alertsFor,
  filterFleet,
  fleetCsv,
  fmtAge,
  fmtKm,
  fmtPct,
  fmtRunway,
  sortFleet,
  type FleetAlert,
  type FleetFilter,
  type FleetRow,
  type FleetRole,
  type FleetState,
  type SortKey,
} from '../lib/fleet';

interface FleetPanelProps {
  state: DemoState;
  rows: FleetRow[];
  onClose: () => void;
  onFocus: (id: string) => void;
  onMove: (ids: string[]) => void;
  onLaunchOrbit: (ids: string[]) => void;
  onStop: (ids: string[]) => void;
  groups?: ShipGroup[];
  activeGroupId?: string | null;
  onGroupSelect?: (id: string) => void;
  onGroupAs?: (ids: string[]) => void;
  /** T66: refresh the page state after a survival-loop action. */
  onChanged?: () => void;
  onToast?: (kind: 'info' | 'ok' | 'err', title: string, detail?: string) => void;
}

const ROLES: FleetRole[] = ['R', 'L', 'M', 'H'];
const STATES: FleetState[] = ['station', 'ship', 'holding', 'en-route', 'needs-fuel', 'failed', 'manual'];

const COLUMNS: { key: SortKey; label: string; title: string }[] = [
  { key: 'name', label: 'Name', title: 'Grid name from the naming scheme' },
  { key: 'role', label: 'Role', title: 'R radio · L laser relay · M mixed · H laser hub' },
  { key: 'state', label: 'State', title: 'Station, ship, holding, en-route, needs fuel, failed or manual' },
  { key: 'planet', label: 'Planet / altitude', title: 'Nearest planet and altitude above its surface' },
  { key: 'links', label: 'Links', title: 'Radio and laser edges; hover for the connected grids' },
  { key: 'radio', label: 'Radio', title: 'Antenna range, true scale' },
  { key: 'laser', label: 'Laser ports', title: 'Free / total laser antennas' },
  { key: 'battery', label: 'Battery', title: 'Battery fill and charge state' },
  { key: 'solar', label: 'Solar', title: 'Current solar output as a share of installed capacity' },
  { key: 'h2', label: 'H2', title: 'Hydrogen fill, capacity-weighted' },
  { key: 'uranium', label: 'Uranium', title: 'Reactor fuel remaining' },
  { key: 'life', label: 'Expected life', title: 'Shortest known runway; stations and zero-g holds have no limit' },
  { key: 'age', label: 'Last contact', title: 'Telemetry age' },
  { key: 'integrity', label: 'Integrity', title: 'Hull integrity from telemetry' },
];

const NEEDS_PLUGIN = 'needs plugin update';

function ChargeArrow({ charge }: { charge: 'charging' | 'draining' | 'idle' | 'unknown' }) {
  if (charge === 'charging') return <span className="charge up" title="Charging">↑</span>;
  if (charge === 'draining') return <span className="charge down" title="Discharging">↓</span>;
  if (charge === 'idle') return <span className="charge idle" title="Idle">·</span>;
  return <span className="charge" title={NEEDS_PLUGIN}>—</span>;
}

function Missing({ title = NEEDS_PLUGIN }: { title?: string }) {
  return (
    <span className="missing" title={title}>
      —
    </span>
  );
}

/** MW for the power breakdown line; null stays a dash, never a zero. */
function fmtMw(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)} MW`;
}

export function FleetPanel({
  state,
  rows,
  onClose,
  onFocus,
  onMove,
  onLaunchOrbit,
  onStop,
  groups = [],
  activeGroupId = null,
  onGroupSelect,
  onGroupAs,
  onChanged,
  onToast,
}: FleetPanelProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [filter, setFilter] = useState<FleetFilter>(EMPTY_FILTER);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [stopArmed, setStopArmed] = useState(false);
  const [showAllAlerts, setShowAllAlerts] = useState(false);

  const alerts = useMemo(() => alertsFor(rows), [rows]);
  const visible = useMemo(() => sortFleet(filterFleet(rows, filter), sort.key, sort.dir), [rows, filter, sort]);
  const pickedIds = useMemo(() => [...picked].filter((id) => rows.some((r) => r.id === id)), [picked, rows]);
  const allPicked = visible.length > 0 && visible.every((r) => picked.has(r.id));

  const toggleSort = (key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  };

  const toggleRole = (role: FleetRole) => {
    setFilter((prev) => ({
      ...prev,
      roles: prev.roles.includes(role) ? prev.roles.filter((r) => r !== role) : [...prev.roles, role],
    }));
  };

  const togglePick = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exportCsv = () => {
    const csv = fleetCsv(visible);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `fleet-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // E2E probe: the exact bytes offered for download.
    (window as unknown as { __demoCsv?: string }).__demoCsv = csv;
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const alarms = showAllAlerts ? alerts : alerts.slice(0, 4);

  return (
    <aside className="fleet-panel" data-testid="fleet-panel" aria-label="Fleet monitor">
      <header className="fleet-head">
        <div>
          <h2>Fleet</h2>
          <p className="fleet-sub" data-testid="fleet-counts">
            {rows.length} grids · {rows.filter((r) => !r.stale).length} reporting · {alerts.length} alerts
          </p>
        </div>
        <button type="button" className="fleet-close" onClick={onClose} aria-label="Back to the map" data-testid="fleet-close">
          <span className="fleet-x">✕</span>
          <span className="fleet-back-arrow" aria-hidden="true">←</span>
          <span className="fleet-back-text">Back</span>
        </button>
      </header>

      <SurvivalLoopPanel state={state} onFocus={onFocus} onChanged={onChanged} onToast={onToast} />

      {groups.length > 0 && (
        <div className="fleet-groups" data-testid="fleet-groups" aria-label="Groups">
          <span className="muted small">Groups</span>
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className={`group-chip${group.id === activeGroupId ? ' active' : ''}`}
              style={{ borderColor: group.color }}
              data-testid="fleet-group-chip"
              data-id={group.id}
              aria-pressed={group.id === activeGroupId}
              title={`Select all ${group.members.length} members of ${group.name}`}
              onClick={() => onGroupSelect?.(group.id)}
            >
              <i className="group-dot" style={{ background: group.color }} />
              {group.name}
              <span className="group-count">{group.members.length}</span>
            </button>
          ))}
        </div>
      )}

      <section className="fleet-alerts" data-testid="fleet-alerts" aria-label="Fleet alerts">
        {alarms.length === 0 ? (
          <p className="fleet-ok">No active alerts. Every grid is fresh, powered and linked.</p>
        ) : (
          alarms.map((alert: FleetAlert) => (
            <button
              key={alert.id}
              type="button"
              className={`fleet-alert ${alert.severity}`}
              data-testid="fleet-alert"
              data-kind={alert.kind}
              onClick={() => onFocus(alert.nodeId)}
              title={`${alert.why} Suggested action: ${alert.action}`}
            >
              <span className="alert-title">{alert.title}</span>
              <span className="alert-why">{alert.why}</span>
              <span className="alert-action">{alert.action}</span>
            </button>
          ))
        )}
        {alerts.length > alarms.length && (
          <button type="button" className="fleet-more" onClick={() => setShowAllAlerts(true)}>
            +{alerts.length - alarms.length} more alerts
          </button>
        )}
      </section>

      <section className="fleet-filter" aria-label="Filters">
        <div className="role-filter" role="group" aria-label="Role">
          {ROLES.map((role) => (
            <button
              key={role}
              type="button"
              className={`chip${filter.roles.includes(role) ? ' active' : ''}`}
              aria-pressed={filter.roles.includes(role)}
              data-testid={`fleet-role-${role}`}
              onClick={() => toggleRole(role)}
              title={`Show role ${role}`}
            >
              {role}
            </button>
          ))}
        </div>
        <select
          value={filter.states[0] ?? ''}
          aria-label="State"
          data-testid="fleet-state-filter"
          onChange={(e) => setFilter((prev) => ({ ...prev, states: e.target.value ? [e.target.value as FleetState] : [] }))}
        >
          <option value="">All states</option>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="fuel-toggle" title="Show only grids whose hydrogen is below 30 %">
          <input
            type="checkbox"
            checked={filter.maxFuelPct !== null}
            data-testid="fleet-fuel-filter"
            onChange={(e) => setFilter((prev) => ({ ...prev, maxFuelPct: e.target.checked ? 30 : null }))}
          />
          H2 &lt; 30%
        </label>
        <input
          type="search"
          placeholder="Search name, planet, state"
          value={filter.query}
          data-testid="fleet-search"
          onChange={(e) => setFilter((prev) => ({ ...prev, query: e.target.value }))}
          aria-label="Search fleet"
        />
        <button type="button" className="chip" onClick={exportCsv} data-testid="fleet-csv" title="Download the filtered rows as CSV">
          CSV
        </button>
      </section>

      <div className={`fleet-actions${pickedIds.length ? ' visible' : ''}`} data-testid="fleet-actions" aria-hidden={pickedIds.length === 0}>
        <span className="picked-count">{pickedIds.length} selected</span>
        <button type="button" disabled={pickedIds.length === 0} data-testid="fleet-move" onClick={() => onMove(pickedIds)}>
          Move here
        </button>
        <button type="button" disabled={pickedIds.length === 0} data-testid="fleet-launch" onClick={() => onLaunchOrbit(pickedIds)}>
          Launch to orbit
        </button>
        <button type="button" disabled={pickedIds.length === 0} data-testid="fleet-group-as" onClick={() => onGroupAs?.(pickedIds)}>
          Group as…
        </button>
        <button
          type="button"
          disabled
          data-testid="fleet-station"
          title="Station/Ship toggle needs the plugin convert_to_station action (next plugin restart)"
        >
          Station / Ship
        </button>
        <button
          type="button"
          className={stopArmed ? 'danger armed' : 'danger'}
          disabled={pickedIds.length === 0}
          data-testid="fleet-stop"
          onClick={() => {
            if (!stopArmed) {
              setStopArmed(true);
              window.setTimeout(() => setStopArmed(false), 4000);
              return;
            }
            setStopArmed(false);
            onStop(pickedIds);
          }}
          title="Stop every moving grid (kill switch). Click twice to confirm."
        >
          {stopArmed ? 'Confirm STOP' : 'STOP'}
        </button>
      </div>

      <div className="fleet-table-wrap">
        <table className="fleet-table" data-testid="fleet-table" data-rowcount={visible.length}>
          <thead>
            <tr>
              <th className="pick-col">
                <input
                  type="checkbox"
                  aria-label="Select every shown row"
                  checked={allPicked}
                  data-testid="fleet-select-all"
                  onChange={() => {
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (allPicked) for (const r of visible) next.delete(r.id);
                      else for (const r of visible) next.add(r.id);
                      return next;
                    });
                  }}
                />
              </th>
              {COLUMNS.map((col) => (
                <th key={col.key} title={col.title}>
                  <button
                    type="button"
                    className="sort-head"
                    data-testid={`fleet-sort-${col.key}`}
                    aria-sort={sort.key === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    onClick={() => toggleSort(col.key)}
                  >
                    {col.label}
                    {sort.key === col.key ? <span className="sort-dir">{sort.dir === 'asc' ? '▲' : '▼'}</span> : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={row.id}
                className={`fleet-row state-${row.state}${picked.has(row.id) ? ' picked' : ''}`}
                data-testid="fleet-row"
                data-id={row.id}
                data-name={row.name}
                data-state={row.state}
                data-role={row.role ?? ''}
                data-h2={row.h2Pct === null ? '' : row.h2Pct.toFixed(2)}
                onClick={() => onFocus(row.id)}
                title="Click to focus this grid on the map"
              >
                <td className="pick-col" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.name}`}
                    checked={picked.has(row.id)}
                    data-testid="fleet-pick"
                    onChange={() => togglePick(row.id)}
                  />
                </td>
                <td data-label="Name" className="name-cell">
                  {row.name}
                  {row.stale && <span className="stale-dot" title="Telemetry is stale">stale</span>}
                </td>
                <td data-label="Role" title={row.roleLabel}>
                  {row.role ?? <Missing title="No naming tag for this grid" />}
                </td>
                <td data-label="State">
                  <span className={`state-pill ${row.state}`}>{row.state}</span>
                </td>
                <td data-label="Planet" title={row.planet ? `${row.planet} · ${Math.round(row.altitudeM ?? 0)} m AGL` : 'No planet nearby'}>
                  {row.planet ?? <Missing title="No planet metadata" />}
                  {row.altitudeM !== null && <span className="alt"> · {fmtKm(row.altitudeM)}</span>}
                  {row.zeroG && <span className="zero-g" title="At or above the gravity-free altitude">0g</span>}
                </td>
                <td
                  data-label="Links"
                  title={row.linkNames.length ? row.linkNames.join(', ') : 'No links'}
                  className="num"
                  data-sort-value={row.links}
                >
                  {row.links}
                  {row.linkKinds.laser > 0 && <span className="laser-count"> · {row.linkKinds.laser}L</span>}
                </td>
                <td data-label="Radio" className="num" data-sort-value={row.radioRangeM ?? ''}>
                  {row.radioRangeM === null ? <Missing title="The plugin reports no antenna radius" /> : fmtKm(row.radioRangeM)}
                </td>
                <td
                  data-label="Laser ports"
                  className="num"
                  title={row.laserPortsCapacity === 0 ? 'No laser antennas' : `${row.laserPortsUsed} used of ${row.laserPortsCapacity}`}
                  data-sort-value={row.laserPortsFree}
                >
                  {row.laserPortsCapacity === 0 ? '—' : `${row.laserPortsFree}/${row.laserPortsCapacity}`}
                </td>
                <td
                  data-label="Battery"
                  className="num"
                  data-sort-value={row.batteryPct ?? ''}
                  title={
                    row.power.generationMw !== null || row.power.consumerDrawMw !== null
                      ? `generation ${fmtMw(row.power.generationMw)} · consumer draw ${fmtMw(row.power.consumerDrawMw)} · battery input ${fmtMw(row.power.batteryChargeMw)}`
                      : undefined
                  }
                >
                  {row.batteryPct === null ? (
                    <Missing title={row.power.batteryUnreadReason ?? NEEDS_PLUGIN} />
                  ) : (
                    <>
                      <ChargeArrow charge={row.charge} />
                      {fmtPct(row.batteryPct)}
                      {(row.power.generationMw !== null || row.power.consumerDrawMw !== null) && (
                        <span className="muted small" data-testid="power-breakdown">
                          {' '}
                          · gen {fmtMw(row.power.generationMw)} / draw {fmtMw(row.power.consumerDrawMw)}
                        </span>
                      )}
                    </>
                  )}
                </td>
                <td data-label="Solar" className="num" data-sort-value={row.solarPct ?? ''}>
                  {row.solarPct === null ? <Missing /> : fmtPct(row.solarPct)}
                </td>
                <td
                  data-label="H2"
                  className="num"
                  data-sort-value={row.h2Pct ?? ''}
                  title={
                    row.h2Pct === null
                      ? row.power.h2UnreadReason ?? NEEDS_PLUGIN
                      : row.power.h2State === 'read'
                        ? 'Hydrogen fill, capacity-weighted'
                        : row.power.h2UnreadReason ?? undefined
                  }
                >
                  {row.h2Pct === null ? <Missing title={row.power.h2UnreadReason ?? NEEDS_PLUGIN} /> : fmtPct(row.h2Pct)}
                </td>
                <td
                  data-label="Uranium"
                  className="num"
                  data-sort-value={row.uraniumPct ?? ''}
                  title={row.power.uraniumKg !== null ? `${row.power.uraniumKg.toFixed(1)} kg` : NEEDS_PLUGIN}
                >
                  {row.uraniumPct === null ? <Missing /> : fmtPct(row.uraniumPct)}
                </td>
                <td
                  data-label="Expected life"
                  className="num"
                  data-sort-value={row.expectedLife.kind === 'no-limit' ? 'inf' : row.expectedLife.minutes ?? ''}
                  title={row.expectedLife.kind === 'unknown' ? `${NEEDS_PLUGIN} (no battery/H2/reaction runway in telemetry)` : undefined}
                >
                  {fmtRunway(row.expectedLife)}
                </td>
                <td data-label="Last contact" className="num" data-sort-value={row.lastContactAgeMs ?? ''}>
                  {row.lastContactAgeMs === null ? <Missing title="No telemetry" /> : fmtAge(row.lastContactAgeMs)}
                </td>
                <td data-label="Integrity" className="num" data-sort-value={row.integrityPct ?? ''}>
                  {row.integrityPct === null ? <Missing /> : fmtPct(row.integrityPct)}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="empty-row">
                  No grids match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="fleet-note">
        Values marked <span className="missing">—</span> need the plugin power/inventory update; the site never fills them with guesses.
        Battery, solar, H2 and reactor values come straight from live telemetry when present. {state.telemetry.connected ? 'Plugin connected.' : 'Plugin offline.'}
      </p>
    </aside>
  );
}
