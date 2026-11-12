import fs from 'node:fs';
import sax from 'sax';
import {
  type BeaconProfile,
  type CapabilityProfile,
  type CapabilityReport,
  type DefinitionSourcedNumber,
  type LaserAntennaProfile,
  type RadioAntennaProfile,
  type ThrusterGroup,
} from '@se-rts/schemas';
import { isRealPlayer, loadSaveContext, type SaveContext } from './saveContext.js';
import { loadDefinitions, type BlockDefinition, type DefinitionIndex } from './definitions.js';

/**
 * READ-ONLY grid capability profiler. It parses a *copy* of the synced save
 * (never writes) plus the local CubeBlocks definitions. Every number taken
 * from a definition records the subtype it came from; anything undeterminable
 * is `null` rather than an estimate.
 */

export interface RawBlock {
  kind: string;
  subtype: string;
  owner: string | null;
  enabled: boolean | null;
  broadcasting: boolean | null;
  broadcastRadius: number | null;
  currentStoredPower: number | null;
  maxStoredPower: number | null;
  filledRatio: number | null;
}

export interface RawGrid {
  id: string;
  name: string;
  sizeClass: 'large' | 'small' | 'unknown';
  isStatic: boolean;
  position: { x: number; y: number; z: number } | null;
  massKg: number | null;
  blocks: RawBlock[];
}

const GRAVITY = 9.81;

function cleanName(value: string): string {
  return [...(value ?? '')]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return !(code >= 0xe000 && code <= 0xf8ff) && ch !== '\u200b' && ch !== '\ufeff';
    })
    .join('')
    .trim();
}

