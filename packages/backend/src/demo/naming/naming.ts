/**
 * Auto-naming for owner-tagged grids (test server only).
 *
 * Scheme (approved in .next-task-testserver.md T9):
 *   satellite  SAT-<R|L|M>-<NNNN>   L = 2+ lasers, M = radio + exactly 1 laser,
 *                                   R = radio only; a solo laser counts as L
 *   radio antenna = grid name
 *   lasers        = "<name> L1", "<name> L2", … (by block entity id)
 *   programmable  = "[HERMES-TEST] <name>" / "[HERMES-BASE] <name>"
 *   base          BASE-NN
 *
 * Numbers are allocated once and persisted in SQLite (`naming:registry`); they
 * are never reused even if a grid is deleted. If the owner renames a grid
 * in-game or through POST /api/demo/naming/rename, the record is marked
 * `ownerOverride` and the service stops touching that grid.
 */
import type { Config } from '../../config.js';
import type { Store } from '../../store.js';
import type { PluginHub } from '../../pluginHub.js';
import { callPlugin, loadProfiles, type ProvisionDeps, type TaggedGrid } from '../provision/provisioner.js';
import { LaserLinker } from '../laser.js';
import { resolveGridRole, isAutomatableRole, hintsFromPluginGrid, shipRoles } from '../roles.js';
import { isLiveInstance } from '../ownership.js';

export const NAMING_KV = 'naming:registry';
export const LASER_TEST_KV = 'naming:lasertest';
export const BASE_PREFIX = 'BASE';
export const SAT_PREFIX = 'SAT';

export type GridKind = 'SAT' | 'BASE';
export type SatClass = 'R' | 'L' | 'M';

export interface NamingDeps {
  config: Config;
  store: Store;
  hub: PluginHub;
  clock?: () => number;
}

export interface NameRecord {
  gridId: string;
  name: string;
  kind: GridKind;
  cls: SatClass | null;
  number: number;
  tag: string;
  ownerOverride: boolean;
  /** Last live grid name observed from list_tagged, for override detection. */
  observedName: string | null;
  assignedAt: number;
  appliedAt: number | null;
  renameOk: boolean;
  blocks: { radio: number; laser: number; pb: number };
  audit: string[];
  lastError: string | null;
}

interface RegistryFile {
  version: 1;
  grids: NameRecord[];
  counters: Record<string, number>;
}

export interface NamingRun {
  at: number;
  scanned: number;
  assigned: number;
  renamed: number;
  overrides: number;
  skipped: number;
  errors: string[];
}

export interface LaserTestState {
  at: number;
  ok: boolean;
  reason: string | null;
  gridA: { gridId: string; name: string; laserEntityId: string; position: Vec3T } | null;
  gridB: { gridId: string; name: string; laserEntityId: string; position: Vec3T } | null;
  distanceM: number | null;
  timeoutS: number | null;
  elapsedS: number | null;
  connected: boolean;
  finalStatus: { a: string | null; b: string | null };
  power: { a: unknown; b: unknown };
  connectedTo: { a: string | null; b: string | null };
  permanent: boolean;
  samples: { t: number; a: string; b: string }[];
  cleanup: { disconnects: number; lasersOff: number; note: string } | null;
  labels: string[];
}

export interface Vec3T {
  x: number;
  y: number;
  z: number;
}

function nowOf(deps: NamingDeps): number {
  return deps.clock?.() ?? Date.now();
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** Default Space Engineers grid names — never treated as an owner rename. */
export function isDefaultName(name: string | null | undefined): boolean {
  const n = (name ?? '').trim();
  if (!n) return true;
  return /^(small|large|static)\s+grid\b/i.test(n) || /^grid\b/i.test(n) || /^unnamed\b/i.test(n);
}

/**
 * Is automatic renaming allowed on this instance?
 *
 * OFF BY DEFAULT ON LIVE (`RTS_ENV=live`): renaming an owner's grid and block
 * names on the shared survival world is a visible, hard-to-undo change, and the
 * live instance is not a naming playground. The test instance keeps the old
 * behaviour (on). Either can be forced with `RTS_NAMING_AUTO=1` / `=0`.
 */
export function namingAutoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RTS_NAMING_AUTO ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  return !isLiveInstance(env);
}

