import fs from 'node:fs';
import path from 'node:path';
import sax from 'sax';

/**
 * Block mass and component-cost tables built from CubeBlocks definitions.
 *
 *  * `massBySubtype`: block subtype -> mass in kg. Kept only when EVERY
 *    definition of that subtype that states `<Mass>` agrees; `<Mass>` in
 *    CubeBlocks is the block's full mass (armour included), so it is used
 *    directly.
 *  * `componentsBySubtype`: block subtype -> component cost from
 *    `<Components><Component Subtype Count />`.
 *  * `componentMass`: component subtype -> kg, from `Components*.sbc`.
 *
 * Grid mass is then either the sum of `massBySubtype`, or (only when every
 * block has a component cost and every component a mass) the sum of component
 * masses. Anything unknown makes the grid total `null` rather than a low
 * estimate, which would flatter TWR.
 */
export interface MassTables {
  massBySubtype: Map<string, number>;
  componentsBySubtype: Map<string, Map<string, number>>;
  componentMass: Map<string, number>;
}

function walkSbc(root: string, pattern: RegExp): string[] {
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
      else if (pattern.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

interface DefCapture {
  subtype: string;
  mass: number | null;
  components: Map<string, number>;
  capture: { tag: 'SubtypeId' | 'Mass' | 'Component'; depth: number; parts: string[]; count?: number } | null;
}

/** Parses CubeBlocks `*.sbc` files under a root into the mass tables. */
export function loadMassTables(defsRoot: string, componentRoots: string[]): MassTables {
  const tables: MassTables = {
    massBySubtype: new Map(),
    componentsBySubtype: new Map(),
    componentMass: new Map(),
  };
  const conflicts = new Set<string>();

  for (const file of walkSbc(defsRoot, /^CubeBlocks.*\.sbc$/i)) {
    const parser = sax.parser(true, { trim: true, normalize: false });
    const stack: string[] = [];
    let def: DefCapture | null = null;
    let defDepth = 0;
    parser.onopentag = (node) => {
      stack.push(node.name);
      const depth = stack.length;
      const attrs = node.attributes as Record<string, string | undefined>;
      if (node.name === 'Definition' && stack[depth - 2] === 'CubeBlocks') {
        def = { subtype: '', mass: null, components: new Map(), capture: null };
        defDepth = depth;
        return;
      }
      if (!def) return;
      if (stack[depth - 2] === 'Id' && node.name === 'SubtypeId') {
        def.capture = { tag: 'SubtypeId', depth, parts: [] };
      } else if (depth === defDepth + 1 && node.name === 'Mass') {
        def.capture = { tag: 'Mass', depth, parts: [] };
      } else if (stack[depth - 2] === 'Components' && node.name === 'Component') {
        const subtype = attrs.Subtype;
        const count = Number(attrs.Count ?? '1');
        if (subtype) def.components.set(subtype, (def.components.get(subtype) ?? 0) + (Number.isFinite(count) ? count : 1));
      }
    };
    parser.ontext = (text) => {
      const d = def as DefCapture | null;
      if (d?.capture && stack.length === d.capture.depth) d.capture.parts.push(text);
    };
    parser.oncdata = parser.ontext as (t: string) => void;
    parser.onclosetag = () => {
      const depth = stack.length;
      const closing = stack[depth - 1];
      const d = def as DefCapture | null;
      if (d?.capture && depth === d.capture.depth) {
        const value = d.capture.parts.join('').trim();
        if (d.capture.tag === 'SubtypeId') d.subtype = value;
        else d.mass = Number.isFinite(Number(value)) ? Number(value) : null;
        d.capture = null;
      }
      if (d && depth === defDepth) {
        if (d.subtype) {
          if (d.mass !== null) {
            const known = tables.massBySubtype.get(d.subtype);
            if (known === undefined) tables.massBySubtype.set(d.subtype, d.mass);
            else if (known !== d.mass) {
              conflicts.add(d.subtype);
              tables.massBySubtype.delete(d.subtype);
            }
          }
          if (d.components.size > 0 && !tables.componentsBySubtype.has(d.subtype)) {
            tables.componentsBySubtype.set(d.subtype, d.components);
          }
        }
        def = null;
      }
      stack.pop();
    };
    parser.write(fs.readFileSync(file, 'utf8'));
    parser.close();
  }
  // A subtype defined twice with different masses is not usable.
  for (const subtype of conflicts) tables.massBySubtype.delete(subtype);

  for (const root of componentRoots) {
    for (const file of walkSbc(root, /^Components.*\.sbc$/i)) {
      const parser = sax.parser(true, { trim: true, normalize: false });
      const stack: string[] = [];
      let subtype: string | null = null;
      let inComponent = false;
      let capture: { tag: 'SubtypeId' | 'Mass'; depth: number; parts: string[] } | null = null;
      parser.onopentag = (node) => {
        stack.push(node.name);
        const depth = stack.length;
        if (node.name === 'Component' && !inComponent) {
          inComponent = true;
          subtype = null;
          return;
        }
        if (!inComponent) return;
        if (stack[depth - 2] === 'Id' && node.name === 'SubtypeId') capture = { tag: 'SubtypeId', depth, parts: [] };
        else if (node.name === 'Mass') capture = { tag: 'Mass', depth, parts: [] };
      };
      parser.ontext = (text) => {
        if (capture && stack.length === capture.depth) capture.parts.push(text);
      };
      parser.oncdata = parser.ontext as (t: string) => void;
      parser.onclosetag = () => {
        const depth = stack.length;
        const closing = stack[depth - 1];
        if (capture && depth === capture.depth) {
          const value = capture.parts.join('').trim();
          if (capture.tag === 'SubtypeId') subtype = value;
          else if (subtype && !tables.componentMass.has(subtype) && Number.isFinite(Number(value))) {
            tables.componentMass.set(subtype, Number(value));
          }
          capture = null;
        }
        if (closing === 'Component' && inComponent) inComponent = false;
        stack.pop();
      };
      parser.write(fs.readFileSync(file, 'utf8'));
      parser.close();
    }
  }
  return tables;
}

/**
 * Mass of a multiset of block subtypes in kg, or null when any part is
 * unknown. Prefers explicit CubeBlocks `<Mass>`; falls back to component
 * sums when every block of the grid resolves that way.
 */
export function estimateGridMass(subtypes: string[], tables: MassTables): number | null {
  let total = 0;
  let allKnown = true;
  for (const subtype of subtypes) {
    const m = tables.massBySubtype.get(subtype);
    if (m === undefined) {
      allKnown = false;
      break;
    }
    total += m;
  }
  if (allKnown) return total;

  total = 0;
  for (const subtype of subtypes) {
    const comps = tables.componentsBySubtype.get(subtype);
    if (!comps) return null;
    for (const [component, count] of comps) {
      const m = tables.componentMass.get(component);
      if (m === undefined) return null;
      total += m * count;
    }
  }
  return total > 0 ? total : null;
}
