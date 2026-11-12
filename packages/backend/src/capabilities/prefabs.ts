import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sax from 'sax';
import type { CapabilityProfile } from '@se-rts/schemas';
import { profileGrid, type RawBlock, type RawGrid } from './profiler.js';
import { loadDefinitions, type DefinitionIndex } from './definitions.js';
import { estimateGridMass, loadMassTables, type MassTables } from './massTables.js';
import { emptyContext, type SaveContext } from './saveContext.js';

/**
 * READ-ONLY prefab profiler. Space Engineers prefab `.sbc` files wrap one or
 * more `MyObjectBuilder_CubeGrid` entries inside
 * `<Prefabs><Prefab xsi:type="MyObjectBuilder_PrefabDefinition">`, so the same
 * block/definition rules as a sector save apply. A prefab can hold several
 * grids (a ship plus subgrids); the grid with the most blocks is the main
 * grid and only it is profiled in detail.
 */

export interface PrefabGrid extends RawGrid {
  /** Index of this grid inside the prefab file. */
  index: number;
}

export interface PrefabProfile {
  /** Prefab SubtypeId, e.g. `(NPC-CD) Arrow Drone (V)`. */
  subtype: string;
  /** File name without extension (falls back to subtype). */
  file: string;
  /** Directory of the prefab file (identifies vanilla vs mod source). */
  source: string;
  gridCount: number;
  grids: PrefabGrid[];
  /** Index into `grids`; the block-heaviest grid. */
  mainGridIndex: number;
  /** Capability profile of the main grid. */
  main: CapabilityProfile;
  /** Block counts of every grid, in file order. */
  gridBlockCounts: number[];
  /** Mass estimate of the main grid in kg (`null` when not derivable). */
  estimatedMassKg: number | null;
  /**
   * DN subspace-cost estimate: block count x the per-cell cost of the grid's
   * cube size (small grid 1 PCU/cell, large grid 10). This is the projection
   * model the test server uses for prefab grids; it is not the blueprint PCU.
   */
  estimatedPcu: number | null;
}

/** Legacy prefabs (`LegacyContent/*`) are gzip-compressed XML despite `.sbc`. */
export function readPrefabText(file: string): string {
  const buf = fs.readFileSync(file);
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf).toString('utf8');
  return buf.toString('utf8');
}