/**
 * Tag prefix for a programmable block name. The owner's own spelling wins:
 * `[BASE]` stays `[BASE]`, never rewritten into `[HERMES-BASE]`. A role set only
 * in CustomData mints no name tag at all (null = leave the PB name alone), so
 * naming can never add a tag the owner did not write.
 */
export function pbTagPrefix(
  kind: GridKind,
  grid: Pick<TaggedGrid, 'roleHints' | 'blocks'> | null | undefined,
): string | null {
  const want = kind === 'BASE' ? 'base' : 'managed';
  const hints = hintsFromPluginGrid(grid as TaggedGrid | null | undefined);
  // Prefer the literal bracket token from a block NAME: that is the form the
  // owner typed, and the PB rename must preserve it.
  const nameHint = hints.find((h) => h.role === want && h.source === 'block-name' && h.token.startsWith('['));
  if (nameHint) return nameHint.token;
  const anyHint = hints.find((h) => h.role === want);
  if (anyHint) return null;
  return kind === 'BASE' ? '[HERMES-BASE]' : '[HERMES-TEST]';
}

/** Sat class from live block counts. */
export function satClassOf(radioCount: number, laserCount: number): SatClass {
  if (laserCount >= 2) return 'L';
  if (radioCount >= 1 && laserCount === 1) return 'M';
  if (radioCount >= 1) return 'R';
  if (laserCount === 1) return 'L';
  return 'M';
}

function emptyRegistry(): RegistryFile {
  return { version: 1, grids: [], counters: {} };
}

function vec(v: unknown): Vec3T | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<Vec3T>;
  if (typeof o.x !== 'number' || typeof o.y !== 'number' || typeof o.z !== 'number') return null;
  return { x: o.x, y: o.y, z: o.z };
}

