import fs from 'node:fs';
import path from 'node:path';
import sax from 'sax';

/**
 * Reads Keen CubeBlocks definition files (read-only, never copied into the
 * repo) and indexes the fields the profiler needs. Only numbers that are
 * actually present in a definition are returned; anything else is undefined
 * so the caller can emit an explicit null.
 */

export type DefinitionKind =
  | 'thrust'
  | 'radioAntenna'
  | 'laserAntenna'
  | 'beacon'
  | 'battery'
  | 'reactor'
  | 'solar'
  | 'gasTank'
  | 'other';

export interface BlockDefinition {
  kind: DefinitionKind;
  subtype: string;
  typeId: string;
  cubeSize: 'Large' | 'Small' | null;
  thrusterType: 'Ion' | 'Hydrogen' | 'Atmospheric' | null;
  forceMagnitudeN: number | null;
  maxBroadcastRadiusM: number | null;
  /** Laser `MaxRange`; negative means "no coded limit" (unlimited). */
  maxRangeM: number | null;
  requireLineOfSight: boolean | null;
  maxStoredPowerMWh: number | null;
  maxPowerOutputMW: number | null;
  capacityL: number | null;
  /** `<Size x y z>` on the grid, in blocks of this cube size. */
  volumeCells: number | null;
  sourceFile: string;
}

export class DefinitionIndex {
  private readonly bySubtype = new Map<string, BlockDefinition[]>();

  add(def: BlockDefinition): void {
    const list = this.bySubtype.get(def.subtype) ?? [];
    // First file wins (files are read in sorted order); later packs do not
    // silently override a base-game subtype.
    if (!list.some((d) => d.kind === def.kind)) list.push(def);
    this.bySubtype.set(def.subtype, list);
  }

  get(subtype: string, kind?: DefinitionKind): BlockDefinition | undefined {
    const list = this.bySubtype.get(subtype);
    if (!list) return undefined;
    if (!kind) return list[0];
    return list.find((d) => d.kind === kind);
  }

  get size(): number {
    let n = 0;
    for (const list of this.bySubtype.values()) n += list.length;
    return n;
  }
}

const KIND_BY_TYPE: Record<string, DefinitionKind> = {
  Thrust: 'thrust',
  RadioAntenna: 'radioAntenna',
  LaserAntenna: 'laserAntenna',
  Beacon: 'beacon',
  BatteryBlock: 'battery',
  Reactor: 'reactor',
  SolarPanel: 'solar',
  GasTank: 'gasTank',
};

/**
 * Many base-game defs (e.g. `LargeHydrogenTank`) omit `xsi:type` and carry
 * only `<Id><TypeId>`. Resolve the kind from TypeId first, then xsi:type.
 */
function kindOf(xsiType: string | undefined, typeId?: string): DefinitionKind {
  const fromType = KIND_BY_TYPE[(typeId ?? '').trim()];
  if (fromType) return fromType;
  const base = (xsiType ?? '').replace(/^MyObjectBuilder_/, '').replace(/Definition$/, '');
  return KIND_BY_TYPE[base] ?? 'other';
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

function bool(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function mapCubeSize(value: string | undefined): 'Large' | 'Small' | null {
  const v = value?.trim();
  return v === 'Large' || v === 'Small' ? v : null;
}

function mapThruster(value: string | undefined): BlockDefinition['thrusterType'] {
  const v = value?.trim();
  return v === 'Ion' || v === 'Hydrogen' || v === 'Atmospheric' ? v : null;
}

/** Collects `CubeBlocks_*.sbc` under a defs root (recursive, bounded). */
export function findDefinitionFiles(defsRoot: string, maxDepth = 5): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/^CubeBlocks.*\.sbc$/i.test(entry.name)) out.push(full);
    }
  };
  walk(defsRoot, 0);
  return out.sort();
}

interface PendingDefinition {
  kind: DefinitionKind;
  subtype: string;
  typeId: string;
  fields: Map<string, string>;
  depth: number;
  idDepth: number | null;
  fieldCapture: { key: string; depth: number; parts: string[] } | null;
  size: { x: number; y: number; z: number } | null;
}