/** Collects every `<CubeGrid>` in a prefab file, with the prefab SubtypeId. */
export function parsePrefabFile(file: string): Promise<{ subtype: string; grids: RawGrid[] }> {
  return new Promise((resolve, reject) => {
    const parser = sax.parser(true, { trim: true, normalize: false });
    const stack: string[] = [];
    const grids: RawGrid[] = [];
    let prefabSubtype = '';
    let prefabDepth = 0;

    let grid: RawGrid | null = null;
    let gridDepth = 0;
    let block: RawBlock | null = null;
    let blockDepth = 0;
    let capture: { tag: string; depth: number; parts: string[] } | null = null;

    const commit = (depth: number, tag: string, value: string): void => {
      if (block && depth === blockDepth + 1) {
        if (tag === 'SubtypeName') block.subtype = value;
        else if (tag === 'Enabled') block.enabled = value.toLowerCase() === 'true' ? true : value.toLowerCase() === 'false' ? false : null;
        else if (tag === 'EnableBroadcasting') block.broadcasting = value.toLowerCase() === 'true' ? true : value.toLowerCase() === 'false' ? false : null;
        else if (tag === 'BroadcastRadius') block.broadcastRadius = Number.isFinite(Number(value)) ? Number(value) : null;
        else if (tag === 'CurrentStoredPower') block.currentStoredPower = Number.isFinite(Number(value)) ? Number(value) : null;
        else if (tag === 'MaxStoredPower') block.maxStoredPower = Number.isFinite(Number(value)) ? Number(value) : null;
        else if (tag === 'FilledRatio') block.filledRatio = Number.isFinite(Number(value)) ? Number(value) : null;
        return;
      }
      if (grid && depth === gridDepth + 1) {
        if (tag === 'EntityId') grid.id = value;
        else if (tag === 'DisplayName') grid.name = value;
        else if (tag === 'Name' && !grid.name) grid.name = value;
        else if (tag === 'GridSizeEnum') {
          grid.sizeClass = value.toLowerCase() === 'large' ? 'large' : value.toLowerCase() === 'small' ? 'small' : 'unknown';
        } else if (tag === 'IsStatic') grid.isStatic = value.toLowerCase() === 'true';
        else if (tag === 'Mass') grid.massKg = Number.isFinite(Number(value)) ? Number(value) : null;
        return;
      }
      // `<Id Type="MyObjectBuilder_PrefabDefinition" Subtype="..."/>` is the
      // self-closing form; map files instead nest `<Id Subtype="...">`.
      if (prefabDepth > 0 && depth === prefabDepth + 1 && tag === 'Id' && value) {
        if (!prefabSubtype) prefabSubtype = value;
      }
    };

    parser.onopentag = (node) => {
      stack.push(node.name);
      const depth = stack.length;
      const name = node.name;
      const attrs = node.attributes as Record<string, string | undefined>;

      if (name === 'Prefab') {
        prefabDepth = depth;
        return;
      }
      if (!grid && name === 'CubeGrid') {
        grid = {
          id: '',
          name: '',
          sizeClass: 'unknown',
          isStatic: false,
          position: null,
          massKg: null,
          blocks: [],
        };
        gridDepth = depth;
        return;
      }
      if (!grid) {
        // Prefab id: self-closing `<Id Subtype="..."/>` or `<Id Subtype="...">`.
        if (prefabDepth > 0 && name === 'Id' && depth === prefabDepth + 1) {
          const subtype = attrs.Subtype ?? attrs['xsi:subtype'];
          if (subtype && !prefabSubtype) prefabSubtype = subtype;
        }
        return;
      }

      if (depth === gridDepth + 1) {
        if (['EntityId', 'DisplayName', 'Name', 'GridSizeEnum', 'IsStatic', 'Mass'].includes(name)) {
          capture = { tag: name, depth, parts: [] };
        }
        return;
      }
      if (name === 'Position' && stack[depth - 2] === 'PositionAndOrientation') {
        const x = Number(attrs.x ?? NaN);
        const y = Number(attrs.y ?? NaN);
        const z = Number(attrs.z ?? NaN);
        if ([x, y, z].every(Number.isFinite)) grid.position = { x, y, z };
        return;
      }
      if (stack[depth - 2] === 'CubeBlocks' && !block) {
        const type = attrs['xsi:type'];
        block = {
          kind: (type?.trim() || name).replace(/^MyObjectBuilder_/, ''),
          subtype: '',
          owner: null,
          enabled: null,
          broadcasting: null,
          broadcastRadius: null,
          currentStoredPower: null,
          maxStoredPower: null,
          filledRatio: null,
        };
        blockDepth = depth;
        return;
      }
      if (block && depth === blockDepth + 1) {
        if (['SubtypeName', 'Enabled', 'EnableBroadcasting', 'BroadcastRadius', 'CurrentStoredPower', 'MaxStoredPower', 'FilledRatio'].includes(name)) {
          capture = { tag: name, depth, parts: [] };
        }
      }
    };

    parser.ontext = (text) => {
      if (capture && stack.length === capture.depth) capture.parts.push(text);
    };
    parser.oncdata = parser.ontext as (text: string) => void;

    parser.onclosetag = () => {
      const depth = stack.length;
      const closing = stack[depth - 1];
      if (capture && depth === capture.depth) {
        commit(depth, capture.tag, capture.parts.join('').trim());
        capture = null;
      }
      if (block && depth === blockDepth) {
        grid?.blocks.push(block);
        block = null;
      }
      if (grid && depth === gridDepth) {
        grids.push(grid);
        grid = null;
      }
      if (closing === 'Prefab' && depth === prefabDepth) prefabDepth = 0;
      stack.pop();
    };

    parser.onerror = (err) => {
      reject(err);
      parser.resume();
    };
    parser.onend = () => resolve({ subtype: prefabSubtype, grids });
    let text: string;
    try {
      text = readPrefabText(file);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    parser.write(text);
    parser.close();
  });
}

/** Every `.sbc` under a prefabs root (recursive, deterministic order). */
export function findPrefabFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.sbc$/i.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Profiles one prefab file; returns null when it holds no grid. */
export async function profilePrefabFile(
  file: string,
  opts: { definitions: DefinitionIndex; context?: SaveContext; massTables?: MassTables; now?: number },
): Promise<PrefabProfile | null> {
  const parsed = await parsePrefabFile(file);
  if (parsed.grids.length === 0) return null;
  const context = opts.context ?? emptyContext();
  const grids: PrefabGrid[] = parsed.grids.map((g, index) => ({ ...g, index }));
  let mainGridIndex = 0;
  for (let i = 1; i < grids.length; i += 1) {
    if (grids[i]!.blocks.length > grids[mainGridIndex]!.blocks.length) mainGridIndex = i;
  }
  const gridMain = profileGrid(grids[mainGridIndex]!, { definitions: opts.definitions, context, now: opts.now });
  // Prefabs do not serialize grid mass, so it is derived from the block set.
  const estimatedMassKg = opts.massTables
    ? estimateGridMass(
        grids[mainGridIndex]!.blocks.map((b) => b.subtype),
        opts.massTables,
      )
    : null;
  const main: CapabilityProfile = gridMain;
  const withMass: CapabilityProfile =
    main.massKg === null && estimatedMassKg !== null
      ? {
          ...main,
          massKg: estimatedMassKg,
          roles: {
            ...main.roles,
            canFlyInGravity:
              main.roles.canFlyInGravity === 'unknown' && main.thrusters.atmo.totalForceN !== null && main.thrusters.hydrogen.totalForceN !== null
                ? (main.thrusters.atmo.totalForceN ?? 0) + (main.thrusters.hydrogen.totalForceN ?? 0) >= estimatedMassKg * 9.81
                : main.roles.canFlyInGravity,
          },
        }
      : main;
  return {
    subtype: parsed.subtype || path.basename(file, path.extname(file)),
    file: path.basename(file, path.extname(file)),
    source: path.dirname(file),
    gridCount: grids.length,
    grids,
    mainGridIndex,
    main: withMass,
    gridBlockCounts: grids.map((g) => g.blocks.length),
    estimatedMassKg,
    estimatedPcu: main.sizeClass === 'small' ? main.blockCount : main.sizeClass === 'large' ? main.blockCount * 10 : null,
  };
}

export interface PrefabScanOptions {
  /** One or more prefab directories (scanned recursively). */
  prefabRoots: string[];
  /** CubeBlocks definition root. */
  defsPath: string;
  /** Roots holding `Components*.sbc` (mass table for the mass estimate). */
  componentRoots?: string[];
  now?: number;
}

export async function profilePrefabs(opts: PrefabScanOptions): Promise<{ prefabs: PrefabProfile[]; filesScanned: number }> {
  const definitions = await loadDefinitions(opts.defsPath);
  // The DS ships no component mass table, so mass is only estimated when
  // `componentRoots` give one; otherwise the field stays null (never guessed).
  const massTables = opts.componentRoots?.length ? loadMassTables(opts.defsPath, opts.componentRoots) : undefined;
  const context = emptyContext();
  const files = opts.prefabRoots.flatMap((root) => findPrefabFiles(root));
  const prefabs: PrefabProfile[] = [];
  for (const file of files) {
    const p = await profilePrefabFile(file, { definitions, context, massTables, now: opts.now });
    if (p) prefabs.push(p);
  }
  prefabs.sort((a, b) => a.subtype.localeCompare(b.subtype) || a.source.localeCompare(b.source));
  return { prefabs, filesScanned: files.length };
}