function dist(a: Vec3T, b: Vec3T): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export class NamingService {
  private registry: RegistryFile;
  private lastRun: NamingRun | null = null;
  private busy = false;
  private inFlight: Promise<NamingRun> | null = null;

  constructor(private readonly deps: NamingDeps) {
    this.registry = this.loadRegistry();
  }

  private loadRegistry(): RegistryFile {
    const raw = this.deps.store.getKv(NAMING_KV);
    if (!raw) return emptyRegistry();
    try {
      const parsed = JSON.parse(raw) as RegistryFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.grids)) return emptyRegistry();
      parsed.counters = parsed.counters ?? {};
      return parsed;
    } catch {
      return emptyRegistry();
    }
  }

  private save(): void {
    this.deps.store.setKv(NAMING_KV, JSON.stringify(this.registry));
  }

  record(gridId: string): NameRecord | null {
    return this.registry.grids.find((g) => g.gridId === gridId) ?? null;
  }

  state() {
    return {
      sun: this.sunSample(),
      scheme: {
        satellite: 'SAT-<R|L|M>-<NNNN>',
        base: 'BASE-NN',
        rules: {
          L: '2+ lasers (radio optional)',
          M: 'radio + exactly 1 laser',
          R: 'radio only',
        },
        blocks: {
          radio: '<grid name>',
          laser: '<grid name> L1/L2',
          programmable: "<owner's tag form> <name>, e.g. [BASE] <name> / [MANAGED] <name> (long tags work too)",
        },
      },
      grids: [...this.registry.grids].sort((a, b) => a.gridId.localeCompare(b.gridId)),
      counters: this.registry.counters,
      lastRun: this.lastRun,
      laserTest: this.laserTest(),
      labels: [
        'GAME: grid/block names written through the plugin and read back',
        'numbers are allocated once and persisted; never reused',
        'ownerOverride=true means the owner renamed the grid; auto-naming no longer touches it',
        `auto-rename is ${namingAutoEnabled() ? 'ON' : 'OFF'} on this instance (RTS_NAMING_AUTO overrides; off by default on live)`,
      ],
    };
  }

  /** Names for the demo site's readout (gridId -> current expected name). */
  names(): { gridId: string; name: string; kind: GridKind; ownerOverride: boolean }[] {
    return this.registry.grids.map((g) => ({ gridId: g.gridId, name: g.name, kind: g.kind, ownerOverride: g.ownerOverride }));
  }

  /**
   * One naming pass over the tagged grids the provisioner just listed.
   * Serialised like the provisioner: a second caller waits for the running pass.
   */
  async sync(grids: TaggedGrid[]): Promise<NamingRun> {
    while (this.busy) {
      const inflight = this.inFlight;
      if (!inflight) break;
      await inflight.catch(() => undefined);
    }
    this.busy = true;
    const pass = this.runSync(grids);
    this.inFlight = pass;
    try {
      return await pass;
    } finally {
      this.busy = false;
      if (this.inFlight === pass) this.inFlight = null;
    }
  }

  private async runSync(grids: TaggedGrid[]): Promise<NamingRun> {
    const profiles = loadProfiles();
    const at = nowOf(this.deps);
    const run: NamingRun = { at, scanned: grids.length, assigned: 0, renamed: 0, overrides: 0, skipped: 0, errors: [] };

    // Live: auto-rename is off unless explicitly configured. Manual renames
    // (POST /api/demo/naming/rename) still work.
    if (!namingAutoEnabled()) {
      run.skipped = grids.length;
      this.lastRun = run;
      return run;
    }

    for (const grid of grids) {
      const owners = [grid.owner, ...(grid.owners ?? [])].filter((v): v is string => typeof v === 'string');
      if (!owners.includes(profiles.owner.identityId)) {
        run.skipped++;
        continue;
      }
      const record = this.record(grid.gridId);
      const observed = (grid.name || grid.pbName || '').trim();
      const kind = this.kindOf(grid, profiles);
      if (!kind) {
        run.skipped++;
        continue;
      }

      if (record?.ownerOverride) {
        run.skipped++;
        continue;
      }

      // Owner renamed in-game: a non-default name that is not ours and was
      // applied successfully. Never guess from a default name.
      if (record && record.renameOk && observed && observed !== record.name && !isDefaultName(observed)) {
        record.ownerOverride = true;
        record.observedName = observed;
        this.deps.store.audit({
          actor: 'naming',
          action: 'naming_owner_override',
          subject: grid.gridId,
          detail: { assigned: record.name, observed, note: 'owner renamed the grid in-game; auto-naming stops' },
          at,
        });
        this.save();
        run.overrides++;
        continue;
      }

      let assignedNow = false;
      if (!record) {
        const cls = kind === 'SAT' ? satClassOf(grid.radioCount ?? 0, grid.laserCount ?? 0) : null;
        const key = kind === 'SAT' ? `${SAT_PREFIX}-${cls}` : BASE_PREFIX;
        const next = (this.registry.counters[key] ?? 0) + 1;
        this.registry.counters[key] = next;
        const name = kind === 'SAT' ? `${SAT_PREFIX}-${cls}-${pad(next, 4)}` : `${BASE_PREFIX}-${pad(next, 2)}`;
        const created: NameRecord = {
          gridId: grid.gridId,
          name,
          kind,
          cls,
          number: next,
          tag: (kind === 'BASE' ? profiles.tags.BASE : profiles.tags.DRONE) ?? '',
          ownerOverride: false,
          observedName: observed || null,
          assignedAt: at,
          appliedAt: null,
          renameOk: false,
          blocks: { radio: grid.radioCount ?? 0, laser: grid.laserCount ?? 0, pb: 1 },
          audit: [],
          lastError: null,
        };
        this.registry.grids.push(created);
        this.registry.counters[key] = next;
        this.save();
        run.assigned++;
        assignedNow = true;
      }

      const rec = this.record(grid.gridId);
      if (!rec) continue;
      rec.observedName = observed || rec.observedName;
      rec.blocks = { radio: grid.radioCount ?? 0, laser: grid.laserCount ?? 0, pb: rec.blocks.pb || 1 };

      const needsApply = assignedNow || !rec.renameOk || (observed !== rec.name && isDefaultName(observed));
      if (!needsApply) {
        run.skipped++;
        continue;
      }

      try {
        await this.applyNames(rec, grid, kind);
        rec.appliedAt = nowOf(this.deps);
        rec.renameOk = true;
        rec.lastError = null;
        run.renamed++;
        this.save();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        rec.lastError = message;
        rec.renameOk = false;
        run.errors.push(`${grid.gridId}: ${message}`);
        this.save();
      }
    }

    this.lastRun = run;
    return run;
  }

  private kindOf(grid: TaggedGrid, profiles: ReturnType<typeof loadProfiles>): GridKind | null {
    // SHIP ROLE: auto-naming is automatic. A personal/owner grid is never
    // renamed, and an OFF grid is only ever read. The shared resolver reads
    // every tag spelling, on any block or in CustomData.
    const res = resolveGridRole(grid, { live: false });
    if (res.role === 'personal' || res.role === 'off') return null;
    if (res.role === 'base') return 'BASE';
    if (isAutomatableRole(res)) return 'SAT';
    const tags = (grid.tags ?? []).map((t) => t.toLowerCase());
    if (tags.includes((profiles.tags.BASE ?? '').toLowerCase())) return 'BASE';
    if (tags.includes((profiles.tags.DRONE ?? '').toLowerCase())) return 'SAT';
    return null;
  }

  /** Write the grid name, then the block names, with a read-back from the plugin. */
  private async applyNames(rec: NameRecord, grid: TaggedGrid, kind: GridKind): Promise<void> {
    const at = nowOf(this.deps);
    const renamedBlocks: Record<string, unknown>[] = [];

    const gridRes = await callPlugin(this.deps, 'rename_grid', { entityId: grid.gridId, name: rec.name }, 15_000);
    if (!gridRes.ok || (gridRes.result?.ok as boolean | undefined) === false) {
      throw new Error(`rename_grid failed: ${gridRes.error ?? 'read-back did not match'}`);
    }

    if ((grid.radioCount ?? 0) > 0) {
      const res = await callPlugin(
        this.deps,
        'rename_block',
        { entityId: grid.gridId, filter: { type: 'RadioAntenna' }, name: rec.name },
        15_000,
      );
      if (!res.ok) throw new Error(`rename radio antennas failed: ${res.error ?? 'plugin error'}`);
      renamedBlocks.push({ what: 'radio', name: rec.name, blocks: res.result?.blocks ?? [] });
    }

    if ((grid.laserCount ?? 0) > 0) {
      // Laser names are ordered L1..Ln by block entity id, so the state action is
      // the source of the ids (never guessed from list_tagged).
      const state = await callPlugin(this.deps, 'laser_state', { gridId: grid.gridId }, 15_000);
      if (!state.ok) throw new Error(`laser_state failed: ${state.error ?? 'plugin error'}`);
      const lasers = ((state.result?.grids as { lasers?: { entityId: string }[] }[] | undefined) ?? [])
        .flatMap((g) => g.lasers ?? [])
        .filter((l) => typeof l.entityId === 'string')
        .sort((a, b) => Number(a.entityId) - Number(b.entityId));
      for (let i = 0; i < lasers.length; i++) {
        const laser = lasers[i];
        if (!laser) continue;
        const blockName = `${rec.name} L${i + 1}`;
        const res = await callPlugin(
          this.deps,
          'rename_block',
          { entityId: grid.gridId, blockEntityId: laser.entityId, name: blockName },
          15_000,
        );
        if (!res.ok) throw new Error(`rename laser ${blockName} failed: ${res.error ?? 'plugin error'}`);
        renamedBlocks.push({ what: `laser${i + 1}`, name: blockName, blocks: res.result?.blocks ?? [] });
      }
    }

    // The PB carries the role tag so the grid is recognisable in game. Keep the
    // owner's own spelling (`[BASE]` stays `[BASE]`) and add NOTHING when the
    // mark lives in CustomData: naming never rewrites the owner's tag.
    const prefix = pbTagPrefix(kind, grid);
    const pbName = prefix ? `${prefix} ${rec.name}` : null;
    const pbRes = pbName
      ? await callPlugin(
          this.deps,
          'rename_block',
          { entityId: grid.gridId, filter: { type: 'ProgrammableBlock' }, name: pbName },
          15_000,
        )
      : null;
    // The owner's grids carry one PB each; zero matches means it was removed, not
    // a naming failure, so record it without failing the grid.
    renamedBlocks.push({
      what: 'programmableBlock',
      name: pbName,
      blocks: pbRes?.ok ? pbRes.result?.blocks ?? [] : [],
      error: pbRes && !pbRes.ok ? pbRes.error : null,
      ...(pbName
        ? {}
        : { skipped: 'role is set in CustomData only: the PB name is left as the owner wrote it' }),
    });

    rec.audit.push(`renamed@${at}`);
    this.deps.store.audit({
      actor: 'naming',
      action: 'naming_rename',
      subject: grid.gridId,
      detail: { name: rec.name, kind, cls: rec.cls, number: rec.number, trigger: 'provisioning sync', blocks: renamedBlocks },
      rollbackPoint: `naming:${grid.gridId}@${at}`,
      at,
    });
  }

  /**
   * Site-initiated rename: rename now, then mark ownerOverride so the service
   * never auto-renames this grid again. Audited with actor owner-request.
   */
  async manualRename(gridId: string, name: string): Promise<{ record: NameRecord; plugin: Record<string, unknown> }> {
    const clean = name.trim();
    if (!clean) throw new Error('name is required');
    if (clean.length > 60) throw new Error('name must be 60 characters or fewer');

    let rec = this.record(gridId);
    if (!rec) {
      // A grid the service has not seen yet: still allow the owner to name it.
      rec = {
        gridId,
        name: clean,
        kind: 'SAT',
        cls: null,
        number: 0,
        tag: '',
        ownerOverride: true,
        observedName: null,
        assignedAt: nowOf(this.deps),
        appliedAt: null,
        renameOk: false,
        blocks: { radio: 0, laser: 0, pb: 0 },
        audit: [],
        lastError: null,
      };
      this.registry.grids.push(rec);
    }
    const previous = rec.name;

    const gridRes = await callPlugin(this.deps, 'rename_grid', { entityId: gridId, name: clean }, 15_000);
    if (!gridRes.ok || (gridRes.result?.ok as boolean | undefined) === false) {
      throw new Error(`rename_grid failed: ${gridRes.error ?? 'read-back did not match'}`);
    }

    rec.name = clean;
    rec.ownerOverride = true;
    rec.renameOk = true;
    rec.appliedAt = nowOf(this.deps);
    rec.audit.push(`manual@${rec.appliedAt}`);

    this.deps.store.audit({
      actor: 'owner-request',
      action: 'naming_rename',
      subject: gridId,
      detail: { previous, name: clean, trigger: 'site rename', ownerOverride: true, plugin: gridRes.result ?? null },
      rollbackPoint: `naming:${gridId}@${rec.appliedAt}`,
      at: rec.appliedAt,
    });
    this.save();
    return { record: rec, plugin: gridRes.result ?? {} };
  }

  laserTest(): LaserTestState | null {
    const raw = this.deps.store.getKv(LASER_TEST_KV);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LaserTestState;
    } catch {
      return null;
    }
  }

  /**
   * Aim, connect, poll and disconnect a laser pair between two of the owner's
   * satellites. The grids are never moved; only the laser blocks are aimed and
   * switched. The link result is whatever the game reports — never inferred.
   */
  async runLaserTest(opts: { gridA?: string; gridB?: string; timeoutMs?: number; permanent?: boolean } = {}): Promise<LaserTestState> {
    const profiles = loadProfiles();
    const timeoutMs = Math.max(5_000, Math.min(120_000, opts.timeoutMs ?? 60_000));
    const permanent = opts.permanent === true;
    const started = nowOf(this.deps);
    const result: LaserTestState = {
      at: started,
      ok: false,
      reason: null,
      gridA: null,
      gridB: null,
      distanceM: null,
      timeoutS: Math.round(timeoutMs / 1000),
      elapsedS: null,
      connected: false,
      finalStatus: { a: null, b: null },
      power: { a: null, b: null },
      connectedTo: { a: null, b: null },
      permanent,
      samples: [],
      cleanup: null,
      labels: [
        'GAME: laser status/target/connected-to read from the live block',
        'GAME: SetTargetCoords + Connect issued on the game thread; grids not moved',
        'power values are the block definition draw for idle/turning/lasing',
      ],
    };

    const listed = await callPlugin(this.deps, 'list_tagged', { tags: [profiles.tags.DRONE] }, 15_000);
    const tagged = ((listed.result?.grids as TaggedGrid[] | undefined) ?? []).filter(
      (g) =>
        g &&
        [g.owner, ...(g.owners ?? [])].includes(profiles.owner.identityId) &&
        (g.laserCount ?? 0) > 0 &&
        shipRoles.roleOf(g.gridId) === 'managed',
    );
    if (tagged.length < 2) throw new Error('need two owner-tagged satellites with laser antennas');

    const ids = tagged.map((g) => g.gridId);
    const state = await callPlugin(this.deps, 'laser_state', { gridIds: ids }, 20_000);
    if (!state.ok) throw new Error(`laser_state failed: ${state.error ?? 'plugin error'}`);
    const live = ((state.result?.grids as LaserGrid[] | undefined) ?? []).filter((g) => (g.lasers?.length ?? 0) > 0);

    let a: LaserGrid | undefined;
    let b: LaserGrid | undefined;
    if (opts.gridA || opts.gridB) {
      a = live.find((g) => g.gridId === opts.gridA);
      b = live.find((g) => g.gridId === opts.gridB);
    } else {
      const pair = bestLaserPair(live);
      a = pair?.a;
      b = pair?.b;
    }
    if (a == null || b == null || a.gridId === b.gridId) throw new Error('could not resolve two grids with laser antennas');

    const la = a.lasers[0];
    const lb = b.lasers[0];
    if (!la || !lb) throw new Error('chosen grid has no laser antenna');
    const pa = vec(la.position);
    const pb = vec(lb.position);
    if (!pa || !pb) throw new Error('laser block has no live position');
    const distance = dist(pa, pb);
    result.distanceM = Math.round(distance * 10) / 10;
    result.gridA = { gridId: a.gridId, name: a.name, laserEntityId: la.entityId, position: pa };
    result.gridB = { gridId: b.gridId, name: b.name, laserEntityId: lb.entityId, position: pb };
    result.power = { a: la.powerDrawMw ?? null, b: lb.powerDrawMw ?? null };

    const limit = Math.min(rangeOf(la), rangeOf(lb));
    if (distance > limit) {
      result.reason = `distance ${result.distanceM} m exceeds laser range ${limit} m`;
      result.elapsedS = 0;
      this.saveLaserTest(result);
      return result;
    }

    // 1. Isolate the chosen blocks: earlier runs leave other lasers aimed and
    //    powered, and the provisioning profile keeps lasers off when idle, so
    //    this is also the state the cleanup restores. The connect sequence
    //    itself (OnOff -> target partner BLOCK -> connect -> poll -> retry) is
    //    shared with the planner and the supervisor: `LaserLinker`.
    for (const g of [a, b]) {
      await callPlugin(this.deps, 'set_block_props', {
        entityId: g.gridId,
        filter: { type: 'LaserAntenna' },
        props: { OnOff: false },
      }, 15_000).catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 1000));

    const link = await new LaserLinker({
      call: (action, params, timeout) => callPlugin(this.deps, action, params, timeout),
      now: () => nowOf(this.deps),
    }).connect({
      a: { gridId: a.gridId, laserBlockId: la.entityId },
      b: { gridId: b.gridId, laserBlockId: lb.entityId },
      permanent,
      // Contract §2: poll at most 20 s per attempt, then retry once.
      timeoutMs: Math.min(timeoutMs, 20_000),
      keepConnected: false,
      onSample: (sample) => {
        result.samples.push({
          t: Math.round((nowOf(this.deps) - started) / 100) / 10,
          a: sample.a ?? 'missing',
          b: sample.b ?? 'missing',
        });
        if (result.samples.length > 40) result.samples.shift();
      },
    });

    result.elapsedS = link.elapsedS;
    result.connected = link.ok;
    result.ok = link.ok;
    result.finalStatus = link.finalStatus;
    result.connectedTo = link.connectedTo;
    result.reason = link.ok ? null : link.error;
    const turnedOn = (link.enabled.a ? 1 : 0) + (link.enabled.b ? 1 : 0);
    // Power draw / grid names are part of the report, not of the sequence.
    try {
      const after = await callPlugin(this.deps, 'laser_state', { gridIds: [a.gridId, b.gridId] }, 15_000);
      const grids = (after.result?.grids as LaserGrid[] | undefined) ?? [];
      const sa = grids.find((g) => g.gridId === a!.gridId)?.lasers?.[0];
      const sb = grids.find((g) => g.gridId === b!.gridId)?.lasers?.[0];
      result.power = { a: sa?.powerDrawMw ?? result.power.a, b: sb?.powerDrawMw ?? result.power.b };
      result.gridA.name = grids.find((g) => g.gridId === a!.gridId)?.name ?? result.gridA.name;
      result.gridB.name = grids.find((g) => g.gridId === b!.gridId)?.name ?? result.gridB.name;
    } catch {
      /* power/name enrichment is optional */
    }

    // Leave the hardware as the provisioning profile wants it: link dropped and
    // lasers switched off. Report what the cleanup actually did.
    let disconnects = link.disconnect ? Number(link.disconnect.a) + Number(link.disconnect.b) : 0;
    let lasersOff = 0;
    for (const g of [a, b]) {
      try {
        const res = await callPlugin(this.deps, 'set_block_props', {
          entityId: g.gridId,
          filter: { type: 'LaserAntenna' },
          props: { OnOff: false },
        }, 15_000);
        if (res.ok) lasersOff++;
      } catch {
        /* recorded as a partial cleanup */
      }
    }
    result.cleanup = {
      disconnects,
      lasersOff,
      note: `lasers were switched on for the test (${turnedOn}/2 grids) and set back to OnOff=false`,
    };

    this.saveLaserTest(result);
    this.deps.store.audit({
      actor: 'naming',
      action: 'laser_test',
      subject: `${a.gridId}<->${b.gridId}`,
      detail: {
        ok: result.ok,
        connected: result.connected,
        distanceM: result.distanceM,
        elapsedS: result.elapsedS,
        finalStatus: result.finalStatus,
        connectedTo: result.connectedTo,
        power: result.power,
        cleanup: result.cleanup,
        samples: result.samples,
      },
      at: nowOf(this.deps),
    });
    return result;
  }

  private saveLaserTest(result: LaserTestState): void {
    this.deps.store.setKv(LASER_TEST_KV, JSON.stringify(result));
  }

  /** Latest sun direction the plugin put in telemetry (null until one lands). */
  sunSample(): { sun: Vec3T | null; state: string | null; at: number } | null {
    const raw = this.deps.store.getKv('telemetry:sun');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { sun: Vec3T | null; state: string | null; at: number };
    } catch {
      return null;
    }
  }
}

