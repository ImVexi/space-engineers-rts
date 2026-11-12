import fs from 'node:fs';
import path from 'node:path';
import { profileSave } from '../src/capabilities/profiler.js';

/**
 * `npm run profile -- --save DIR --defs DIR [--sbc FILE] [--out FILE]`
 *
 * READ-ONLY: parses a copy of the synced save and local block definitions.
 * Writes only the JSON profile under `data/` (gitignored).
 */

interface Args {
  save?: string;
  sbc?: string;
  defs?: string;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    const value = argv[i + 1];
    if (!value) continue;
    if (key === '--save') out.save = value;
    else if (key === '--sbc') out.sbc = value;
    else if (key === '--defs') out.defs = value;
    else if (key === '--out') out.out = value;
    if (key.startsWith('--')) i += 1;
  }
  return out;
}

function pct(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const saveDir = args.save ?? process.env.RTS_SAVE_DIR ?? 'data/save';
  const defsDir = args.defs ?? process.env.RTS_DEFS_DIR ?? 'data/game';
  const sbsPath = path.join(saveDir, 'SANDBOX_0_0_0_.sbs');
  const sbcPath = args.sbc ?? path.join(saveDir, 'Sandbox.sbc');
  const outPath = args.out ?? path.join('data', 'capabilities.json');

  const report = await profileSave({ sbsPath, sbcPath, defsPath: defsDir });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  const grids = report.grids;
  const npc = grids.filter((g) => g.isNpc);
  const npcWithPb = npc.filter((g) => g.programmableBlocks > 0);
  const radioOnly = grids.filter((g) => g.radioAntennas.length > 0 && g.laserAntennas.length === 0);
  const laserCapable = grids.filter((g) => g.laserAntennas.length > 0);
  const maxRadio = Math.max(0, ...grids.flatMap((g) => g.radioAntennas.map((a) => a.radiusM ?? 0)));
  const maxLaser = Math.max(0, ...grids.flatMap((g) => g.laserAntennas.map((a) => a.maxRangeM?.value ?? 0)));
  const unlimitedLaser = grids.filter((g) => g.laserAntennas.some((a) => a.unlimited === true)).length;

  console.log('CAPABILITY PROFILE (read-only)');
  console.log(`save: ${sbsPath}`);
  console.log(`defs: ${defsDir}`);
  console.log(`grids: ${report.gridsScanned} top-level (${report.gridsExcluded} SerializedPirateStation prefabs excluded)`);
  console.log(`NPC grids: ${npc.length} (${pct(npc.length, grids.length)}), NPC grids with programmable blocks: ${npcWithPb.length}`);
  console.log(`radio-only grids: ${radioOnly.length}; laser-capable grids: ${laserCapable.length} (${unlimitedLaser} with unlimited laser)`);
  console.log(`max radio radius found: ${maxRadio} m; max finite laser range: ${maxLaser} m`);
  console.log('');
  console.log(
    ['gridId', 'name', 'owner', 'npc', 'size', 'blocks', 'PB', 'radio', 'laser', 'beacon', 'roles'].join('\t'),
  );
  for (const g of grids) {
    const roles: string[] = [];
    if (g.roles.canRelay) roles.push('relay');
    if (g.roles.canLaserLink) roles.push('laser');
    if (g.roles.controllable) roles.push('ctl');
    if (g.roles.canFlyInSpace === true) roles.push('space');
    console.log(
      [
        g.gridId,
        g.name.replace(/\s+/g, '_').slice(0, 28),
        (g.ownerName ?? '-').replace(/\s+/g, '_').slice(0, 20),
        g.isNpc ? 'yes' : 'no',
        g.sizeClass,
        g.blockCount,
        g.programmableBlocks,
        g.radioAntennas.length,
        g.laserAntennas.length,
        g.beacons.length,
        roles.join(',') || '-',
      ].join('\t'),
    );
  }
  console.log('');
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
