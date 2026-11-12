import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Camera } from 'three';
import { api, ApiError, getApiToken, setApiToken } from './api';
import { lockRefusal, SERVER_BADGE, IS_LIVE } from './config';
import type {
  DemoNode,
  DemoState,
  FocusRequest,
  FocusTarget,
  MissionSummary,
  NamingResponse,
  ProvisionState,
  ResetResponse,
  Vec3,
} from './types';
import {
  EMPTY_SELECTION,
  clearSelection,
  clickSelected,
  pruneSelection,
  selectMany,
  selectOnly,
  type SelectionSet,
} from './lib/selectionSet';
import { actionsFor, shipMenuItems, spaceMenuItems, type ActionId, type ContextKey } from './lib/actions';
import { LIVE_MS } from './lib/markers';
import { gridKey } from './lib/pose';
import { gpsFromScreen } from './lib/pick';
import type { DesignerPreview } from './lib/designer';
import { gpsStringFor } from './lib/flows';
import { fetchTerrainPlanets, fetchWorldManifest } from './lib/worldApi';
import { installRightClickGate, mapRightClick } from './lib/rightClick';
import type { TerrainPlanet, WorldManifest } from './lib/worldMapTypes';
import { Scene, webglAvailable, type Overlays } from './components/Scene';
import { MapOverlay } from './components/MapOverlay';
import { ActionBar } from './components/ActionBar';
import { Breadcrumb } from './components/Breadcrumb';
import { PickList } from './components/PickList';
import { ShipSearchPanel } from './components/ShipSearchPanel';
import { ContextMenu, type ContextMenuState } from './components/ContextMenu';
import type { CameraApi } from './components/CameraControls';
import {
  contextDescription,
  resolveContext,
  planetAtPoint,
  type CameraContext,
  type ContextTarget,
  type ContextWorld,
} from './lib/cameraContext';
import {
  breadcrumb as breadcrumbFor,
  enterContext as enterContextStack,
  exitContext as exitContextStack,
  initialStack,
  jumpToLevel,
  poseFor,
  savePose,
  sessionAfterClick,
  stackDepth,
  topTarget,
  type CameraStackState,
  type ContextPose,
} from './lib/contextStack';
import { pickNodes, pickRadiusPx, type ScreenNode } from './lib/pickShips';
import { distanceBetween, planFocusPose } from './lib/camera';
import { MoveFlow } from './components/MoveFlow';
import { LaunchFlow } from './components/LaunchFlow';
import { NetworkPanel } from './components/NetworkPanel';
import { HelpOverlay } from './components/HelpOverlay';
import { MissionStrip } from './components/MissionStrip';
import { Toasts, type ToastItem } from './components/Toasts';
import { FleetPanel } from './components/FleetPanel';
import { OpsPanel, SurvivalBadge } from './components/OpsPanel';
import { readSurvivalMode, type OpsTab } from './lib/ops';
import { GroupsPanel, type GroupBulkAction } from './components/GroupsPanel';
import { LayersPanel } from './components/LayersPanel';
import { RolePanel } from './components/RolePanel';
import { ConstellationPanel } from './components/ConstellationPanel';
import { terrainPlanetFor, useTerrainTileReady, type CoverageDatum } from './components/CoverageLayer';
import { coverageTerrainNotice } from './lib/coverageMesh';
import { buildFleetRows } from './lib/fleet';
import {
  bracketFor,
  groupsReducer,
  loadLocalGroups,
  newGroupId,
  parseGroups,
  saveLocalGroups,
  type ShipGroup,
} from './lib/groups';
import { EMPTY_LINKS, type LinkMode, type LinksResponse } from './lib/links';
import { explainCell, latLonToCell, type CoverageCell } from './lib/coverage';
import { PULSE_PERIOD_S, PULSE_PERIOD_SLOW_S } from './lib/rings';

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return `${err.message}${err.hint ? ` — ${err.hint}` : ''}`;
  return err instanceof Error ? err.message : 'unexpected error';
}

/**
 * UI chrome that sits INSIDE the stage but is not map surface. Pointer events
 * from these must never reach the stage handlers (a click on the action bar was
 * clearing the selection through the pick path).
 */
const STAGE_CHROME =
  '.hud-top, .breadcrumb, .action-bar, .sheet, .flow-panel, .fleet-panel, .ops-panel, .groups-panel, .layers-panel, ' +
  '.mission-strip, .pick-list, .context-menu, .coverage-popover, .toasts, .scene-hint, .modal-backdrop, .hover-hint';

function isStageChrome(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest?.(STAGE_CHROME));
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function Lockdown({ reason }: { reason: string }) {
  return (
    <div className="lockdown" role="alert" data-testid="lockdown">
      <h1>Demo site locked</h1>
      <p>{reason}</p>
      <p className="muted">This build refuses to run without a target environment. There is no production fallback by design.</p>
    </div>
  );
}

function TokenGate({ onSubmit, error }: { onSubmit: (token: string) => void; error: string | null }) {
  const [value, setValue] = useState('');
  return (
    <div className="boot token-gate" data-testid="token-gate">
      <h1>{SERVER_BADGE}</h1>
      <p>This LAN-only demo needs the backend bearer token once. It is stored in this browser and never embedded in the build.</p>
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <label>
          Backend token
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="paste the token from <token-file>"
            autoComplete="off"
            data-testid="token-input"
          />
        </label>
        <button type="submit" disabled={!value.trim()} data-testid="token-submit">
          Use token
        </button>
      </form>
      {error && (
        <p className="error" data-testid="token-error">
          {error}
        </p>
      )}
      <p className="muted small">The token file is readable only by the owner on the test host. Never publish this page beyond the LAN.</p>
    </div>
  );
}