function parseNum(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

function parseBool(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function kindFrom(type: string | undefined, tag: string): string {
  const base = type?.trim() || tag;
  return base.replace(/^MyObjectBuilder_/, '');
}

function isGridOpen(name: string, type: string | undefined): boolean {
  if (name === 'MyObjectBuilder_CubeGrid') return true;
  return name === 'MyObjectBuilder_EntityBase' && Boolean(type?.endsWith('MyObjectBuilder_CubeGrid'));
}

interface GridCapture {
  field: string;
  depth: number;
  parts: string[];
}

/** Streams the sector file and returns every top-level grid. */
export function parseSectorGrids(
  stream: NodeJS.ReadableStream,
  opts: { excludePirateStations?: boolean } = {},
): Promise<{ grids: RawGrid[]; excluded: number }> {
  const excludePirateStations = opts.excludePirateStations ?? true;
  return new Promise((resolve, reject) => {
    const parser = sax.parser(true, { trim: true, normalize: false });
    const stack: string[] = [];
    const grids: RawGrid[] = [];
    let excluded = 0;

    let pirateDepth = 0;
    let grid: RawGrid | null = null;
    let gridDepth = 0;
    let gridTag = '';
    let block: RawBlock | null = null;
    let blockDepth = 0;
    let capture: GridCapture | null = null;

    const commit = (depth: number, field: string, value: string): void => {
      if (block && depth === blockDepth + 1) {
        if (field === 'SubtypeName') block.subtype = value;
        else if (field === 'Owner' || field === 'BuiltBy') {
          if (block.owner === null && value && value !== '0') block.owner = value;
        } else if (field === 'Enabled') block.enabled = parseBool(value);
        else if (field === 'EnableBroadcasting') block.broadcasting = parseBool(value);
        else if (field === 'BroadcastRadius') block.broadcastRadius = parseNum(value);
        else if (field === 'CurrentStoredPower') block.currentStoredPower = parseNum(value);
        else if (field === 'MaxStoredPower') block.maxStoredPower = parseNum(value);
        else if (field === 'FilledRatio') block.filledRatio = parseNum(value);
        return;
      }
      if (grid && depth === gridDepth + 1) {
        if (field === 'EntityId') grid.id = value;
        else if (field === 'DisplayName') grid.name = value;
        else if (field === 'Name' && !grid.name) grid.name = value;
        else if (field === 'GridSizeEnum') {
          grid.sizeClass = value.toLowerCase() === 'large' ? 'large' : value.toLowerCase() === 'small' ? 'small' : 'unknown';
        } else if (field === 'IsStatic') grid.isStatic = value.toLowerCase() === 'true';
        else if (field === 'Mass') grid.massKg = parseNum(value);
      }
    };

    parser.onopentag = (node) => {
      stack.push(node.name);
      const depth = stack.length;
      const name = node.name;
      const attrs = node.attributes as Record<string, string | undefined>;
      const type = attrs['xsi:type'];

      if (name === 'SerializedPirateStation') {
        pirateDepth += 1;
        return;
      }
      if (excludePirateStations && pirateDepth > 0) return;

      if (!grid && isGridOpen(name, type)) {
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
        gridTag = name;
        return;
      }
      if (!grid) return;

      if (depth === gridDepth + 1) {
        if (['EntityId', 'DisplayName', 'Name', 'GridSizeEnum', 'IsStatic', 'Mass'].includes(name)) {
          capture = { field: name, depth, parts: [] };
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
        block = {
          kind: kindFrom(type, name),
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
        if (
          [
            'SubtypeName',
            'Owner',
            'BuiltBy',
            'Enabled',
            'EnableBroadcasting',
            'BroadcastRadius',
            'CurrentStoredPower',
            'MaxStoredPower',
            'FilledRatio',
          ].includes(name)
        ) {
          capture = { field: name, depth, parts: [] };
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
        const value = capture.parts.join('').trim();
        commit(depth, capture.field, value);
        capture = null;
      }
      if (block && depth === blockDepth) {
        if (grid) grid.blocks.push(block);
        block = null;
      }
      if (grid && depth === gridDepth) {
        if (grid.id) grids.push(grid);
        grid = null;
      }
      if (closing === 'SerializedPirateStation' && pirateDepth > 0) {
        if (excludePirateStations) excluded += 1;
        pirateDepth -= 1;
      }
      stack.pop();
    };

    parser.onerror = (err) => {
      reject(err);
      parser.resume();
    };
    parser.onend = () => resolve({ grids, excluded });
    stream.on('data', (chunk) => parser.write((chunk as Buffer).toString('utf8')));
    stream.on('end', () => parser.close());
    stream.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

interface SubtypeBucket {
  count: number;
  value: number | null;
  source: 'definition' | 'save';
}

function bucketForce(buckets: Map<string, SubtypeBucket>, subtype: string, def: BlockDefinition | undefined, missing: Set<string>): void {
  const bucket = buckets.get(subtype) ?? { count: 0, value: null, source: 'definition' };
  bucket.count += 1;
  if (!def) {
    missing.add(subtype);
    bucket.value = null;
  } else {
    bucket.value = def.forceMagnitudeN;
    bucket.source = 'definition';
  }
  buckets.set(subtype, bucket);
}

function finishGroup(buckets: Map<string, SubtypeBucket>): ThrusterGroup {
  let count = 0;
  let total: number | null = 0;
  const bySubtype = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([subtype, b]) => {
      count += b.count;
      if (b.value === null || total === null) total = null;
      else total += b.value * b.count;
      return {
        subtype,
        count: b.count,
        forceN: b.value === null ? null : { value: b.value, source: b.source, subtype },
      };
    });
  return { count, totalForceN: total, bySubtype };
}

function sourced(value: number, subtype: string, source: 'definition' | 'save' = 'definition'): DefinitionSourcedNumber {
  return { value, source, subtype };
}

function emptyGroup(): ThrusterGroup {
  return { count: 0, totalForceN: 0, bySubtype: [] };
}

export interface ProfileOptions {
  definitions: DefinitionIndex;
  context: SaveContext;
  now?: number;
}

export function profileGrid(raw: RawGrid, opts: ProfileOptions): CapabilityProfile {
  const { definitions, context } = opts;
  const missing = new Set<string>();

  const ownerCounts = new Map<string, number>();
  for (const block of raw.blocks) {
    if (block.owner) ownerCounts.set(block.owner, (ownerCounts.get(block.owner) ?? 0) + 1);
  }
  const ownerIdentityId =
    [...ownerCounts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  const ownerName = ownerIdentityId ? context.identities.get(ownerIdentityId)?.name ?? null : null;
  const factionId = ownerIdentityId ? context.factionOfIdentity.get(ownerIdentityId) : undefined;
  const faction = factionId ? context.factions.get(factionId) : undefined;
  const ownerKind =
    ownerIdentityId === null
      ? 'unknown'
      : isRealPlayer(context, ownerIdentityId)
        ? 'player'
        : context.identities.has(ownerIdentityId)
          ? 'npc'
          : 'unknown';

  const radioAntennas: RadioAntennaProfile[] = [];
  const laserAntennas: LaserAntennaProfile[] = [];
  const beacons: BeaconProfile[] = [];
  let programmableBlocks = 0;
  let remoteControls = 0;
  let cockpits = 0;
  let gyros = 0;
  let batteryCount = 0;
  let batteryCapacity: number | null = 0;
  let batteryStored: number | null = 0;
  let reactorCount = 0;
  let reactorOutput: number | null = 0;
  let solarCount = 0;
  let solarOutput: number | null = 0;
  let tankCount = 0;
  let tankCapacity: number | null = 0;
  let tankFilledL: number | null = 0;
  let tankFillRatio: number | null = null;
  let tankHasRatio = false;
  let tankRatioWeighted = 0;
  let batterySawStored = false;
  let batteryStoredBlocks = 0;
  let tankRatioBlocks = 0;
  let thrusterDefinitionMissing = false;

  const atmo = new Map<string, SubtypeBucket>();
  const ion = new Map<string, SubtypeBucket>();
  const hydrogen = new Map<string, SubtypeBucket>();
  const batteryDefs = new Map<string, SubtypeBucket>();
  const reactorDefs = new Map<string, SubtypeBucket>();
  const solarDefs = new Map<string, SubtypeBucket>();
  const tankDefs = new Map<string, { count: number; capacityL: number | null }>();

  const addPower = (
    buckets: Map<string, SubtypeBucket>,
    subtype: string,
    def: BlockDefinition | undefined,
  ): void => {
    const bucket = buckets.get(subtype) ?? { count: 0, value: null, source: 'definition' };
    bucket.count += 1;
    if (!def) {
      missing.add(subtype);
      bucket.value = null;
    } else {
      bucket.value = def.maxPowerOutputMW;
      bucket.source = 'definition';
    }
    buckets.set(subtype, bucket);
  };

  for (const block of raw.blocks) {
    const subtype = block.subtype || '<unnamed>';
    const kind = block.kind;
    if (kind === 'RadioAntenna') {
      const def = definitions.get(subtype, 'radioAntenna');
      if (!def) missing.add(subtype);
      radioAntennas.push({
        subtype,
        radiusM: block.broadcastRadius,
        maxRadiusM: def?.maxBroadcastRadiusM === null || def?.maxBroadcastRadiusM === undefined
          ? null
          : sourced(def.maxBroadcastRadiusM, subtype),
        enabled: block.enabled,
        broadcasting: block.broadcasting,
      });
    } else if (kind === 'LaserAntenna') {
      const def = definitions.get(subtype, 'laserAntenna');
      if (!def) missing.add(subtype);
      const rawRange = def?.maxRangeM ?? null;
      const unlimited = rawRange === null ? null : rawRange < 0;
      laserAntennas.push({
        subtype,
        maxRangeM: rawRange !== null && rawRange >= 0 ? sourced(rawRange, subtype) : null,
        unlimited,
        enabled: block.enabled,
      });
    } else if (kind === 'Beacon') {
      const def = definitions.get(subtype, 'beacon');
      if (!def) missing.add(subtype);
      beacons.push({
        subtype,
        radiusM: block.broadcastRadius,
        maxRadiusM: def?.maxBroadcastRadiusM === null || def?.maxBroadcastRadiusM === undefined
          ? null
          : sourced(def.maxBroadcastRadiusM, subtype),
        enabled: block.enabled,
        broadcasting: block.broadcasting,
      });
    } else if (kind === 'MyProgrammableBlock' || kind.endsWith('ProgrammableBlock')) {
      programmableBlocks += 1;
    } else if (kind === 'RemoteControl') {
      remoteControls += 1;
    } else if (kind === 'Cockpit') {
      cockpits += 1;
    } else if (kind === 'Gyro') {
      gyros += 1;
    } else if (kind === 'Thrust') {
      const def = definitions.get(subtype, 'thrust');
      if (!def) {
        missing.add(subtype);
        thrusterDefinitionMissing = true;
      }
      const type = def?.thrusterType ?? null;
      if (type === 'Atmospheric') bucketForce(atmo, subtype, def, missing);
      else if (type === 'Ion') bucketForce(ion, subtype, def, missing);
      else if (type === 'Hydrogen') bucketForce(hydrogen, subtype, def, missing);
      // A thruster whose definition is missing cannot be classified; it is
      // recorded in missingDefinitions instead of guessed into a group.
    } else if (kind === 'BatteryBlock') {
      batteryCount += 1;
      const def = definitions.get(subtype, 'battery');
      if (!def) missing.add(subtype);
      const perBlock =
        block.maxStoredPower !== null && block.maxStoredPower > 0
          ? { value: block.maxStoredPower, source: 'save' as const }
          : def?.maxStoredPowerMWh !== undefined && def.maxStoredPowerMWh !== null
            ? { value: def.maxStoredPowerMWh, source: 'definition' as const }
            : null;
      const bucket = batteryDefs.get(subtype) ?? { count: 0, value: perBlock?.value ?? null, source: perBlock?.source ?? 'definition' };
      bucket.count += 1;
      bucket.value = perBlock?.value ?? null;
      if (perBlock) bucket.source = perBlock.source;
      batteryDefs.set(subtype, bucket);
      if (perBlock === null || batteryCapacity === null) batteryCapacity = null;
      else batteryCapacity += perBlock.value;
      if (block.currentStoredPower !== null) {
        batterySawStored = true;
        batteryStoredBlocks += 1;
        batteryStored = (batteryStored ?? 0) + block.currentStoredPower;
      }
    } else if (kind === 'Reactor') {
      reactorCount += 1;
      const def = definitions.get(subtype, 'reactor');
      if (!def) missing.add(subtype);
      addPower(reactorDefs, subtype, def);
      if (def?.maxPowerOutputMW === undefined || def.maxPowerOutputMW === null || reactorOutput === null) reactorOutput = null;
      else reactorOutput += def.maxPowerOutputMW;
    } else if (kind === 'SolarPanel') {
      solarCount += 1;
      const def = definitions.get(subtype, 'solar');
      if (!def) missing.add(subtype);
      addPower(solarDefs, subtype, def);
      if (def?.maxPowerOutputMW === undefined || def.maxPowerOutputMW === null || solarOutput === null) solarOutput = null;
      else solarOutput += def.maxPowerOutputMW;
    } else if (kind === 'OxygenTank' || kind === 'GasTank') {
      if (!/hydrogen/i.test(subtype)) continue;
      tankCount += 1;
      const def = definitions.get(subtype, 'gasTank');
      if (!def) missing.add(subtype);
      const bucket = tankDefs.get(subtype) ?? { count: 0, capacityL: def?.capacityL ?? null };
      bucket.count += 1;
      tankDefs.set(subtype, bucket);
      if (def?.capacityL === undefined || def.capacityL === null || tankCapacity === null) tankCapacity = null;
      else tankCapacity += def.capacityL;
      if (block.filledRatio !== null) {
        tankHasRatio = true;
        tankRatioBlocks += 1;
        tankRatioWeighted += block.filledRatio * (def?.capacityL ?? 0);
        if (def?.capacityL === undefined || def.capacityL === null || tankFilledL === null) tankFilledL = null;
        else tankFilledL += block.filledRatio * def.capacityL;
      }
    }
  }

  if (batteryCount === 0) {
    batteryCapacity = 0;
    batteryStored = 0;
  } else if (!batterySawStored || batteryStoredBlocks !== batteryCount) {
    batteryStored = null;
  }
  if (reactorCount === 0) reactorOutput = 0;
  if (solarCount === 0) solarOutput = 0;
  if (tankCount === 0) {
    tankCapacity = 0;
    tankFilledL = 0;
  } else if (!tankHasRatio || tankRatioBlocks !== tankCount) {
    tankFillRatio = null;
    tankFilledL = null;
  }
  if (tankHasRatio && tankCapacity !== null && tankCapacity > 0) {
    tankFillRatio = Math.min(1, Math.max(0, tankRatioWeighted / tankCapacity));
    if (tankFilledL !== null) tankFilledL = tankFillRatio * tankCapacity;
  }

  const thrusterGroups = {
    atmo: finishGroup(atmo),
    ion: finishGroup(ion),
    hydrogen: finishGroup(hydrogen),
  };
  const knownForce = (g: ThrusterGroup): number | null => g.totalForceN;
  const spaceForce = [knownForce(thrusterGroups.ion), knownForce(thrusterGroups.hydrogen)];
  const canFlyInSpace: boolean | 'unknown' =
    thrusterDefinitionMissing || spaceForce.some((f) => f === null)
      ? 'unknown'
      : (spaceForce[0] ?? 0) + (spaceForce[1] ?? 0) > 0;
  const gravityForce = [knownForce(thrusterGroups.atmo), knownForce(thrusterGroups.hydrogen)];
  const canFlyInGravity: boolean | 'unknown' =
    raw.massKg === null || thrusterDefinitionMissing || gravityForce.some((f) => f === null)
      ? 'unknown'
      : (gravityForce[0] ?? 0) + (gravityForce[1] ?? 0) >= raw.massKg * GRAVITY;

  const canRelay = radioAntennas.some(
    (a) => a.enabled === true && a.broadcasting === true && (a.radiusM ?? 0) > 0,
  );
  const canLaserLink = laserAntennas.some(
    (a) => a.enabled === true && (a.unlimited === true || (a.maxRangeM?.value ?? 0) > 0),
  );

  return {
    schemaVersion: 1,
    gridId: raw.id,
    name: cleanName(raw.name) || raw.id,
    ownerIdentityId,
    ownerName: ownerName ? cleanName(ownerName) : null,
    ownerFactionTag: faction?.tag || null,
    ownerKind,
    isNpc: ownerKind === 'npc',
    sizeClass: raw.sizeClass,
    isStatic: raw.isStatic,
    position: raw.position,
    blockCount: raw.blocks.length,
    massKg: raw.massKg,
    radioAntennas,
    laserAntennas,
    beacons,
    programmableBlocks,
    remoteControls,
    cockpits,
    gyros,
    thrusters: thrusterGroups,
    power: {
      batteries: {
        count: batteryCount,
        capacityMWh: batteryCapacity,
        storedMWh: batteryStored,
        bySubtype: [...batteryDefs.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([subtype, b]) => ({
            subtype,
            count: b.count,
            value: b.value === null ? null : sourced(b.value, subtype, b.source),
          })),
      },
      reactors: {
        count: reactorCount,
        maxOutputMW: reactorOutput,
        bySubtype: [...reactorDefs.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([subtype, b]) => ({
            subtype,
            count: b.count,
            value: b.value === null ? null : sourced(b.value, subtype),
          })),
      },
      solarPanels: {
        count: solarCount,
        maxOutputMW: solarOutput,
        bySubtype: [...solarDefs.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([subtype, b]) => ({ subtype, count: b.count, value: b.value === null ? null : sourced(b.value, subtype) })),
      },
    },
    hydrogenTanks: {
      count: tankCount,
      capacityL: tankCapacity,
      fillRatio: tankFillRatio,
      filledL: tankFilledL,
      bySubtype: [...tankDefs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([subtype, t]) => ({
          subtype,
          count: t.count,
          value: t.capacityL === null ? null : sourced(t.capacityL, subtype),
        })),
    },
    roles: { canRelay, canLaserLink, canFlyInGravity, canFlyInSpace, controllable: programmableBlocks > 0 || remoteControls > 0 },
    missingDefinitions: [...missing].sort(),
  };
}

export interface ScanProfileOptions {
  sbsPath: string;
  sbcPath: string;
  defsPath: string;
  now?: number;
  excludePirateStations?: boolean;
}

export async function profileSave(opts: ScanProfileOptions): Promise<CapabilityReport> {
  const now = opts.now ?? Date.now();
  const definitions = await loadDefinitions(opts.defsPath);
  const context = await loadSaveContext(opts.sbcPath);
  if (!fs.existsSync(opts.sbsPath)) {
    throw new Error(`save file not found: ${opts.sbsPath}`);
  }
  const { grids, excluded } = await parseSectorGrids(fs.createReadStream(opts.sbsPath), {
    excludePirateStations: opts.excludePirateStations ?? true,
  });
  const profiles = grids.map((grid) => profileGrid(grid, { definitions, context, now }));
  profiles.sort((a, b) => a.gridId.localeCompare(b.gridId));
  return {
    schemaVersion: 1,
    generatedAt: now,
    savePath: opts.sbsPath,
    defsPath: opts.defsPath,
    gridsScanned: profiles.length,
    gridsExcluded: excluded,
    grids: profiles,
  };
}