interface LaserGrid {
  gridId: string;
  name: string;
  laserCount: number;
  lasers: {
    entityId: string;
    name: string;
    position?: Vec3T;
    status?: string;
    rangeM?: number;
    maxRangeM?: number;
    powerDrawMw?: unknown;
    otherGridId?: string | null;
  }[];
}

function rangeOf(l: { maxRangeM?: number; rangeM?: number }): number {
  const max = typeof l.maxRangeM === 'number' && l.maxRangeM > 0 ? l.maxRangeM : 0;
  const range = typeof l.rangeM === 'number' && l.rangeM > 0 ? l.rangeM : 0;
  return max > 0 ? max : range > 0 ? range : Infinity;
}

/** Pick the closest pair that fits inside both lasers' range (best LOS odds). */
export function bestLaserPair(grids: LaserGrid[]): { a: LaserGrid; b: LaserGrid } | null {
  let best: { a: LaserGrid; b: LaserGrid; d: number } | null = null;
  for (let i = 0; i < grids.length; i++) {
    for (let j = i + 1; j < grids.length; j++) {
      const a = grids[i];
      const b = grids[j];
      if (!a || !b) continue;
      const la = a.lasers[0];
      const lb = b.lasers[0];
      if (!la || !lb) continue;
      const pa = vec(la.position);
      const pb = vec(lb.position);
      if (!pa || !pb) continue;
      const d = dist(pa, pb);
      const limit = Math.min(rangeOf(la), rangeOf(lb));
      if (d > limit || d < 1) continue;
      if (!best || d < best.d) best = { a, b, d };
    }
  }
  return best ? { a: best.a, b: best.b } : null;
}

// ------------------------------------------------------------- process wiring

let singleton: NamingService | null = null;
let singletonStore: Store | null = null;

export function namingFor(deps: NamingDeps): NamingService {
  if (!singleton || singletonStore !== deps.store) {
    singleton = new NamingService(deps);
    singletonStore = deps.store;
  }
  return singleton;
}

export function resetNamingForTests(): void {
  singleton = null;
  singletonStore = null;
}

/** Adapter for the provisioner hook: never let naming break provisioning. */
export function namingSyncHook(deps: NamingDeps): (grids: TaggedGrid[]) => Promise<void> {
  return async (grids: TaggedGrid[]) => {
    try {
      await namingFor(deps).sync(grids);
    } catch {
      /* the provisioner pass must not fail because naming did */
    }
  };
}

export type { ProvisionDeps };