function ResetDialog({ onClose, onDone }: { onClose: () => void; onDone: (result: ResetResponse) => void }) {
  const [snapshot, setSnapshot] = useState(`manual-${new Date().toISOString().slice(0, 16)}`);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.reset(snapshot, confirm));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Reset world" data-testid="reset-dialog">
      <div className="modal">
        <header className="modal-head">
          <h2>Reset test world</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <p>
          This creates a <strong>reset mission only</strong>. Type <code>RESET</code> to confirm.
        </p>
        <label>
          Snapshot
          <input value={snapshot} onChange={(e) => setSnapshot(e.target.value)} data-testid="reset-snapshot" />
        </label>
        <label>
          Type RESET
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="reset-confirm" placeholder="RESET" />
        </label>
        {error && (
          <p className="error" data-testid="reset-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            disabled={confirm !== 'RESET' || busy || !snapshot.trim()}
            onClick={() => void submit()}
            data-testid="reset-submit"
          >
            {busy ? 'Creating…' : 'Create reset mission'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameDialog({ node, current, onClose, onDone }: { node: DemoNode; current: string; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState(current);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Rename ship" data-testid="rename-dialog">
      <div className="modal small">
        <header className="modal-head">
          <h2>Rename ship</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <p className="muted small">The game and the site share this name. A manual in-game rename becomes the owner override.</p>
        <input value={name} onChange={(e) => setName(e.target.value)} data-testid="rename-input" autoFocus />
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!name.trim()} onClick={() => onDone(name.trim())} data-testid="rename-submit">
            Rename
          </button>
        </div>
      </div>
    </div>
  );
}

type Flow =
  | { kind: 'move'; ids: string[]; picked: Vec3 | null; preset: 'orbit-zero-g' | 'orbit-low' | null; picking: boolean }
  | { kind: 'launch'; ids: string[] };

export default function App() {
  const refusal = lockRefusal();
  const [state, setState] = useState<DemoState | null>(null);
  const [naming, setNaming] = useState<NamingResponse>({ grids: [] });
  const [bases, setBases] = useState<ProvisionState['bases']>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectionSet>(EMPTY_SELECTION);
  /** camera level stack (system -> planet -> group -> ship) */
  const [cameraStack, setCameraStack] = useState<CameraStackState>(() => initialStack());
  const [finderOpen, setFinderOpen] = useState(false);
  const [pickList, setPickList] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [overlays, setOverlays] = useState<Overlays>({
    radioSpheres: false,
    radioRings: false,
    coverage: false,
    linkMode: 'current',
    laserLinks: true,
    reachableColours: true,
    labels: true,
    terrain: true,
    shapes: true,
    blockByFunction: false,
  });
  const [showStale, setShowStale] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Archived telemetry (rows >6 h old) is fetched only on demand: the default
  // state no longer carries hundreds of phantom historical ships.
  const [showArchived, setShowArchived] = useState(false);
  const [archivedNodes, setArchivedNodes] = useState<DemoNode[]>([]);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [context, setContext] = useState<ContextMenuState | null>(null);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [fleetOpen, setFleetOpen] = useState(false);
  /** T51/T60 operator screens: one panel, four tabs (alerts/optimise/send/fleet). */
  const [opsOpen, setOpsOpen] = useState(false);
  const [opsTab, setOpsTab] = useState<OpsTab>('alerts');
  /** `survivalMode` from /api/health or /api/demo/state; absent = show nothing. */
  const [survivalMode, setSurvivalMode] = useState<boolean | null>(null);
  const [flyMode, setFlyMode] = useState(false);
  const [pulseSpeed, setPulseSpeed] = useState<'slow' | 'normal' | 'off'>('normal');
  const [helpOpen, setHelpOpen] = useState(false);
  const [dangerOpen, setDangerOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<DemoNode | null>(null);
  const [followId, setFollowId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [comingSoon, setComingSoon] = useState<ActionId[]>([]);
  const [preview, setPreview] = useState<DesignerPreview | null>(null);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [token, setToken] = useState(() => getApiToken());
  /** TEST-world geometry (read-only proxy); absent until the first fetch lands. */
  const [manifest, setManifest] = useState<WorldManifest | null>(null);
  const [terrainPlanets, setTerrainPlanets] = useState<TerrainPlanet[] | null>(null);
  const [drawnIds, setDrawnIds] = useState<string[]>([]);
  const [shapesError, setShapesError] = useState<string | null>(null);
  const [groups, setGroups] = useState<ShipGroup[]>(() => loadLocalGroups(typeof localStorage === 'undefined' ? null : localStorage));
  const [groupsServer, setGroupsServer] = useState<'checking' | 'ok' | 'local'>('checking');
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupAsStart, setGroupAsStart] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [linksData, setLinksData] = useState<LinksResponse | null>(null);
  const [linksAvailable, setLinksAvailable] = useState<'checking' | 'ok' | 'missing'>('checking');
  const [coveragePlanet, setCoveragePlanet] = useState('EarthLike');
  const [coverageData, setCoverageData] = useState<CoverageDatum | null>(null);
  const [previewCoverage, setPreviewCoverage] = useState<{ planet: string; cells: CoverageCell[]; k: 1 | 2 } | null>(null);
  // T51.2: a non-empty preview outranks the live heatmap so the map shows the
  // PROPOSED layout; closing the panel (or an empty payload) restores live.
  const previewCoverageData = useMemo<CoverageDatum | null>(() => {
    if (!previewCoverage || previewCoverage.cells.length === 0) return null;
    return {
      planet: previewCoverage.planet,
      response: {
        planet: previewCoverage.planet,
        mode: 'cover-planet',
        k: previewCoverage.k,
        cellDeg: 10,
        cells: previewCoverage.cells,
        labels: ['SIMULATED', 'PREVIEW'],
      },
    };
  }, [previewCoverage]);
  const [coverageAvailable, setCoverageAvailable] = useState<'checking' | 'ok' | 'missing'>('checking');
  // T51.10: the heatmap drapes on the terrain when heights exist. When the
  // planner says terrain is unavailable (or nothing is decoded yet) the layer
  // drops to the smooth shell and the legend must say so, never stay silent.
  const coverageTerrainPlanet = useMemo(
    () => terrainPlanetFor(terrainPlanets, state?.planets.find((p) => p.name === coveragePlanet) ?? null, coveragePlanet),
    [terrainPlanets, state, coveragePlanet],
  );
  const coverageTerrainReady = useTerrainTileReady(coverageTerrainPlanet?.id ?? null);
  const responseApproximate = coverageData
    ? coverageTerrainNotice(coverageData.response.terrain, coverageTerrainReady)
    : null;
  // The layer's own report wins: it knows when only part of the planet had
  // heights (mixed) and the legend must not upgrade that to "exact".
  const [coverageLayerReport, setCoverageLayerReport] = useState<{ notice: string | null } | null>(null);
  const onCoverageTerrainReport = useCallback((notice: string | null) => {
    setCoverageLayerReport((prev) => (prev && prev.notice === notice ? prev : { notice }));
  }, []);
  const coverageApproximate = coverageLayerReport ? coverageLayerReport.notice : responseApproximate;
  const [cellPick, setCellPick] = useState<{ planet: string; latDeg: number; lonDeg: number } | null>(null);
  const [constellationFor, setConstellationFor] = useState<string | null>(null);
  const [fixPrefill, setFixPrefill] = useState<{ planet: string; latDeg: number; lonDeg: number; altitudeM: number | null } | null>(null);
  const [hullIds, setHullIds] = useState<string[]>([]);

  const cameraRef = useRef<Camera | null>(null);
  const cameraApi = useRef<CameraApi | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const framedOnce = useRef(false);
  /** set by the ship/marker handlers so the stage does not also open a point menu */
  const deepMenu = useRef(false);
  const lastFocusAt = useRef(0);
  const dragRef = useRef<{ x: number; y: number; shift: boolean; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const toastId = useRef(1);
  const pollRef = useRef(2000);

  const pushToast = useCallback((kind: ToastItem['kind'], text: string, hint: string | null = null) => {
    const id = toastId.current++;
    setToasts((prev) => [...prev.slice(-2), { id, kind, text, hint }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === 'err' ? 9000 : 6000);
  }, []);

  const markComingSoon = useCallback(
    (action: ActionId) => {
      setComingSoon((prev) => (prev.includes(action) ? prev : [...prev, action]));
      pushToast('info', 'That backend route is not deployed yet.', 'This action is coming soon; nothing was sent.');
    },
    [pushToast],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await api.state();
      setState(next);
      pollRef.current = next.telemetry.pollMs || 2000;
      setError(null);
      const ids = next.nodes.map((n) => n.id);
      setSelected((prev) => pruneSelection(prev, ids));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setApiToken('');
        setToken('');
        setError('401: token rejected or missing');
        return;
      }
      setError(messageOf(err));
    }
  }, []);

  const refreshAux = useCallback(async () => {
    try {
      setNaming(await api.naming());
    } catch {
      /* naming is optional UI sugar */
    }
    try {
      const prov = await api.provisionState();
      setBases(prov.bases ?? []);
    } catch {
      /* provisioning route is optional */
    }
  }, []);

  useEffect(() => {
    if (refusal || !token) return;
    void refresh();
    void refreshAux();
    const timer = window.setInterval(() => void refresh(), pollRef.current);
    const aux = window.setInterval(() => void refreshAux(), 15000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(aux);
    };
  }, [refresh, refreshAux, refusal, token]);

  // ---- groups: server first, localStorage as the honest fallback ----
  useEffect(() => {
    if (refusal || !token) return;
    let cancelled = false;
    api
      .groups()
      .then(async (body) => {
        if (cancelled) return;
        const remote = parseGroups(body);
        if (remote.length > 0) {
          setGroups(remote);
          setGroupsServer('ok');
          return;
        }
        // The route is live and the server has no groups. If this browser still
        // holds groups from before the route existed, push them once so the UI
        // can keep saying "saved on the server" truthfully.
        const local = loadLocalGroups(typeof localStorage === 'undefined' ? null : localStorage);
        if (local.length === 0) {
          setGroups([]);
          setGroupsServer('ok');
          return;
        }
        try {
          for (const group of local) await api.groupCreate(group);
          if (cancelled) return;
          setGroups(local);
          setGroupsServer('ok');
        } catch {
          if (!cancelled) setGroupsServer('local');
        }
      })
      .catch(() => {
        if (!cancelled) setGroupsServer('local');
      });
    return () => {
      cancelled = true;
    };
  }, [refusal, token]);

  // ---- T51/T60: survival badge + one side panel at a time ----
  useEffect(() => {
    if (refusal || !token) return;
    let cancelled = false;
    api
      .health()
      .then((body) => {
        if (!cancelled) setSurvivalMode(readSurvivalMode(body, null));
      })
      .catch(() => {
        /* /api/health may not exist yet; /api/demo/state below is the fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [refusal, token]);

  useEffect(() => {
    // The field is being added by another job: absent means nothing is shown.
    const fromState = readSurvivalMode(state, null);
    if (fromState !== null) setSurvivalMode(fromState);
  }, [state]);

  useEffect(() => {
    if (!opsOpen) return;
    if (finderOpen || fleetOpen || networkOpen || groupsOpen || layersOpen) setOpsOpen(false);
  }, [opsOpen, finderOpen, fleetOpen, networkOpen, groupsOpen, layersOpen]);

  useEffect(() => {
    saveLocalGroups(typeof localStorage === 'undefined' ? null : localStorage, groups);
  }, [groups]);

  // Hull profiles drive the constellation planner's slot geometry.
  useEffect(() => {
    if (refusal || !token) return;
    api
      .designerHulls()
      .then((res) => setHullIds(res.hulls.map((h) => h.id)))
      .catch(() => setHullIds([]));
  }, [refusal, token]);

  // Default the coverage planet to a planet the test world actually has.
  useEffect(() => {
    const planets = state?.planets ?? [];
    if (planets.length === 0) return;
    if (!planets.some((p) => p.name === coveragePlanet)) setCoveragePlanet(planets[0]!.name);
  }, [state, coveragePlanet]);

  // Links overlay: poll only while a mode that draws them is selected.
  const linkPlanetName = state?.planets.find((p) => p.name === 'EarthLike')?.name ?? state?.planets[0]?.name ?? 'EarthLike';
  useEffect(() => {
    if (refusal || !token || overlays.linkMode === 'off') return;
    let cancelled = false;
    const planetName = linkPlanetName;
    const load = () => {
      api
        .links(planetName)
        .then((res) => {
          if (cancelled) return;
          setLinksData(res);
          setLinksAvailable('ok');
        })
        .catch((err) => {
          if (cancelled) return;
          if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
            setLinksAvailable('missing');
            setLinksData(null);
          }
        });
    };
    load();
    const timer = window.setInterval(load, 7000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refusal, token, overlays.linkMode, linkPlanetName]);

  // Coverage heatmap: one grid per planet; refetched on planet change / toggle.
  useEffect(() => {
    if (refusal || !token || (!overlays.coverage && !layersOpen)) return;
    let cancelled = false;
    const load = () => {
      api
        .coverage({ planet: coveragePlanet, mode: 'cover-planet', k: 1, cellDeg: 10 })
        .then((res) => {
          if (cancelled) return;
          setCoverageData({ planet: coveragePlanet, response: res });
          setCoverageAvailable('ok');
        })
        .catch((err) => {
          if (cancelled) return;
          if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
            setCoverageAvailable('missing');
            setCoverageData(null);
          }
        });
    };
    load();
    const timer = window.setInterval(load, 9000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refusal, token, overlays.coverage, layersOpen, coveragePlanet]);

  // TEST-world geometry: the save manifest (shape data) and terrain planet
  // list come from the GET-only /api/demo/world|terrain proxy. Polling the
  // manifest slowly is enough; a new autosave swaps the save hash and the
  // layers drop their decoded bytes.
  useEffect(() => {
    if (refusal || !token) return;
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchWorldManifest();
        if (!cancelled) {
          setManifest(next);
          setShapesError(null);
        }
      } catch (err) {
        if (!cancelled) setShapesError(err instanceof Error ? err.message : 'shape geometry unavailable');
      }
      try {
        const planets = await fetchTerrainPlanets();
        if (!cancelled) setTerrainPlanets(planets.planets ?? []);
      } catch {
        if (!cancelled) setTerrainPlanets((prev) => prev ?? []);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refusal, token]);

  const onDrawn = useCallback((ids: string[]) => {
    setDrawnIds((prev) => (prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids));
  }, []);

  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const g of naming.grids) map[g.gridId] = g.name;
    return map;
  }, [naming]);

  // Hull sizes for marker anchoring: bbox diagonal per node id (CONTRACT-HULL).
  const hullM = useMemo(() => {
    const map: Record<string, number> = {};
    for (const g of manifest?.grids ?? []) {
      const b = g.bbox_local;
      if (!b?.min || !b?.max) continue;
      map[`grid:${g.id}`] = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    }
    return map;
  }, [manifest]);

  // One-time framing: live grids if any, else EarthLike. Never re-run by polling.
  useEffect(() => {
    if (!state || framedOnce.current) return;
    framedOnce.current = true;
    const live = state.nodes.filter((n) => n.source === 'GAME' && n.telemetry && n.telemetry.ageMs <= LIVE_MS);
    const planet = state.planets.find((p) => p.name === 'EarthLike') ?? state.planets[0] ?? null;
    if (live.length > 0) {
      const cx = live.reduce((s, n) => s + n.position.x, 0) / live.length;
      const cy = live.reduce((s, n) => s + n.position.y, 0) / live.length;
      const cz = live.reduce((s, n) => s + n.position.z, 0) / live.length;
      let spread = 0;
      for (const n of live) spread = Math.max(spread, Math.hypot(n.position.x - cx, n.position.y - cy, n.position.z - cz));
      setFocus({
        nonce: Date.now(),
        target: { id: 'live-grids', label: `${live.length} live grids`, pos: { x: cx, y: cy, z: cz }, radiusKm: Math.max(2, (spread / 1000) * 1.2) },
      });
    } else if (planet) {
      setFocus({
        nonce: Date.now(),
        target: { id: planet.id, label: planet.name, pos: planet.center, radiusKm: planet.maxHillRadiusM / 1000 },
      });
    }
  }, [state]);

  const webgl = useMemo(() => webglAvailable(), []);

  const planetMidUnits = useMemo(() => {
    const planets = state?.planets ?? [];
    if (planets.length === 0) return { x: 0, y: 0, z: 0 };
    const xs = planets.map((p) => p.center.x);
    const ys = planets.map((p) => p.center.y);
    const zs = planets.map((p) => p.center.z);
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2 / 1000,
      y: (Math.min(...ys) + Math.max(...ys)) / 2 / 1000,
      z: (Math.min(...zs) + Math.max(...zs)) / 2 / 1000,
    };
  }, [state]);

  // Default view: live + named + bases + reachable fixtures. 228 unrelated
  // grids were the main source of "VERY complicated"; they stay one click away.
  const visibleNodes = useMemo(() => {
    const nodes = showArchived && archivedNodes.length ? [...(state?.nodes ?? []), ...archivedNodes] : state?.nodes ?? [];
    if (showAll) return nodes;
    return nodes.filter((n) => {
      const name = names[n.id] ?? n.name;
      if (n.controlSource) return true;
      if (n.source === 'GAME') {
        if (n.telemetry && n.telemetry.ageMs <= LIVE_MS) return true;
        return showStale;
      }
      return /^SAT-|^BASE-/.test(name) || n.reachable;
    });
  }, [state, showAll, showStale, showArchived, archivedNodes, names]);

  useEffect(() => {
    if (!showArchived) return;
    let cancelled = false;
    api
      .state({ archived: true })
      .then((next) => {
        if (cancelled) return;
        // Only the extras: the live poll owns the recent rows.
        const live = new Set((state?.nodes ?? []).map((n) => n.id));
        setArchivedNodes(next.nodes.filter((n) => !live.has(n.id)));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

  const selectedNodes = useMemo(
    () => (state ? state.nodes.filter((n) => selected.ids.includes(n.id)) : []),
    [state, selected],
  );
  // T21 fleet rows: same set the map shows, so "rows == live tagged grids".
  const fleetRows = useMemo(
    () => (state ? buildFleetRows(state, visibleNodes, naming.grids) : []),
    [state, visibleNodes, naming.grids],
  );
  // Camera context: resolved from the STACK (system / planet / group / ship),
  // never from the selection. Selecting a ship must not re-aim the camera —
  // that was the "behaves differently depending on what you click" report.
  const world = useMemo<ContextWorld>(
    () => ({
      planets: state?.planets ?? [],
      nodes: state?.nodes ?? [],
      groups,
      names,
    }),
    [state?.planets, state?.nodes, groups, names],
  );
  const camContext: CameraContext = useMemo(
    () =>
      resolveContext(topTarget(cameraStack), world) ??
      resolveContext({ kind: 'system', id: 'system', upMode: 'gravity' }, world)!,
    [cameraStack, world],
  );
  const crumbs = useMemo(() => breadcrumbFor(cameraStack, world), [cameraStack, world]);
  const contextNote = contextDescription(camContext);
  const pivot = useMemo(
    () => ({
      id: camContext.key,
      label: camContext.label,
      pos: { x: camContext.pivot.x * 1000, y: camContext.pivot.y * 1000, z: camContext.pivot.z * 1000 },
    }),
    [camContext],
  );
  const pivotLabel = camContext.label;
  const pulsePeriod = pulseSpeed === 'off' ? null : pulseSpeed === 'slow' ? PULSE_PERIOD_SLOW_S : PULSE_PERIOD_S;
  const followNode = state && followId ? state.nodes.find((n) => n.id === followId) ?? null : null;
  /** A ship level is glued to its grid: the pivot tracks the live position. */
  const shipAnchor =
    state && camContext.kind === 'ship' ? state.nodes.find((n) => n.id === camContext.id) ?? null : null;
  const followPos = followNode?.position ?? shipAnchor?.position ?? null;
  // A closed launch flow must not leave its planner preview dots on the map.
  useEffect(() => {
    if (flow?.kind !== 'launch') setPreview(null);
  }, [flow]);
  const heartbeatAgeMs = state?.plugin.lastHeartbeatAgeMs ?? state?.telemetry.latestAgeMs ?? null;
  const linkFresh = Boolean(state?.telemetry.connected && heartbeatAgeMs !== null && heartbeatAgeMs <= 60_000);
  const liveCount = state ? state.nodes.filter((n) => n.source === 'GAME' && n.telemetry && n.telemetry.ageMs <= LIVE_MS).length : 0;
  const hiddenCount = state ? state.nodes.length - visibleNodes.length : 0;

  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? null;
  const activeGroupMembers = useMemo(
    () => (activeGroup ? activeGroup.members.filter((id) => state?.nodes.some((n) => n.id === id)) : []),
    [activeGroup, state],
  );
  /** Coloured bracket in scene kilometres, null when no chip is active. */
  const groupBracket = useMemo(() => {
    if (!activeGroup || !state) return null;
    const points = state.nodes.filter((n) => activeGroup.members.includes(n.id)).map((n) => n.position);
    const box = bracketFor(points);
    if (!box) return null;
    const km = (v: number) => v / 1000;
    return {
      color: activeGroup.color,
      center: { x: km(box.center.x), y: km(box.center.y), z: km(box.center.z) },
      size: { x: km(box.size.x), y: km(box.size.y), z: km(box.size.z) },
      members: box.members,
    };
  }, [activeGroup, state]);

  const coverageCell = useMemo(() => {
    if (!cellPick || !coverageData || coverageData.planet !== cellPick.planet) return null;
    return latLonToCell(coverageData.response.cells ?? [], cellPick.latDeg, cellPick.lonDeg, coverageData.response.cellDeg ?? 10);
  }, [cellPick, coverageData]);
  const coveragePlanetObj = cellPick ? state?.planets.find((p) => p.name === cellPick.planet) ?? null : null;
  const coverageWhy = coverageCell && coverageData && coveragePlanetObj
    ? explainCell(coverageCell, {
        tiers: coverageData.response.tiers,
        reasons: coverageData.response.reasons,
        surfaceRadiusM: coveragePlanetObj.surfaceRadiusM,
      })
    : null;

  const persistGroup = useCallback(
    async (group: ShipGroup, mode: 'create' | 'update' | 'delete') => {
      if (groupsServer !== 'ok') return;
      try {
        if (mode === 'create') await api.groupCreate(group);
        else if (mode === 'delete') await api.groupDelete(group.id);
        else await api.groupUpdate(group.id, { name: group.name, color: group.color, members: group.members });
      } catch {
        setGroupsServer('local');
      }
    },
    [groupsServer],
  );

  const createGroup = (name: string, color: string) => {
    const group: ShipGroup = { id: newGroupId(), name, color, members: selected.ids.slice() };
    setGroups((prev) => groupsReducer(prev, { type: 'add', ...group }));
    setActiveGroupId(group.id);
    void persistGroup(group, 'create');
    pushToast('ok', `${name} created.`, `${group.members.length} ship(s) · saved ${groupsServer === 'ok' ? 'on the server' : 'in this browser only'}`);
  };

  const updateGroup = (id: string, patch: { name?: string; color?: string; members?: string[] }) => {
    setGroups((prev) => {
      let next = prev;
      if (patch.name !== undefined) next = groupsReducer(next, { type: 'rename', id, name: patch.name });
      if (patch.color !== undefined) next = groupsReducer(next, { type: 'recolor', id, color: patch.color });
      if (patch.members !== undefined) next = groupsReducer(next, { type: 'members', id, members: patch.members });
      const group = next.find((g) => g.id === id);
      if (group) void persistGroup(group, 'update');
      return next;
    });
  };

  const deleteGroup = (id: string) => {
    const group = groups.find((g) => g.id === id);
    setGroups((prev) => groupsReducer(prev, { type: 'delete', id }));
    if (activeGroupId === id) setActiveGroupId(null);
    if (constellationFor === id) setConstellationFor(null);
    if (group) void persistGroup(group, 'delete');
  };

  const selectGroup = (id: string | null) => {
    setActiveGroupId(id);
    const group = groups.find((g) => g.id === id);
    if (group) {
      setSelected(selectMany(group.members, false, EMPTY_SELECTION));
    }
  };

  const groupBulk = (group: ShipGroup, action: GroupBulkAction) => {
    if (action === 'move') openMove(group.members);
    else if (action === 'launch') openMove(group.members, 'orbit-zero-g');
    else if (action === 'station') {
      pushToast('info', 'Station / Ship is coming soon.', 'The plugin has no convert_to_station action yet; nothing was sent.');
    } else {
      api
        .groupStop(group.id, group.members)
        .then((res) => {
          const skipped = res.skipped ?? [];
          const stopped = res.stopped ?? group.members.length;
          const why = skipped
            .slice(0, 3)
            .map((s) => `${s.gridId.replace(/^grid:/, '').slice(0, 10)}: ${s.reason}`)
            .join(' · ');
          if (stopped === 0) {
            pushToast('info', `No stop sent to ${group.name}.`, why || res.note || 'Nothing was commandable.');
          } else {
            pushToast(
              'ok',
              `Stop sent to ${stopped} of ${group.members.length} in ${group.name}.`,
              skipped.length ? `${skipped.length} skipped · ${why}` : res.note ?? `Only its ${group.members.length} member(s) were addressed.`,
            );
          }
          void refresh();
        })
        .catch((err) => {
          if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
            pushToast('info', 'Scoped stop is coming soon.', 'Nothing was sent. The global STOP sits under the map.');
            return;
          }
          pushToast('err', 'Group stop failed.', messageOf(err));
        });
    }
  };

  const openConstellation = (groupId: string, fix: { planet: string; latDeg: number; lonDeg: number; altitudeM: number | null } | null = null) => {
    setFixPrefill(fix);
    setConstellationFor(groupId);
    setGroupsOpen(false);
    setLayersOpen(false);
    setFleetOpen(false);
    setNetworkOpen(false);
    setFlow(null);
  };

  const focusNode = useCallback(
    (id: string) => {
      const node = state?.nodes.find((n) => n.id === id);
      if (!node) return;
      lastFocusAt.current = Date.now();
      setSelected(selectOnly(node.id));
      setFollowId(null);
      // Frame by the grid's real extent: a 10 m drone needs a 25 m stand-off to
      // show blocks, a 300 m station needs a few hundred. Fixed framing either
      // hides small hulls in a few pixels or clips large ones.
      const grid = manifest?.grids.find((g) => g.id === gridKey(node.id));
      let radiusKm = 0.15;
      if (grid?.bbox_local?.min && grid.bbox_local.max) {
        const b = grid.bbox_local;
        const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
        if (Number.isFinite(span) && span > 0) radiusKm = Math.min(1.5, Math.max(0.004, span / 2000));
      }
      setFocus({
        nonce: Date.now(),
        target: { id: node.id, label: names[node.id] ?? node.name, pos: node.position, radiusKm },
      });
    },
    [state, names, manifest],
  );

  const focusPoint = useCallback((pos: Vec3, label: string, radiusKm: number) => {
    lastFocusAt.current = Date.now();
    const target: FocusTarget = { id: `point-${label}`, label, pos, radiusKm };
    setFocus({ nonce: Date.now(), target });
  }, []);

  const clearAll = useCallback(() => {
    setSelected(clearSelection());
    setContext(null);
    setFollowId(null);
  }, []);

  // ---------------------------------------------------------------------
  // Camera contexts. Only these three paths move the camera level; a single
  // click never reaches them.
  // ---------------------------------------------------------------------
  const currentPose = useCallback((): ContextPose => cameraApi.current?.pose() ?? { yaw: 0, pitch: 0, distance: 20 }, []);

  /** Framing radius for a level (ships are framed by their real hull span). */
  const radiusForContext = useCallback(
    (entry: CameraContext): number => {
      if (entry.kind !== 'ship') return entry.radiusKm;
      const grid = manifest?.grids.find((g) => g.id === gridKey(entry.id));
      const b = grid?.bbox_local;
      if (b?.min && b.max) {
        const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
        if (Number.isFinite(span) && span > 0) return Math.min(1.5, Math.max(0.004, span / 2000));
      }
      return entry.radiusKm;
    },
    [manifest],
  );

  const framedDistance = useCallback(
    (entry: CameraContext): number => {
      const goal = planFocusPose(
        {
          id: entry.key,
          label: entry.label,
          pos: { x: entry.pivot.x * 1000, y: entry.pivot.y * 1000, z: entry.pivot.z * 1000 },
          radiusKm: radiusForContext(entry),
        },
        state?.planets ?? [],
        { minDistance: 0.02 },
      );
      return distanceBetween(goal.pos, goal.target);
    },
    [radiusForContext, state?.planets],
  );

  /** Explicit entry: double-click, the Focus button, or a list pick. */
  const enterCameraContext = useCallback(
    (target: ContextTarget) => {
      const entry = resolveContext(target, world);
      if (!entry) {
        pushToast('info', 'That level is not available.', 'The grid, planet or group is no longer in the world.');
        return;
      }
      const pose = currentPose();
      setCameraStack((prev) => enterContextStack(prev, target, pose));
      cameraApi.current?.enter(entry, framedDistance(entry));
      setPickList(null);
    },
    [world, currentPose, framedDistance, pushToast],
  );

  /** Esc: exactly one level out, with that level's saved pose back. */
  const exitCameraContext = useCallback((): boolean => {
    if (stackDepth(cameraStack) <= 1) return false;
    const { state: next, parent, restored } = exitContextStack(cameraStack, currentPose());
    if (!parent) return false;
    const entry = resolveContext(parent, world);
    setCameraStack(next);
    if (entry) {
      const fallback = currentPose();
      cameraApi.current?.restore(entry, restored ?? { ...fallback, distance: Math.max(0.5, fallback.distance * 4) });
    }
    setPickList(null);
    return true;
  }, [cameraStack, currentPose, world]);

  /** Breadcrumb click: jump to an ancestor level (restoring its pose). */
  const jumpCameraLevel = useCallback(
    (index: number) => {
      const { state: next, target, restored } = jumpToLevel(cameraStack, index, currentPose());
      if (!target) return;
      const entry = resolveContext(target, world);
      setCameraStack(next);
      if (entry) {
        const fallback = currentPose();
        cameraApi.current?.restore(entry, restored ?? { ...fallback, distance: Math.max(0.5, fallback.distance * 4) });
      }
      setPickList(null);
    },
    [cameraStack, currentPose, world],
  );

  // A level whose object despawned falls back one level instead of orbiting a
  // ghost position.
  useEffect(() => {
    if (stackDepth(cameraStack) === 1) return;
    if (resolveContext(topTarget(cameraStack), world)) return;
    setCameraStack((prev) => exitContextStack(prev, currentPose()).state);
  }, [cameraStack, world, currentPose]);

  const openMove = useCallback(
    (ids: string[], preset: 'orbit-zero-g' | 'orbit-low' | null = null, picked: Vec3 | null = null) => {
      if (ids.length === 0) {
        pushToast('info', 'Select a ship first.', 'Click a ship, shift-click to add, or drag a box.');
        return;
      }
      setContext(null);
      setNetworkOpen(false);
      setFleetOpen(false);
      setGroupsOpen(false);
      setLayersOpen(false);
      setConstellationFor(null);
      setFlow({ kind: 'move', ids, picked, preset, picking: false });
    },
    [pushToast],
  );

  const openLaunch = useCallback((ids: string[]) => {
    setContext(null);
    setNetworkOpen(false);
    setFleetOpen(false);
    setGroupsOpen(false);
    setLayersOpen(false);
    setConstellationFor(null);
    setFlow({ kind: 'launch', ids });
  }, []);

  const onAction = (id: ActionId) => {
    switch (id) {
      case 'launch-satellites':
        openLaunch(selected.ids);
        break;
      case 'network':
        setNetworkOpen((v) => !v);
        break;
      case 'move':
      case 'move-here':
        openMove(selected.ids);
        break;
      case 'launch-orbit':
        openMove(selected.ids, 'orbit-zero-g');
        break;
      case 'form-network':
        openLaunch(selected.ids);
        break;
      case 'follow': {
        const primary = selected.primary ?? selected.ids[0] ?? null;
        if (!primary) {
          pushToast('info', 'Select a ship to follow.');
          return;
        }
        setFollowId((current) => (current === primary ? null : primary));
        pushToast('ok', `Following ${names[primary] ?? primary}.`, 'Esc stops following.');
        break;
      }
      default:
        break;
    }
  };

  const copyGps = async (name: string, pos: Vec3) => {
    const text = gpsStringFor(name, pos);
    try {
      await navigator.clipboard.writeText(text);
      pushToast('ok', 'GPS copied.', text);
    } catch {
      pushToast('info', 'Clipboard is blocked in this browser.', text);
    }
  };

  const teleport = async (pos: Vec3) => {
    try {
      await api.teleport(pos);
      pushToast('ok', 'Teleport requested.', 'Your character should appear at that point.');
    } catch (err) {
      pushToast('err', 'Teleport failed.', messageOf(err));
    }
  };

  /** right-clicked map point for the current context menu */
  const contextPoint = useRef<Vec3 | null>(null);

  const onContextPick = (key: ContextKey) => {
    const menu = context;
    setContext(null);
    if (!menu) return;
    const node = menu.shipId ? state?.nodes.find((n) => n.id === menu.shipId) ?? null : null;
    const pos = menu.shipId ? node?.position ?? null : contextPoint.current;
    const name = menu.shipId ? names[menu.shipId] ?? node?.name ?? menu.shipId : menu.title;
    switch (key) {
      case 'move':
        if (menu.shipId) {
          setSelected(selectOnly(menu.shipId));
          openMove([menu.shipId]);
        }
        break;
      case 'move-here':
        if (pos) openMove(selected.ids, null, pos);
        break;
      case 'follow':
        if (menu.shipId) {
          setSelected(selectOnly(menu.shipId));
          setFollowId(menu.shipId);
          pushToast('ok', `Following ${name}.`, 'Esc stops following.');
        }
        break;
      case 'launch-orbit':
        if (menu.shipId) {
          setSelected(selectOnly(menu.shipId));
          openMove([menu.shipId], 'orbit-zero-g');
        }
        break;
      case 'rename':
        if (node) setRenameTarget(node);
        break;
      case 'copy-gps':
        if (pos) void copyGps(name, pos);
        break;
      case 'teleport':
        if (pos) void teleport(pos);
        break;
      default:
        break;
    }
  };

  /** right-clicked map point for the current context menu */
  const openShipMenu = (id: string, x: number, y: number) => {
    const node = state?.nodes.find((n) => n.id === id);
    if (!node) return;
    contextPoint.current = node.position;
    setSelected((prev) => clickSelected(prev, id, false));
    setContext({
      x,
      y,
      shipId: id,
      title: names[id] ?? node.name,
      subtitle: `${Math.round(node.telemetry?.speedMps ?? 0)} m/s, ${node.reachable ? 'reachable' : 'isolated'}`,
      items: shipMenuItems(),
    });
  };

  const openSpaceMenu = (planet: string | null, pos: Vec3, x: number, y: number) => {
    contextPoint.current = pos;
    setContext({
      x,
      y,
      shipId: null,
      title: planet ?? 'Map point',
      subtitle: `${Math.round(pos.x / 1000)}, ${Math.round(pos.y / 1000)}, ${Math.round(pos.z / 1000)} km`,
      items: spaceMenuItems(selected.ids.length > 0),
    });
  };

  const geoAt = (clientX: number, clientY: number): Vec3 | null => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return gpsFromScreen(cameraRef.current, clientX, clientY, rect, planetMidUnits);
  };

  useEffect(() => {
    // Window-level arbitration (capture phase): the native context menu never
    // opens inside the map, and our menu only opens for a real right-click
    // (<=5 px, <=400 ms). Chromium emits contextmenu at mousedown on Linux
    // and at mouseup on Windows, so the decision cannot live in that handler.
    (window as unknown as { __demoRightClick?: unknown }).__demoRightClick = mapRightClick;
    return installRightClickGate();
  }, []);

  /** Ship/marker hit: queue the menu until the gate confirms a click. */
  const queueShipMenu = (id: string, x: number, y: number) => {
    deepMenu.current = true;
    mapRightClick.begin(() => openShipMenu(id, x, y));
  };

  /** Planet surface hit. */
  const queueSurfaceMenu = (planet: string | null, pos: Vec3, x: number, y: number) => {
    deepMenu.current = true;
    mapRightClick.begin(() => openSpaceMenu(planet, pos, x, y));
  };

  // Box select: Shift + left drag on empty canvas selects every visible ship
  // inside. Plain left drag orbits the camera (owner rule).
  const onStagePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isStageChrome(event.target)) return;
    if (event.button === 2) {
      // Right button belongs to the window-level gate (pan vs menu).
      deepMenu.current = false;
      return;
    }
    if (event.button !== 0) return;
    suppressClick.current = false;
    // Track every left press so a CLICK can select a ship while a DRAG orbits.
    // Jitter tolerance: 6 px before it counts as a drag.
    dragRef.current = { x: event.clientX, y: event.clientY, shift: event.shiftKey, moved: false };
  };

  /**
   * Every visible ship projected to stage-local px. The radius-based picker in
   * lib/pickShips ranks these; projecting is cheap and the same list drives
   * hover, click and double-click so they can never disagree.
   */
  const screenNodes = useCallback((): ScreenNode[] => {
    const rect = stageRef.current?.getBoundingClientRect();
    const camera = cameraRef.current;
    if (!rect || !camera) return [];
    const v = camera.position.clone();
    const out: ScreenNode[] = [];
    for (const node of visibleNodes) {
      v.set(node.position.x / 1000, node.position.y / 1000, node.position.z / 1000).project(camera);
      if (v.z >= 1) continue;
      out.push({
        id: node.id,
        x: (v.x * 0.5 + 0.5) * rect.width,
        y: (-v.y * 0.5 + 0.5) * rect.height,
        depth: v.z,
        sizePx: 14,
      });
    }
    return out;
  }, [visibleNodes]);

  /** Zoom-scaled pick at a client point (14 px close in, 28 px zoomed out). */
  const pickAt = useCallback(
    (clientX: number, clientY: number) => {
      const rect = stageRef.current?.getBoundingClientRect();
      const radius = pickRadiusPx(cameraApi.current?.distance() ?? 20);
      if (!rect) {
        return { best: null, candidates: [] as ScreenNode[], radius, local: { x: 0, y: 0 } };
      }
      const local = { x: clientX - rect.left, y: clientY - rect.top };
      const result = pickNodes(screenNodes(), local.x, local.y, radius);
      return { ...result, radius, local };
    },
    [screenNodes],
  );

  const onStagePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isStageChrome(event.target)) {
      setHover((prev) => (prev ? null : prev));
      return;
    }
    const drag = dragRef.current;
    if (!drag) {
      // Hover highlight before the click: same ranking, same radius.
      const hit = pickAt(event.clientX, event.clientY).best;
      const next = hit ? { id: hit.id, x: hit.x, y: hit.y } : null;
      setHover((prev) => (prev?.id === next?.id && prev?.x === next?.x && prev?.y === next?.y ? prev : next));
      return;
    }
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 6) drag.moved = true;
    if (!drag.moved || !drag.shift) return;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setBox({
      x0: drag.x - rect.left,
      y0: drag.y - rect.top,
      x1: event.clientX - rect.left,
      y1: event.clientY - rect.top,
    });
  };

  const onStagePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button === 2) {
      // Pan-vs-menu is decided by the window gate, not here.
      return;
    }
    if (isStageChrome(event.target)) return;
    const drag = dragRef.current;
    dragRef.current = null;
    const rect = stageRef.current?.getBoundingClientRect();
    const camera = cameraRef.current;
    if (!drag || !rect || !camera) {
      setBox(null);
      return;
    }
    if (!drag.moved) {
      // A click (no movement) SELECTS only. It never changes the camera level
      // and never moves the camera — context entry is an explicit gesture.
      if (!drag.shift) {
        const result = pickAt(event.clientX, event.clientY);
        // The canvas also fires r3f's onPointerMissed after this event; that
        // handler clears the selection on a true background click. Flag the
        // gesture so a pick that just selected a ship is not wiped again.
        suppressClick.current = true;
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 250);
        if (result.best) {
          setSelected((prev) => selectMany([result.best!.id], false, prev));
          if (result.candidates.length > 1) {
            setPickList({ x: result.local.x, y: result.local.y, ids: result.candidates.map((n) => n.id) });
          } else {
            setPickList(null);
          }
        } else {
          setSelected(clearSelection());
          setPickList(null);
        }
      }
      setBox(null);
      return;
    }
    if (!drag.shift) {
      setBox(null);
      return;
    }
    const left = Math.min(drag.x, event.clientX) - rect.left;
    const right = Math.max(drag.x, event.clientX) - rect.left;
    const top = Math.min(drag.y, event.clientY) - rect.top;
    const bottom = Math.max(drag.y, event.clientY) - rect.top;
    const ids = screenNodes()
      .filter((n) => n.x >= left && n.x <= right && n.y >= top && n.y <= bottom)
      .map((n) => n.id);
    setSelected((prev) => selectMany(ids, drag.shift, prev));
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 250);
    setBox(null);
  };

  const onStageContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    // A ship/marker handler already queued its own menu for this hit.
    if (deepMenu.current) {
      deepMenu.current = false;
      return;
    }
    const pos = geoAt(event.clientX, event.clientY);
    if (!pos) return;
    mapRightClick.begin(() => openSpaceMenu(null, pos, event.clientX, event.clientY));
  };

  const onStageDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (Date.now() - lastFocusAt.current < 150) return;
    if ((event.target as HTMLElement).closest('.map-overlay')) return;
    // Double-click is an EXPLICIT context entry: a ship enters its own level,
    // a planet surface enters the planet level, empty space only frames a point.
    const hit = pickAt(event.clientX, event.clientY).best;
    if (hit) {
      const outcome = sessionAfterClick(cameraStack, { id: hit.id, kind: 'ship', double: true });
      if (outcome.entered) {
        setSelected((prev) => selectMany([hit.id], false, prev));
        enterCameraContext(outcome.entered);
      }
      return;
    }
    const pos = geoAt(event.clientX, event.clientY);
    if (!pos) return;
    const planet = planetAtPoint({ x: pos.x / 1000, y: pos.y / 1000, z: pos.z / 1000 }, state?.planets ?? []);
    if (planet) {
      enterCameraContext({ kind: 'planet', id: planet.name, upMode: 'gravity' });
      return;
    }
    focusPoint(pos, 'Map point', 2);
  };

  // Keyboard: F focus, Esc clear, ? help. Never while typing in a flow input.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      if (event.key === 'Tab') {
        event.preventDefault();
        setFlyMode((v) => !v);
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (event.key === 'Escape') {
        if (context) setContext(null);
        else if (helpOpen) setHelpOpen(false);
        else if (flow) setFlow(null);
        else if (networkOpen) setNetworkOpen(false);
        else if (fleetOpen) setFleetOpen(false);
        else if (opsOpen) setOpsOpen(false);
        else if (finderOpen) setFinderOpen(false);
        else if (pickList) setPickList(null);
        // Esc steps OUT exactly one camera level and restores that level's pose.
        else if (exitCameraContext()) setFollowId(null);
        else clearAll();
        return;
      }
      if (event.key.toLowerCase() === 'f') {
        const primary = selected.primary ?? selected.ids[0];
        if (primary) enterCameraContext({ kind: 'ship', id: primary, upMode: 'gravity' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [context, helpOpen, flow, networkOpen, fleetOpen, opsOpen, finderOpen, pickList, selected, clearAll, exitCameraContext, enterCameraContext]);

  if (refusal) return <Lockdown reason={refusal} />;
  if (!token) {
    return (
      <TokenGate
        error={error}
        onSubmit={(value) => {
          setApiToken(value);
          setToken(value);
          setError(null);
        }}
      />
    );
  }
  if (!state) {
    return (
      <div className="boot">
        <h1>{SERVER_BADGE}</h1>
        <p>{error ? `Backend unreachable: ${error}` : IS_LIVE ? 'Loading live state…' : 'Loading test-lab state…'}</p>
        {error && (
          <button type="button" onClick={() => void refresh()}>
            Retry
          </button>
        )}
      </div>
    );
  }

  const kill = async () => {
    try {
      const res = await api.kill(!state.killSwitch);
      pushToast(res.killSwitch ? 'err' : 'ok', res.note, res.killSwitch ? 'Every moving grid has a stop order.' : 'Movement is allowed again.');
      await refresh();
    } catch (err) {
      pushToast('err', 'Kill switch failed.', messageOf(err));
    }
  };

  /** Fleet bulk STOP: the existing kill endpoint only takes a global switch. */
  const stopFleet = async () => {
    if (state.killSwitch) {
      pushToast('info', 'Commands are already stopped.', 'Use the bottom STOP button to resume movement.');
      return;
    }
    try {
      const res = await api.kill(true);
      pushToast('ok', 'STOP sent to every moving grid.', res.note);
      await refresh();
    } catch (err) {
      pushToast('err', 'STOP failed.', messageOf(err));
    }
  };

  const recentMissions: MissionSummary[] = state.missions.recent;
  const actions = actionsFor(selected.ids.length);
  const followName = followNode ? names[followNode.id] ?? followNode.name : null;

  // Test probe: lets Playwright read selection without scraping pixels.
  (window as unknown as { __demoSel?: string[] }).__demoSel = selected.ids;
  // Test probe: fleet rows (ids/names/values) without scraping the table.
  (window as unknown as { __demoFleet?: unknown }).__demoFleet = {
    open: fleetOpen,
    rows: fleetRows.map((r) => ({
      id: r.id,
      name: r.name,
      state: r.state,
      role: r.role,
      h2Pct: r.h2Pct,
      radioRangeM: r.radioRangeM,
      expectedLife: r.expectedLife,
    })),
  };
  // Test probe: fly to a known grid id (same path as double-clicking its marker).
  (window as unknown as { __demoFocusNode?: (id: string) => void }).__demoFocusNode = focusNode;
  // Test probes for this batch: groups, links and coverage without pixel scraping.
  (window as unknown as { __demoGroups?: unknown }).__demoGroups = {
    server: groupsServer,
    active: activeGroupId,
    open: groupsOpen,
    groups: groups.map((g) => ({ id: g.id, name: g.name, color: g.color, members: g.members.length })),
  };
  (window as unknown as { __demoLinks?: unknown }).__demoLinks = {
    mode: overlays.linkMode,
    available: linksAvailable,
    current: linksData?.current.length ?? 0,
    possible: linksData?.possible.length ?? 0,
  };
  const redCell = coverageData?.response.cells.find((cell) => cell.coveredBy === 0) ?? null;
  (window as unknown as { __demoCoverage?: unknown }).__demoCoverage = {
    on: overlays.coverage,
    available: coverageAvailable,
    planet: coverageAvailable === 'ok' ? coveragePlanet : null,
    cells: coverageData?.response.cells.length ?? 0,
    redCell: redCell ? { latDeg: redCell.latDeg, lonDeg: redCell.lonDeg } : null,
    popover: Boolean(cellPick),
  };
  (window as unknown as { __demoConstellation?: unknown }).__demoConstellation = { group: constellationFor };
  (window as unknown as { __demoPreview?: unknown }).__demoPreview = preview ? { slots: preview.slots.length } : null;
  // Test probes: camera level + picking, so Playwright never scrapes pixels.
  (window as unknown as { __demoContext?: unknown }).__demoContext = {
    key: camContext.key,
    kind: camContext.kind,
    label: camContext.label,
    depth: stackDepth(cameraStack),
    stack: cameraStack.stack.map((t) => `${t.kind}:${t.id}`),
    breadcrumb: crumbs.map((c) => c.label),
    up: [camContext.up.x, camContext.up.y, camContext.up.z],
    pivot: [camContext.pivot.x, camContext.pivot.y, camContext.pivot.z],
    poses: cameraStack.poses,
  };
  (window as unknown as { __demoEnterContext?: (t: ContextTarget) => void }).__demoEnterContext = (t) => enterCameraContext(t);
  (window as unknown as { __demoExitContext?: () => boolean }).__demoExitContext = () => exitCameraContext();
  (window as unknown as { __demoJumpLevel?: (i: number) => void }).__demoJumpLevel = (i) => jumpCameraLevel(i);
  // Test probe: open the disambiguation list with known ids (the real click path
  // ranks hits in lib/pickShips; this exercises the list + its list-pick wiring).
  (window as unknown as { __demoShowPick?: (ids: string[]) => void }).__demoShowPick = (ids) =>
    setPickList({ x: 220, y: 150, ids });
  (window as unknown as { __demoPick?: unknown }).__demoPick = {
    radiusPx: +pickRadiusPx(cameraApi.current?.distance() ?? 20).toFixed(2),
    distance: +(cameraApi.current?.distance() ?? 0).toFixed(3),
    hover: hover?.id ?? null,
    open: Boolean(pickList),
    candidates: pickList?.ids.length ?? 0,
  };
  // Test probe: the same handler the coverage sphere calls on a real click.
  (window as unknown as { __demoPickCell?: (lat: number, lon: number, planet?: string) => void }).__demoPickCell = (
    lat,
    lon,
    planet,
  ) => setCellPick({ planet: planet ?? coveragePlanet, latDeg: lat, lonDeg: lon });

  return (
    <div className="app">
      <div
        className="stage"
        ref={stageRef}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onContextMenu={onStageContextMenu}
        onDoubleClick={onStageDoubleClick}
        data-testid="stage"
        data-map-surface=""
      >
        {webgl ? (
          <>
            <Scene
              planets={state.planets}
              nodes={visibleNodes}
              graph={state.graph}
              selectedIds={selected.ids}
              preview={null}
              designerPreview={preview}
              highlight={[]}
              overlays={overlays}
              pickMode={flow?.kind === 'move' && flow.picking}
              pickMarker={flow?.kind === 'move' ? flow.picked : null}
              focus={focus}
              cameraRef={cameraRef}
              followPos={followPos}
              manifest={manifest}
              terrainPlanets={terrainPlanets}
              drawnIds={drawnIds}
              pivot={pivot}
              context={camContext}
              cameraApiRef={cameraApi}
              flyMode={flyMode}
              pulsePeriod={pulsePeriod}
              onDrawn={onDrawn}
              currentLinks={linksData?.current ?? []}
              possibleLinks={linksData?.possible ?? []}
              coverageData={coverageData}
              previewCoverageData={previewCoverageData}
              onCoverageCell={(planet, latDeg, lonDeg) =>
                setCellPick({ planet: planet.name, latDeg, lonDeg })
              }
              onCoverageTerrainReport={onCoverageTerrainReport}
              groupBracket={groupBracket}
              onSelect={(id, additive) => {
                if (suppressClick.current) return;
                setSelected((prev) => clickSelected(prev, id, additive));
              }}
              onPickSurface={(planet, pos) => {
                if (flow?.kind !== 'move') return;
                setFlow({ ...flow, picked: pos, picking: false });
              }}
              onContextMenuShip={queueShipMenu}
              onContextMenuSurface={queueSurfaceMenu}
              onFocusNode={(id) => enterCameraContext({ kind: 'ship', id, upMode: 'gravity' })}
              onFocusPoint={focusPoint}
              onBackground={() => {
                if (suppressClick.current) return;
                setSelected(clearSelection());
                setContext(null);
              }}
            />
            <MapOverlay
              nodes={visibleNodes}
              planets={state.planets}
              cameraRef={cameraRef}
              selectedIds={selected.ids}
              names={names}
              drawnIds={drawnIds}
              hullM={hullM}
              showStale={showStale}
              showLabels={overlays.labels}
              radioRings={overlays.radioRings}
              hoverId={hover?.id ?? null}
              spofs={state.spofs}
              onSelect={(id, additive) => setSelected((prev) => clickSelected(prev, id, additive))}
              onFocus={(id) => enterCameraContext({ kind: 'ship', id, upMode: 'gravity' })}
              onContextMenu={queueShipMenu}
            />
          </>
        ) : (
          <div className="no-webgl">
            <p>WebGL is unavailable in this browser. The action bar and flows still work.</p>
          </div>
        )}

        {box && (
          <div
            className="box-select"
            data-testid="box-select"
            style={{
              left: Math.min(box.x0, box.x1),
              top: Math.min(box.y0, box.y1),
              width: Math.abs(box.x1 - box.x0),
              height: Math.abs(box.y1 - box.y0),
            }}
          />
        )}

        <header className="hud-top">
          <div className="brand">
            <strong>SE Relay Network</strong>
            <span className="subtitle">{IS_LIVE ? 'Survival instance' : 'SE-RTS Test Lab'}</span>
          </div>
          <div className="hud-stats">
            <span className="hud-group" data-group="status" aria-label="Status">
              <span className="chip-live" data-testid="live-count">
                <i className="dot green" /> {liveCount} live
              </span>
              <span className={`chip${linkFresh ? ' ok' : ' warn'}`} data-testid="plugin-status">
                {state.plugin.connected ? 'plugin connected' : 'plugin offline'}
                {heartbeatAgeMs !== null ? `, ${Math.round(heartbeatAgeMs / 1000)}s ago` : ''}
              </span>
              <span className={`chip status-chip${state.killSwitch ? ' bad' : ''}`} data-testid="kill-state">
                <i className={`dot ${state.killSwitch ? 'red' : 'green'}`} />{' '}
                {state.killSwitch ? 'commands stopped' : 'commands enabled'}
              </span>
              <SurvivalBadge survivalMode={survivalMode} />
              <button
                type="button"
                className={`chip mode-chip${flyMode ? ' fly' : ''}`}
                data-testid="camera-mode"
                aria-pressed={flyMode}
                onClick={() => setFlyMode((v) => !v)}
                title={flyMode ? 'Fly mode: right-drag looks, WASD flies along the view (Tab)' : 'Orbit mode: left-drag orbits the selected grid (Tab switches to Fly)'}
              >
                {flyMode ? 'Fly' : `Orbit ${pivotLabel}`}
              </button>
              {shapesError && (
                <span className="chip warn" data-testid="shapes-status" title={shapesError}>
                  ship shapes unavailable
                </span>
              )}
            </span>
            <span className="hud-divider" aria-hidden="true" />
            <span className="hud-group" data-group="actions" aria-label="Actions">
              {hiddenCount > 0 && !showAll && (
                <button type="button" className="chip link" onClick={() => setShowAll(true)} title="Show every grid in the world">
                  Show all grids
                </button>
              )}
              <button
                type="button"
                className={`chip${finderOpen ? ' active' : ''}`}
                data-testid="finder-toggle"
                aria-pressed={finderOpen}
                title="Search ships by name and fly to one"
                onClick={() => {
                  setFinderOpen((v) => !v);
                  setFleetOpen(false);
                  setNetworkOpen(false);
                  setGroupsOpen(false);
                  setLayersOpen(false);
                  setConstellationFor(null);
                }}
              >
                Find ship
              </button>
              <button
                type="button"
                className={`chip${rolesOpen ? ' active' : ''}`}
                data-testid="roles-toggle"
                aria-pressed={rolesOpen}
                onClick={() => {
                  setRolesOpen((v) => !v);
                  setFinderOpen(false);
                  setFleetOpen(false);
                  setNetworkOpen(false);
                  setGroupsOpen(false);
                  setLayersOpen(false);
                  setConstellationFor(null);
                }}
                title="Ship roles: MANAGED, PERSONAL, BASE, OFF (the in-game tag always wins)"
              >
                Roles
              </button>
              <button
                type="button"
                className={`chip${fleetOpen ? ' active' : ''}`}
                data-testid="fleet-toggle"
                aria-pressed={fleetOpen}
                onClick={() => {
                  setFleetOpen((v) => !v);
                  setFinderOpen(false);
                  setNetworkOpen(false);
                  setGroupsOpen(false);
                  setLayersOpen(false);
                  setConstellationFor(null);
                }}
                title="Fleet monitor: every grid, alerts, sorting and bulk actions"
              >
                Fleet
              </button>
              <button
                type="button"
                className={`chip${groupsOpen ? ' active' : ''}`}
                data-testid="groups-toggle"
                aria-pressed={groupsOpen}
                title="Satellite groups: chips, bulk actions, constellation control"
                onClick={() => {
                  setGroupsOpen((v) => !v);
                  setFinderOpen(false);
                  setFleetOpen(false);
                  setNetworkOpen(false);
                  setLayersOpen(false);
                  setConstellationFor(null);
                }}
              >
                Groups
              </button>
              <button
                type="button"
                className={`chip${layersOpen ? ' active' : ''}`}
                data-testid="layers-toggle"
                aria-pressed={layersOpen}
                title="Map layers: links (current vs possible) and the coverage heatmap"
                onClick={() => {
                  setLayersOpen((v) => !v);
                  setFinderOpen(false);
                  setFleetOpen(false);
                  setNetworkOpen(false);
                  setGroupsOpen(false);
                  setConstellationFor(null);
                }}
              >
                Layers
              </button>
              <button
                type="button"
                className={`chip${networkOpen ? ' active' : ''}`}
                data-testid="network-toggle"
                aria-pressed={networkOpen}
                onClick={() => {
                  setNetworkOpen((v) => !v);
                  setFinderOpen(false);
                  setFleetOpen(false);
                  setGroupsOpen(false);
                  setLayersOpen(false);
                  setConstellationFor(null);
                }}
              >
                Network
              </button>
              <div className="danger-wrap">
                <button type="button" className="chip danger-chip" data-testid="danger-toggle" onClick={() => setDangerOpen((v) => !v)}>
                  Reset…
                </button>
                {dangerOpen && (
                  <div className="danger-menu" data-testid="danger-menu">
                    <button
                      type="button"
                      onClick={() => {
                        setDangerOpen(false);
                        setResetOpen(true);
                      }}
                    >
                      Reset test world…
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setApiToken('');
                        setToken('');
                        setDangerOpen(false);
                      }}
                    >
                      Forget token
                    </button>
                  </div>
                )}
              </div>
            </span>
          </div>
        </header>

        <Breadcrumb
          items={crumbs}
          description={contextNote}
          canUp={stackDepth(cameraStack) > 1}
          onJump={jumpCameraLevel}
          onUp={() => exitCameraContext()}
          upMode={camContext.kind === 'ship' ? camContext.upMode : undefined}
          onUpMode={() =>
            enterCameraContext({
              kind: 'ship',
              id: camContext.id,
              upMode: camContext.upMode === 'gravity' ? 'ship' : 'gravity',
            })
          }
        />

        {pickList && (
          <PickList
            x={pickList.x}
            y={pickList.y}
            items={pickList.ids.map((id) => ({
              id,
              label: names[id] ?? state.nodes.find((n) => n.id === id)?.name ?? id,
              meta: `${Math.round(state.nodes.find((n) => n.id === id)?.telemetry?.speedMps ?? 0)} m/s`,
            }))}
            onPick={(id) => {
              setSelected((prev) => selectMany([id], false, prev));
              enterCameraContext({ kind: 'ship', id, upMode: 'gravity' });
            }}
            onClose={() => setPickList(null)}
          />
        )}

        {hover && !pickList && (
          <span
            className="hover-hint"
            data-testid="hover-hint"
            data-hover-id={hover.id}
            style={{ left: hover.x, top: hover.y }}
          >
            {names[hover.id] ?? state.nodes.find((n) => n.id === hover.id)?.name ?? hover.id}
          </span>
        )}

        {error && (
          <div className="banner error-banner" data-testid="state-error">
            Backend error: {error}
          </div>
        )}

        {finderOpen && (
          <ShipSearchPanel
            rows={visibleNodes.map((n) => ({
              id: n.id,
              name: names[n.id] ?? n.name,
              meta: `${n.reachable ? 'reachable' : 'isolated'} · ${Math.round(n.telemetry?.speedMps ?? 0)} m/s${n.planet ? ` · ${n.planet}` : ''}`,
              planet: n.planet ?? null,
              role: n.role ?? 'managed',
            }))}
            onPick={(id) => {
              setSelected(selectOnly(id));
              enterCameraContext({ kind: 'ship', id, upMode: 'gravity' });
            }}
            onClose={() => setFinderOpen(false)}
          />
        )}

        {rolesOpen && (
          <RolePanel
            nodes={state.nodes}
            onClose={() => setRolesOpen(false)}
            onChanged={() => void refresh()}
            onToast={pushToast}
          />
        )}

        {networkOpen && (
          <NetworkPanel
            state={state}
            overlays={overlays}
            showStale={showStale}
            showAll={showAll}
            showArchived={showArchived}
            archivedCount={state.telemetry.archivedCount ?? 0}
            onOverlays={setOverlays}
            onShowStale={setShowStale}
            onShowAll={setShowAll}
            onShowArchived={setShowArchived}
            pulseSpeed={pulseSpeed}
            onPulseSpeed={setPulseSpeed}
            onSelect={(id) => focusNode(id)}
            onClose={() => setNetworkOpen(false)}
          />
        )}

        {fleetOpen && (
          <FleetPanel
            state={state}
            rows={fleetRows}
            onClose={() => setFleetOpen(false)}
            onFocus={(id) => focusNode(id)}
            onMove={(ids) => openMove(ids)}
            onLaunchOrbit={(ids) => openMove(ids, 'orbit-zero-g')}
            onStop={() => void stopFleet()}
            onChanged={() => void refresh()}
            onToast={pushToast}
            groups={groups}
            activeGroupId={activeGroupId}
            onGroupSelect={(id) => selectGroup(id === activeGroupId ? null : id)}
            onGroupAs={(ids) => {
              setSelected(selectMany(ids, false, EMPTY_SELECTION));
              setFleetOpen(false);
              setGroupsOpen(true);
              setGroupAsStart(true);
            }}
          />
        )}

        {opsOpen && (
          <OpsPanel
            state={state}
            selectedIds={selected.ids}
            bases={state.nodes
              .filter((n) => n.controlSource && n.status === 'alive')
              .map((n) => ({ name: n.name, position: n.position }))}
            tab={opsTab}
            onTab={setOpsTab}
            onClose={() => setOpsOpen(false)}
            onToast={pushToast}
          />
        )}

        {groupsOpen && (
          <GroupsPanel
            groups={groups}
            activeId={activeGroupId}
            selection={selected.ids}
            server={groupsServer}
            startCreating={groupAsStart}
            onActivate={(id) => selectGroup(id)}
            onCreate={createGroup}
            onRename={(id, name) => updateGroup(id, { name })}
            onDelete={deleteGroup}
            onAddSelection={(id) => {
              const group = groups.find((g) => g.id === id);
              if (!group) return;
              updateGroup(id, { members: [...group.members, ...selected.ids] });
            }}
            onRemoveSelection={(id) => {
              const group = groups.find((g) => g.id === id);
              if (!group) return;
              updateGroup(id, { members: group.members.filter((m) => !selected.ids.includes(m)) });
            }}
            onBulk={groupBulk}
            onConstellation={(group) => openConstellation(group.id)}
            onFocusMember={focusNode}
            onClose={() => {
              setGroupsOpen(false);
              setGroupAsStart(false);
            }}
          />
        )}

        {layersOpen && (
          <LayersPanel
            planets={state.planets}
            overlays={overlays}
            onOverlays={setOverlays}
            linksMode={overlays.linkMode}
            onLinksMode={(mode: LinkMode) => {
              setOverlays((prev) => ({ ...prev, linkMode: mode }));
              if (mode === 'off') setLinksData(null);
            }}
            links={linksData ?? EMPTY_LINKS}
            linksAvailable={linksAvailable}
            coveragePlanet={coveragePlanet}
            onCoveragePlanet={(planet) => {
              setCoveragePlanet(planet);
              setCoverageData(null);
              setCellPick(null);
            }}
            coverageData={coverageData}
            coverageAvailable={coverageAvailable}
            coverageApproximate={coverageApproximate}
            names={names}
            onClose={() => setLayersOpen(false)}
          />
        )}

        {cellPick && coverageWhy && (
          <div className="coverage-popover" data-testid="coverage-popover" role="dialog" aria-label="Why this cell is uncovered">
            <header>
              <strong>{cellPick.planet} · {coverageWhy.title}</strong>
              <button type="button" onClick={() => setCellPick(null)} aria-label="Close coverage detail">✕</button>
            </header>
            <ul>
              {coverageWhy.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <button
              type="button"
              className="primary"
              data-testid="coverage-plan-fix"
              onClick={() => {
                const groupId = activeGroupId ?? groups[0]?.id ?? null;
                if (!groupId) {
                  pushToast('info', 'Make a group first.', 'Select the ships you want to move, then Group as…');
                  setCellPick(null);
                  setGroupsOpen(true);
                  return;
                }
                openConstellation(groupId, {
                  planet: cellPick.planet,
                  latDeg: cellPick.latDeg,
                  lonDeg: cellPick.lonDeg,
                  altitudeM: coverageWhy.altitudeM,
                });
                setCellPick(null);
              }}
            >
              Plan a fix
            </button>
          </div>
        )}

        {constellationFor && (() => {
          const group = groups.find((g) => g.id === constellationFor);
          if (!group) return null;
          return (
            <ConstellationPanel
              key={`constellation-${group.id}`}
              state={state}
              group={group}
              hullIds={hullIds}
              fix={fixPrefill}
              names={names}
              onClose={() => {
                setConstellationFor(null);
                setFixPrefill(null);
              }}
              onPreview={setPreview}
              onPreviewCells={setPreviewCoverage}
              onRefresh={() => void refresh()}
              onToast={pushToast}
            />
          );
        })()}

        {flow?.kind === 'move' && (
          <MoveFlow
            key={`move-${flow.ids.join(',')}`}
            ships={flow.ids.map((id) => {
              const node = state.nodes.find((n) => n.id === id);
              return { id, name: names[id] ?? node?.name ?? id, role: node?.role ?? 'managed' };
            })}
            planets={state.planets}
            pickedTarget={flow.picked}
            initialPreset={flow.preset}
            picking={flow.picking}
            onPickOnMap={() => setFlow({ ...flow, picking: true })}
            onClose={() => setFlow(null)}
            onMoved={(text) => pushToast('ok', text)}
            onComingSoon={() => markComingSoon('move')}
          />
        )}

        {flow?.kind === 'launch' && (
          <LaunchFlow
            nodes={state.nodes}
            naming={naming.grids}
            planets={state.planets}
            bases={bases}
            initialIds={flow.ids}
            onClose={() => {
              setFlow(null);
              setPreview(null);
            }}
            onLaunched={(text) => {
              pushToast('ok', text);
              void refresh();
              void refreshAux();
            }}
            onComingSoon={() => markComingSoon('launch-satellites')}
            onPreview={setPreview}
          />
        )}

        <MissionStrip
          missions={recentMissions}
          dismissed={dismissed}
          onDismiss={(id) => setDismissed((prev) => new Set(prev).add(id))}
          onClearFailed={() =>
            setDismissed((prev) => {
              const next = new Set(prev);
              for (const m of recentMissions) if (m.status === 'failed') next.add(m.id);
              return next;
            })
          }
          onOpenMission={() => undefined}
        />

        <ActionBar
          count={selected.ids.length}
          actions={actions}
          comingSoon={comingSoon}
          killOn={state.killSwitch}
          followName={followName}
          canFocus={Boolean(selected.primary ?? selected.ids[0]) || Boolean(activeGroupId)}
          focusLabel={camContext.kind === 'ship' ? `Focus ${camContext.label}` : 'Focus selection'}
          onFocus={() => {
            const target = selected.primary ?? selected.ids[0];
            if (target) {
              enterCameraContext({ kind: 'ship', id: target, upMode: 'gravity' });
              return;
            }
            if (activeGroupId) {
              enterCameraContext({ kind: 'group', id: activeGroupId, upMode: 'gravity' });
              return;
            }
            pushToast('info', 'Select a ship first.', 'Click a ship, pick one from Find ship, or double-click it.');
          }}
          onAction={onAction}
          onKill={() => void kill()}
          onHelp={() => setHelpOpen(true)}
          opsActive={opsOpen}
          opsBadge={(state as unknown as { alerts?: { open?: number } }).alerts?.open ?? 0}
          onOps={() => {
            setOpsOpen((v) => !v);
            setFinderOpen(false);
            setFleetOpen(false);
            setNetworkOpen(false);
            setGroupsOpen(false);
            setLayersOpen(false);
            setConstellationFor(null);
          }}
          group={activeGroup ? { id: activeGroup.id, name: activeGroup.name, color: activeGroup.color, count: activeGroup.members.length } : null}
          onGroupBulk={(action) => {
            if (activeGroup) groupBulk(activeGroup, action);
          }}
        />

        <Toasts items={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))} />

        {!fleetOpen && (
          <div className="scene-hint" data-testid="scene-hint">
            <b>Click</b> selects (never moves) · <b>Left-drag</b> orbit · <b>Right-drag</b> pan (look in Fly) · <b>Wheel</b> zoom ·{' '}
            <b>Double-click</b> enter a level · <b>Esc</b> one level out · <b>WASD/QE</b> fly · <b>Shift+left-drag</b> box select · <b>?</b> help
          </div>
        )}
      </div>

      {context && <ContextMenu menu={context} onPick={onContextPick} onClose={() => setContext(null)} />}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      {resetOpen && (
        <ResetDialog
          onClose={() => setResetOpen(false)}
          onDone={(result) => {
            setResetOpen(false);
            pushToast('ok', `Reset mission ${result.mission.id} created.`, `Snapshot ${result.snapshot}.`);
            void refresh();
          }}
        />
      )}
      {renameTarget && (
        <RenameDialog
          node={renameTarget}
          current={names[renameTarget.id] ?? renameTarget.name}
          onClose={() => setRenameTarget(null)}
          onDone={async (name) => {
            try {
              await api.rename(renameTarget.id, name);
              pushToast('ok', `Renamed to ${name}.`);
              setRenameTarget(null);
              void refreshAux();
            } catch (err) {
              pushToast('err', 'Rename failed.', messageOf(err));
            }
          }}
        />
      )}
    </div>
  );
}
