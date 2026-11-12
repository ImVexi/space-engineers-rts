import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { profileSave } from '../src/capabilities/profiler.js';
import { planChain, PLANET_CATALOG } from '../src/planner/index.js';

/**
 * Read-only smoke tests against the real synced save copy. They skip when the
 * read-only data mount is absent (CI, another host) and never modify it.
 */
const SAVE_DIR = process.env.RTS_SAVE_DIR ?? '';
const DEFS_DIR = process.env.RTS_DEFS_DIR ?? '';
const SBS = `${SAVE_DIR}/SANDBOX_0_0_0_.sbs`;
const SBC = `${SAVE_DIR}/Sandbox.sbc`;
const available = fs.existsSync(SBS) && fs.existsSync(DEFS_DIR);

describe.skipIf(!available)('real save smoke (read-only)', () => {
  it('profiles the live save and reports the NPC drone', async () => {
    const report = await profileSave({ sbsPath: SBS, sbcPath: SBC, defsPath: DEFS_DIR });
    const npcWithPb = report.grids.filter((g) => g.isNpc && g.programmableBlocks > 0);
    const maxRadio = Math.max(0, ...report.grids.flatMap((g) => g.radioAntennas.map((a) => a.radiusM ?? 0)));
    console.log(
      `[real] grids=${report.gridsScanned} excluded=${report.gridsExcluded} npc=${report.grids.filter((g) => g.isNpc).length} npcWithPb=${npcWithPb.length} maxRadio=${maxRadio}m`,
    );
    expect(report.gridsScanned).toBeGreaterThan(0);
    expect(report.gridsExcluded).toBeGreaterThan(0);
    expect(maxRadio).toBeGreaterThan(0);
    expect(report.grids.every((g) => g.gridId.length > 0)).toBe(true);
  });

  it('plans EarthLike -> Alien with a 50 km radio template', () => {
    const earth = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
    const alien = PLANET_CATALOG.find((p) => p.name === 'Alien')!;
    const plan = planChain(earth, alien, {
      id: 'radio-50km',
      radioRadiusM: 50000,
      laserRangeM: null,
      laserUnlimited: false,
    }, { planets: PLANET_CATALOG });
    console.log(
      `[real] EarthLike->Alien nodes=${plan.count} relays=${plan.relayCount} maxGap=${plan.maxGapM.toFixed(0)}m spacing=${plan.spacingM}m detour=${plan.detour}`,
    );
    expect(plan.count).toBeGreaterThan(100);
    expect(plan.maxGapM).toBeLessThanOrEqual(plan.spacingM);
    expect(plan.detour).toBe(false);
  });
});
