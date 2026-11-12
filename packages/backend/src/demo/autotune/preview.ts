/**
 * Build the T29 preview/apply plan from the live demo state.
 *
 * Reads the same provisioning snapshot and live graph the Fleet overlay uses,
 * so "longest active link" means exactly the links an operator can see.
 */
import type { Store } from '../../store.js';
import { loadPlanetCatalog } from '../../planner/index.js';
import { capabilitiesFromStore, liveGraph, networkSnapshot, type GridCapability, type SourcedEdge } from '../network.js';
import { loadWorld } from '../world.js';
import type { PowerPoller } from '../power/poller.js';
import { readPins, type PinMap } from './pins.js';
import { tunePlan, type TuneNodeInput, type TunePlan } from './range.js';

export interface PreviewDeps {
  store: Store;
  fixturePath: string | null;
  power?: PowerPoller | null;
  clock?: () => number;
}

export interface PreviewOptions {
  /** Extra footprints from the caller, metres. Not persisted. */
  footprints?: Record<string, number>;
  roles?: Record<string, 'base' | 'coverage' | 'backbone'>;
  gridIds?: string[] | null;
}

export function previewTune(deps: PreviewDeps, opts: PreviewOptions = {}): TunePlan {
  const now = deps.clock?.() ?? Date.now();
  const world = loadWorld(deps.store, deps.fixturePath, now);
  const snapshot = networkSnapshot({
    store: deps.store,
    world,
    now,
    freshMs: 60_000,
  });
  const graph = liveGraph(snapshot, loadPlanetCatalog());
  const pins = readPins(deps.store);
  const nodes = buildNodes(snapshot.capability, graph.edges, pins, deps.power ?? null, opts);
  const filtered = opts.gridIds && opts.gridIds.length > 0 ? nodes.filter((n) => opts.gridIds!.includes(n.gridId)) : nodes;
  // Keep links to nodes outside the filter: a link in use still constrains the
  // tuning of the node we do change.
  return tunePlan(filtered, now);
}

export function buildNodes(
  caps: Map<string, GridCapability>,
  edges: SourcedEdge[],
  pins: PinMap,
  power: PowerPoller | null,
  opts: PreviewOptions = {},
): TuneNodeInput[] {
  const out: TuneNodeInput[] = [];
  for (const cap of caps.values()) {
    const pin = pins[cap.gridId];
    const snap = power?.snapshot(cap.gridId) ?? null;
    const radioLinks = edges
      .filter((e) => e.kind === 'radio' && (e.from === cap.gridId || e.to === cap.gridId))
      .map((e) => ({ to: e.from === cap.gridId ? e.to : e.from, distanceM: e.distanceM }));
    const laserLinks = edges
      .filter((e) => e.kind === 'laser' && (e.from === cap.gridId || e.to === cap.gridId))
      .map((e) => ({ to: e.from === cap.gridId ? e.to : e.from, distanceM: e.distanceM }));
    const footprint = opts.footprints?.[cap.gridId] ?? pin?.footprintM ?? null;
    const role = opts.roles?.[cap.gridId] ?? (cap.profile === 'BASE' ? 'base' : footprint ? 'coverage' : 'backbone');
    // The live profile wins over the 10 s provisioning snapshot: after an apply
    // the preview must show the radius the block has right now.
    const current = snap?.radioRangeM ?? cap.radioRadiusM;
    out.push({
      gridId: cap.gridId,
      name: cap.name,
      role,
      radioRadiusM: current,
      laserRangeM: cap.laserCount > 0 ? cap.laserRangeM : null,
      footprintM: footprint,
      pinRadioM: pin?.radioM ?? null,
      pinLaserM: pin?.laserM ?? null,
      // The provisioning read-back is the configured radius, not the hardware
      // maximum, so a tune can shrink but never grow a radio past it.
      maxRadioM: current,
      maxLaserM: cap.laserCount > 0 ? 100_000 : null,
      radioLinks,
      laserLinks,
      antennaDrawMw: snap?.antennaDrawMw ?? null,
      laserDrawMw: snap?.laserDrawMw ?? null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