const CAPTURED_FIELDS = new Set([
  'CubeSize',
  'ThrusterType',
  'ForceMagnitude',
  'MaxBroadcastRadius',
  'MaxRange',
  'RequireLineOfSight',
  'MaxStoredPower',
  'MaxPowerOutput',
  'Capacity',
]);

/** Parses one CubeBlocks file into the index. Resolves when the stream ends. */
export function loadDefinitionFile(file: string, index: DefinitionIndex): Promise<void> {
  return new Promise((resolve, reject) => {
    const parser = sax.parser(true, { trim: true, normalize: false });
    const stack: string[] = [];
    let def: PendingDefinition | null = null;

    parser.onopentag = (node) => {
      stack.push(node.name);
      const depth = stack.length;
      const attrs = node.attributes as Record<string, string>;
      const xsi = attrs['xsi:type'];
      if (node.name === 'Definition' && (xsi || stack[depth - 2] === 'CubeBlocks')) {
        def = {
          kind: kindOf(xsi),
          subtype: '',
          typeId: '',
          fields: new Map(),
          depth,
          idDepth: null,
          fieldCapture: null,
          size: null,
        };
        return;
      }
      if (!def) return;
      if (node.name === 'Id' && depth === def.depth + 1) {
        def.idDepth = depth;
        return;
      }
      if (def.idDepth !== null && depth === def.idDepth + 1) {
        if (node.name === 'TypeId') def.fieldCapture = { key: 'TypeId', depth, parts: [] };
        else if (node.name === 'SubtypeId') def.fieldCapture = { key: 'SubtypeId', depth, parts: [] };
        return;
      }
      if (depth === def.depth + 1 && node.name === 'Size') {
        const x = num(attrs.x);
        const y = num(attrs.y);
        const z = num(attrs.z);
        if (x !== null && y !== null && z !== null) def.size = { x, y, z };
        return;
      }
      if (depth === def.depth + 1 && CAPTURED_FIELDS.has(node.name)) {
        def.fieldCapture = { key: node.name, depth, parts: [] };
      }
    };

    parser.ontext = (text) => {
      const d = def as PendingDefinition | null;
      if (d?.fieldCapture && stack.length === d.fieldCapture.depth) d.fieldCapture.parts.push(text);
    };
    parser.oncdata = parser.ontext as (text: string) => void;

    parser.onclosetag = () => {
      const depth = stack.length;
      const d = def as PendingDefinition | null;
      if (d?.fieldCapture && depth === d.fieldCapture.depth) {
        const value = d.fieldCapture.parts.join('').trim();
        if (d.fieldCapture.key === 'TypeId') d.typeId = value;
        else if (d.fieldCapture.key === 'SubtypeId') d.subtype = value;
        else d.fields.set(d.fieldCapture.key, value);
        d.fieldCapture = null;
      }
      if (d && depth === d.depth) {
        if (d.subtype) {
          index.add({
            kind: d.kind === 'other' ? kindOf(undefined, d.typeId) : d.kind,
            subtype: d.subtype,
            typeId: d.typeId,
            cubeSize: mapCubeSize(d.fields.get('CubeSize')),
            thrusterType: mapThruster(d.fields.get('ThrusterType')),
            forceMagnitudeN: num(d.fields.get('ForceMagnitude')),
            maxBroadcastRadiusM: num(d.fields.get('MaxBroadcastRadius')),
            maxRangeM: num(d.fields.get('MaxRange')),
            requireLineOfSight: bool(d.fields.get('RequireLineOfSight')),
            maxStoredPowerMWh: num(d.fields.get('MaxStoredPower')),
            maxPowerOutputMW: num(d.fields.get('MaxPowerOutput')),
            capacityL: num(d.fields.get('Capacity')),
            volumeCells: d.size ? d.size.x * d.size.y * d.size.z : null,
            sourceFile: file,
          });
        }
        def = null;
      }
      stack.pop();
    };

    parser.onerror = (err) => {
      reject(err);
      parser.resume();
    };
    parser.onend = () => resolve();
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => parser.write(chunk.toString('utf8')));
    stream.on('end', () => parser.close());
    stream.on('error', reject);
  });
}

export async function loadDefinitions(defsRoot: string): Promise<DefinitionIndex> {
  const index = new DefinitionIndex();
  const files = findDefinitionFiles(defsRoot);
  for (const file of files) await loadDefinitionFile(file, index);
  return index;
}
