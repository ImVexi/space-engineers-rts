import fs from 'node:fs';
import path from 'node:path';
import sax from 'sax';

/**
 * Reads MES `SpawnGroupDefinition` files (read-only) and maps every prefab
 * SubtypeId they reference back to the group name, plus the group's spawn
 * type (space / planet / drone) taken from `[SpaceCargoShip]`-style tags and
 * MES `SpawnType` fields in the Description block.
 */

export interface SpawnGroupRef {
  /** SpawnGroup SubtypeId, e.g. `XELT-SpawnGroup-Dart`. */
  group: string;
  /** Source file name, used to tell which mod owns the group. */
  file: string;
  /** Raw spawn-type hints found in the group (lower-case, deduplicated). */
  hints: string[];
  /** `AdminSpawnOnly`-style groups cannot spawn on their own. */
  adminOnly: boolean;
}

export type SpawnIndex = Map<string, SpawnGroupRef[]>;

const HINT_PATTERNS: Array<{ re: RegExp; hint: string }> = [
  // MES writes tags as `[Tag:Value]`; the value may sit on the next line and
  // `:` may be followed by whitespace, so match the tag head only.
  { re: /\[SpaceCargoShip\s*:/i, hint: 'space-cargo' },
  { re: /\[AtmosphericCargoShip\s*:/i, hint: 'planet-cargo' },
  { re: /\[Planetary\w*Ship\s*:/i, hint: 'planet' },
  { re: /\[SpaceRandomEncounter\s*:/i, hint: 'space-random' },
  { re: /\[PlanetaryRandomEncounter\s*:/i, hint: 'planet-random' },
  { re: /\[SpaceSpawnGroup\s*:/i, hint: 'space' },
  { re: /\[PlanetarySpawnGroup\s*:/i, hint: 'planet' },
  { re: /\[Drone\s*:/i, hint: 'drone' },
  { re: /\[SpawnGroupType\s*:\s*drone/i, hint: 'drone' },
];

function hintsFrom(text: string): string[] {
  const out = new Set<string>();
  for (const { re, hint } of HINT_PATTERNS) if (re.test(text)) out.add(hint);
  return [...out];
}

function walkSbc(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.sbc$/i.test(entry.name) && /spawngroup/i.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

interface PendingGroup {
  group: string;
  file: string;
  hints: Set<string>;
  adminOnly: boolean;
  prefabs: Set<string>;
  depth: number;
  capture: { tag: string; depth: number; parts: string[] } | null;
}

/** Streams one spawn-group file into an index. */
export function indexSpawnGroupFile(file: string, index: SpawnIndex): Promise<void> {
  return new Promise((resolve, reject) => {
    const parser = sax.parser(true, { trim: true, normalize: false });
    const stack: string[] = [];
    let def: PendingGroup | null = null;

    parser.onopentag = (node) => {
      stack.push(node.name);
      const depth = stack.length;
      const attrs = node.attributes as Record<string, string | undefined>;
      // `SpawnGroupDefinition` is how the server save serializes a group.
      if (node.name === 'SpawnGroup' || node.name === 'SpawnGroupDefinition') {
        def = {
          group: '',
          file: path.basename(file, path.extname(file)),
          hints: new Set(),
          adminOnly: false,
          prefabs: new Set(),
          depth,
          capture: null,
        };
        const subtype = attrs['xsi:subtype'] ?? attrs.Subtype;
        if (subtype) def.group = subtype;
        return;
      }
      if (!def) return;
      if (depth === def.depth + 2 && stack[depth - 2] === 'Id' && node.name === 'SubtypeId') {
        def.capture = { tag: 'SubtypeId', depth, parts: [] };
        return;
      }
      if (depth === def.depth + 1 && ['SubtypeId', 'Description'].includes(node.name)) {
        def.capture = { tag: node.name, depth, parts: [] };
        return;
      }
      // MES writes `<Prefab SubtypeId="...">`; some packs instead nest a
      // `<SubtypeId>` element inside `<Prefab>`.
      if (node.name === 'Prefab' && stack[depth - 2] === 'Prefabs') {
        const subtype = attrs.SubtypeId ?? attrs['xsi:subtype'] ?? attrs.Subtype;
        if (subtype) def.prefabs.add(subtype);
        else def.capture = { tag: 'prefab', depth, parts: [] };
      }
    };

    parser.ontext = (text) => {
      const d = def as PendingGroup | null;
      if (d?.capture && stack.length === d.capture.depth) d.capture.parts.push(text);
    };
    parser.oncdata = parser.ontext as (text: string) => void;

    parser.onclosetag = () => {
      const depth = stack.length;
      const d = def as PendingGroup | null;
      if (d?.capture && depth === d.capture.depth) {
        const value = d.capture.parts.join('');
        const trimmed = value.trim();
        if (d.capture.tag === 'SubtypeId' && !d.group) d.group = trimmed;
        else if (d.capture.tag === 'Description') {
          for (const hint of hintsFrom(value)) d.hints.add(hint);
          if (/\[AdminSpawnOnly/i.test(value)) d.adminOnly = true;
        } else if (d.capture.tag === 'prefab' && trimmed) d.prefabs.add(trimmed);
        d.capture = null;
      }
      if (d && depth === d.depth) {
        if (d.group) {
          const ref: SpawnGroupRef = {
            group: d.group,
            file: d.file,
            hints: [...d.hints].sort(),
            adminOnly: d.adminOnly,
          };
          for (const prefab of d.prefabs) {
            const list = index.get(prefab) ?? [];
            if (!list.some((r) => r.group === ref.group)) list.push(ref);
            index.set(prefab, list);
          }
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
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    parser.write(text);
    parser.close();
  });
}

/** Indexes every spawn-group `.sbc` under the given roots. */
export async function loadSpawnGroups(roots: string[]): Promise<SpawnIndex> {
  const index: SpawnIndex = new Map();
  for (const root of roots) {
    for (const file of walkSbc(root)) await indexSpawnGroupFile(file, index);
  }
  return index;
}
