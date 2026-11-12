import fs from 'node:fs';
import path from 'node:path';
import { profilePrefabs, type PrefabProfile } from '../src/capabilities/prefabs.js';
import { loadSpawnGroups, type SpawnGroupRef } from '../src/capabilities/spawnGroups.js';

/**
 * `npm run profile -- --prefabs DIR[,DIR2] --defs DIR [--spawns DIR[,DIR2]] --out FILE`
 *
 * READ-ONLY survey of the game's ship prefabs (vanilla + installed mods).
 * Profiles every grid in every prefab and ranks candidates for the relay
 * network tests. Writes only JSON + a markdown candidate list under `data/`.
 *
 * Source label: when a prefab root is `.../Content/Data/Prefabs`, its label is
 * `vanilla`; roots under `.../content/244850/<id>/Data/...` are labelled
 * `mod <id>`.
 */

interface Args {
  prefabs?: string;
  defs?: string;
  spawns?: string;
  out?: string;
  md?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    const value = argv[i + 1];
    if (!key.startsWith('--')) continue;
    i += 1;
    if (value === undefined) break;
    if (key === '--prefabs') out.prefabs = value;
    else if (key === '--defs') out.defs = value;
    else if (key === '--spawns') out.spawns = value;
    else if (key === '--out') out.out = value;
    else if (key === '--md') out.md = value;
  }
  return out;
}

function sourceLabel(fileDir: string): string {
  const normalized = fileDir.replace(/\\/g, '/');
  const live = /\/content\/244850\/(\d+)\//.exec(normalized);
  if (live) return `mod ${live[1]}`;
  // Scratch copies keep the same shape: `<prefabRoot>/mods/<id>/Data/Prefabs`.
  const copy = /\/mods\/(\d+)\//.exec(normalized);
  if (copy) return `mod ${copy[1]}`;
  return 'vanilla';
}

interface Candidate {
  prefab: PrefabProfile;
  source: string;
  radioMax: number | null;
  laserCount: number;
  groups: SpawnGroupRef[];
  pcu: number | null;
}

const PCU_PER_GRID = 10; // SE's Projector\Blueprint unit, not block count.

function buildCandidate(p: PrefabProfile, groups: SpawnGroupRef[]): Candidate {
  const g = p.main;
  const radioMax = g.radioAntennas.reduce<number | null>((acc, a) => {
    const v = a.radiusM ?? a.maxRadiusM?.value ?? null;
    if (v === null) return acc;
    return acc === null ? v : Math.max(acc, v);
  }, null);
  return {
    prefab: p,
    source: sourceLabel(p.source),
    radioMax,
    laserCount: g.laserAntennas.length,
    groups,
    pcu: PCU_PER_GRID,
  };
}

const fmt = (n: number | null | undefined, d = 0): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '?' : n.toLocaleString('en-US', { maximumFractionDigits: d });

const thrustSummary = (g: PrefabProfile['main']): string => {
  const parts: string[] = [];
  for (const [name, group] of [['atmo', g.thrusters.atmo], ['ion', g.thrusters.ion], ['H2', g.thrusters.hydrogen]] as const) {
    if (group.count > 0) parts.push(`${group.count}×${name}${group.totalForceN === null ? '' : ` (${fmt(group.totalForceN / 1000, 0)} kN)`}`);
  }
  return parts.join(' + ') || 'none';
};

const powerSummary = (g: PrefabProfile['main']): string => {
  const parts: string[] = [];
  if (g.power.reactors.count > 0) parts.push(`${g.power.reactors.count}×reactor ${fmt(g.power.reactors.maxOutputMW, 2)} MW`);
  if (g.power.batteries.count > 0) parts.push(`${g.power.batteries.count}×battery ${fmt(g.power.batteries.capacityMWh, 2)} MWh`);
  if (g.power.solarPanels.count > 0) parts.push(`${g.power.solarPanels.count}×solar ${fmt(g.power.solarPanels.maxOutputMW, 2)} MW`);
  if (g.hydrogenTanks.count > 0) parts.push(`${g.hydrogenTanks.count}×H2 tank`);
  return parts.join(', ') || 'none';
};

