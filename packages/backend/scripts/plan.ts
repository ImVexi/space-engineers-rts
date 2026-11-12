import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityReport } from '@se-rts/schemas';
import {
  findPlanet,
  loadPlanetCatalog,
  planChain,
  planCoverage,
  planetRegion,
  presetTemplateNames,
  resolveTemplate,
} from '../src/planner/index.js';

/**
 * `npm run plan -- chain EarthLike Alien --template radio-50km`
 * `npm run plan -- coverage EarthLike --template radio-50km --k 1`
 *
 * Pure computation: no orders, no game server, no writes except an optional
 * JSON plan under `data/` (gitignored).
 */

interface Parsed {
  positional: string[];
  flags: Record<string, string>;
  booleans: Set<string>;
}

function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) booleans.add(key);
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return { positional, flags, booleans };
}

function loadProfiles(): CapabilityReport | null {
  const file = process.env.RTS_CAPABILITIES_JSON ?? path.join('data', 'capabilities.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as CapabilityReport;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function main(): void {
  const { positional, flags, booleans } = parse(process.argv.slice(2));
  const command = positional.shift();
  if (!command) {
    console.error('usage: npm run plan -- chain <from> <to> --template <id>');
    console.error('       npm run plan -- coverage <planet> --template <id> [--k 1|2]');
    process.exitCode = 1;
    return;
  }

  const catalog = loadPlanetCatalog(flags.planets);
  const profiles = loadProfiles()?.grids ?? [];
  const templateSpec = flags.template ?? 'radio-50km';
  const template = resolveTemplate(templateSpec, profiles);
  const safety = flags.safety !== undefined ? Number(flags.safety) : 0.9;
  const altitude = flags.altitude !== undefined ? Number(flags.altitude) : undefined;
  const margin = flags.margin !== undefined ? Number(flags.margin) : undefined;
  const config = {
    ...(Number.isFinite(safety) ? { spacingSafetyFactor: safety } : {}),
    ...(altitude !== undefined && Number.isFinite(altitude) ? { minNodeAltitudeM: altitude } : {}),
    ...(margin !== undefined && Number.isFinite(margin) ? { planetMarginM: margin } : {}),
  };

  if (command === 'chain') {
    const [fromName, toName] = positional;
    if (!fromName || !toName) throw new Error('chain needs <from> and <to>');
    const from = findPlanet(catalog, fromName);
    const to = findPlanet(catalog, toName);
    if (!from) throw new Error(`unknown planet ${fromName}`);
    if (!to) throw new Error(`unknown planet ${toName}`);
    const plan = planChain(from, to, template, { config, planets: catalog });
    console.log(`chain ${from.name} -> ${to.name}`);
    console.log(`template ${template.id}; spacing ${plan.spacingM} m; safety ${config.spacingSafetyFactor ?? 0.9}`);
    console.log(`nodes ${plan.count} (${plan.relayCount} relays); max gap ${plan.maxGapM.toFixed(0)} m; path ${plan.totalDistanceM.toFixed(0)} m`);
    console.log(`detour ${plan.detour ? `yes (${plan.blockedBy.join(', ')})` : 'no'}; waypoints ${plan.waypoints.length}`);
    const out = flags.json ?? path.join('data', `plan-chain-${from.name}-${to.name}.json`);
    writeJson(out, plan);
    console.log(`wrote ${out}`);
    return;
  }

  if (command === 'coverage') {
    const [planetName] = positional;
    if (!planetName) throw new Error('coverage needs a <planet>');
    const planet = findPlanet(catalog, planetName);
    if (!planet) throw new Error(`unknown planet ${planetName}`);
    const k = flags.k === '2' ? 2 : 1;
    let reuse = undefined;
    if (flags.reuse) {
      const raw = JSON.parse(fs.readFileSync(flags.reuse, 'utf8')) as { nodes?: unknown[] };
      reuse = (raw.nodes ?? []) as never;
    }
    const plan = planCoverage(planetRegion(planet), template, {
      k,
      reuseExisting: reuse,
      config,
      ...(flags.altitude !== undefined ? { altitudeM: Number(flags.altitude) } : {}),
    });
    console.log(`coverage ${planet.name}; surface ${plan.surfaceRadiusM} m; altitude ${plan.nodeAltitudeM} m; k=${k}`);
    console.log(`nodes ${plan.count}; samples ${plan.samples}; covered ${plan.sampleCoverage}; uncovered ${plan.uncoveredSamples}`);
    const out = flags.json ?? path.join('data', `plan-coverage-${planet.name}-k${k}.json`);
    writeJson(out, plan);
    console.log(`wrote ${out}`);
    return;
  }

  throw new Error(`unknown command ${command} (known: chain, coverage; templates: ${presetTemplateNames().join(', ')})`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