const control = (g: PrefabProfile['main']): string => {
  const parts: string[] = [];
  if (g.remoteControls > 0) parts.push(`${g.remoteControls} RC`);
  if (g.cockpits > 0) parts.push(`${g.cockpits} cockpit`);
  if (g.gyros > 0) parts.push(`${g.gyros} gyro`);
  if (g.programmableBlocks > 0) parts.push(`${g.programmableBlocks} PB`);
  return parts.join(', ') || '-';
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prefabs) throw new Error('--prefabs <dir[,dir]> is required');
  // --prefabs may name a prefabs root (`.../Prefabs`), in which case each
  // `<dir>/mods/<id>/Prefabs` (a copy of mod `.../content/244850/<id>/Data/Prefabs`)
  // is added so vanilla and mod ships land in one survey.
  const defsDir = args.defs ?? process.env.RTS_DEFS_DIR ?? 'data/game';
  const prefabRoots: string[] = [];
  for (const root of args.prefabs.split(',').filter(Boolean)) {
    prefabRoots.push(root);
    const modsDir = path.join(path.dirname(root), 'mods');
    if (fs.existsSync(modsDir)) {
      for (const id of fs.readdirSync(modsDir).sort()) {
        const modPrefabs = path.join(modsDir, id, 'Data', 'Prefabs');
        if (fs.existsSync(modPrefabs)) prefabRoots.push(modPrefabs);
      }
    }
  }
  const spawnRoots = (args.spawns ?? path.join(path.dirname(args.prefabs.split(',')[0]!), 'sg'))
    .split(',')
    .filter((r) => r && fs.existsSync(r));

  if (process.env.RTS_PROFILE_DEBUG) console.error('prefabRoots', prefabRoots);
  const { prefabs, filesScanned } = await profilePrefabs({ prefabRoots, defsPath: defsDir });
  const spawnIndex = spawnRoots.length > 0 ? await loadSpawnGroups(spawnRoots) : new Map<string, SpawnGroupRef[]>();
  const all = prefabs.map((p) => buildCandidate(p, spawnIndex.get(p.subtype) ?? []));
  if (process.env.RTS_PROFILE_DEBUG) {
    console.error('spawnRoots', spawnRoots, 'indexed', spawnIndex.size);
    console.error('sources', [...new Set(all.map((c) => c.source))]);
    console.error('sample', all.slice(0, 2).map((c) => [c.prefab.subtype, c.source, c.groups.length]));
  }

  const outPath = args.out ?? path.join('data', 'prefab-candidates.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify({ filesScanned, prefabs: all.map((c) => ({ ...c, groups: c.groups })) }, null, 2)}\n`);

  const flighty = all.filter((c) => {
    const g = c.prefab.main;
    return g.thrusters.atmo.count + g.thrusters.ion.count + g.thrusters.hydrogen.count > 0 && !g.isStatic;
  });
  const relay = flighty.filter((c) => c.radioMax !== null && c.prefab.main.roles.canRelay !== false);
  const relayRanked = relay.sort((a, b) => {
    const sa = a.prefab.main.sizeClass === 'small' ? 0 : 1;
    const sb = b.prefab.main.sizeClass === 'small' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    if ((b.radioMax ?? 0) !== (a.radioMax ?? 0)) return (b.radioMax ?? 0) - (a.radioMax ?? 0);
    return a.prefab.main.blockCount - b.prefab.main.blockCount;
  });
  const laser = all.filter((c) => c.laserCount > 0);
  const ground = flighty.filter(
    (c) => c.prefab.main.thrusters.atmo.count > 0 || c.prefab.main.thrusters.hydrogen.count > 0,
  );

  console.log(`prefabs scanned: ${prefabs.length} (${filesScanned} files)`);
  console.log(`flight-capable (has thrusters, non-static): ${flighty.length}`);
  console.log(`radio relay candidates: ${relayRanked.length}`);
  console.log(`laser capable: ${laser.length} (1 laser: ${laser.filter((c) => c.laserCount === 1).length}, 2+: ${laser.filter((c) => c.laserCount >= 2).length})`);
  console.log(`ground-launch capable (atmo or H2 thrust): ${ground.length}`);
  console.log('');
  for (const c of relayRanked.slice(0, 15)) {
    const g = c.prefab.main;
    console.log(`relay\t${c.prefab.subtype}\t${c.source}\t${g.sizeClass}\t${fmt(c.radioMax)} m\t${thrustSummary(g)}`);
  }
  console.log('');
  for (const c of laser) {
    const g = c.prefab.main;
    console.log(`laser\t${c.prefab.subtype}\t${c.source}\t${g.sizeClass}\tlasers=${c.laserCount}\t${thrustSummary(g)}`);
  }
  console.log('');
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
