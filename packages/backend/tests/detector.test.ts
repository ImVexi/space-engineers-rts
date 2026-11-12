import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanSave } from '../src/detector/saveDetector.js';
import { createRuntime } from '../src/runtime.js';
import { httpRequest, makeConfig, tempDir } from './helpers.js';

const SAVE = '<save-dir>/SANDBOX_0_0_0_.sbs';
const SBC = '<save-dir>/Sandbox.sbc';

interface GridSpec {
  id: string;
  name?: string;
  owner?: string;
  blocks?: string[];
  pbName?: string;
  pbData?: string;
  pos?: { x: number; y: number; z: number };
}

const ALL_BLOCKS = ['Reactor', 'Thrust', 'Gyro', 'Cockpit', 'RadioAntenna'];

function blockXml(type: string, owner: string, extra = ''): string {
  return `<MyObjectBuilder_CubeBlock xsi:type="MyObjectBuilder_${type}"><SubtypeName>${type}</SubtypeName><Owner>${owner}</Owner>${extra}</MyObjectBuilder_CubeBlock>`;
}

function gridXml(spec: GridSpec): string {
  const blocks = spec.blocks ?? ALL_BLOCKS;
  const pos = spec.pos ?? { x: 10, y: 20, z: 30 };
  const blockXmls = blocks.map((type) =>
    blockXml(
      type,
      spec.owner ?? '111',
      type === 'ProgrammableBlock'
        ? `<CustomName>${spec.pbName ?? ''}</CustomName><CustomData>${spec.pbData ?? ''}</CustomData>`
        : '',
    ),
  );
  if (!blocks.includes('ProgrammableBlock')) {
    blockXmls.push(
      blockXml(`ProgrammableBlock`, spec.owner ?? '111', `<CustomName>${spec.pbName ?? ''}</CustomName><CustomData>${spec.pbData ?? ''}</CustomData>`),
    );
  }
  return `<MyObjectBuilder_EntityBase xsi:type="MyObjectBuilder_CubeGrid">
    <EntityId>${spec.id}</EntityId>
    <DisplayName>${spec.name ?? `Grid ${spec.id}`}</DisplayName>
    <IsStatic>false</IsStatic>
    <PositionAndOrientation><Position x="${pos.x}" y="${pos.y}" z="${pos.z}" /></PositionAndOrientation>
    <CubeBlocks>${blockXmls.join('')}</CubeBlocks>
  </MyObjectBuilder_EntityBase>`;
}

const SECTOR_HEADER = `<?xml version="1.0"?>
<MyObjectBuilder_Sector xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SectorObjects>`;
const SECTOR_FOOTER = `</SectorObjects></MyObjectBuilder_Sector>`;

const SBC_XML = `<?xml version="1.0"?>
<MyObjectBuilder_Checkpoint xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Identities>
    <MyObjectBuilder_Identity><IdentityId>111</IdentityId><DisplayName>owner</DisplayName></MyObjectBuilder_Identity>
    <MyObjectBuilder_Identity><IdentityId>222</IdentityId><DisplayName>Space Pirates</DisplayName></MyObjectBuilder_Identity>
    <MyObjectBuilder_Identity><IdentityId>333</IdentityId><DisplayName>\uE052owner</DisplayName></MyObjectBuilder_Identity>
  </Identities>
</MyObjectBuilder_Checkpoint>`;

function fixture(grids: GridSpec[], sbc = SBC_XML): { dir: string; sbsPath: string; sbcPath: string } {
  const dir = tempDir('se-rts-detector-');
  const sbsPath = path.join(dir, 'SANDBOX_0_0_0_.sbs');
  const sbcPath = path.join(dir, 'Sandbox.sbc');
  fs.writeFileSync(sbsPath, `${SECTOR_HEADER}${grids.map(gridXml).join('')}${SECTOR_FOOTER}`);
  fs.writeFileSync(sbcPath, sbc);
  return { dir, sbsPath, sbcPath };
}

const OWNER = { steamId: '10000000000000001', identityNames: ['owner'] };
const NOW = 1_700_000_000_000;

async function detect(grids: GridSpec[], sbc?: string) {
  const f = fixture(grids, sbc);
  return scanSave({ sbsPath: f.sbsPath, sbcPath: f.sbcPath, owner: OWNER, now: NOW });
}

describe('handoff detector', () => {
  it('finds a PB tagged in CustomName on a fully equipped grid owned by the owner', async () => {
    const report = await detect([
      { id: '100', name: 'Hermes Rig', owner: '111', pbName: '[HERMES-TEST] control', pos: { x: 1, y: 2, z: 3 } },
    ]);
    expect(report.error).toBeUndefined();
    expect(report.gridsScanned).toBe(1);
    expect(report.programmableBlocks).toBe(1);
    expect(report.candidates).toHaveLength(1);

    const candidate = report.candidates[0]!;
    expect(candidate.gridId).toBe('100');
    expect(candidate.gridName).toBe('Hermes Rig');
    expect(candidate.ownerName).toBe('owner');
    expect(candidate.ownerIsYou).toBe(true);
    expect(candidate.goal).toBe('hover');
    expect(candidate.ready).toBe(true);
    expect(candidate.missing).toEqual([]);
    expect(candidate.precheck).toMatchObject({
      hasPower: true,
      hasThrusters: true,
      hasGyro: true,
      hasControl: true,
      hasAntenna: true,
    });
    expect(candidate.position).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('finds a PB tagged via HERMES_TEST=READY in CustomData and reads the goal', async () => {
    const report = await detect([
      {
        id: '101',
        pbName: 'script',
        pbData: 'HERMES_TEST=READY\nHERMES_GOAL=interplanetary',
      },
    ]);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]!.goal).toBe('interplanetary');
    expect(report.candidates[0]!.ready).toBe(true);
  });

  it('defaults an invalid goal to hover', async () => {
    const report = await detect([{ id: '102', pbName: '[HERMES-TEST]', pbData: 'HERMES_GOAL=banana' }]);
    expect(report.candidates[0]!.goal).toBe('hover');
  });

  it('flags a grid owned by someone else as not ready', async () => {
    const report = await detect([{ id: '103', owner: '222', pbName: '[HERMES-TEST] rig' }]);
    const candidate = report.candidates[0]!;
    expect(candidate.ownerIsYou).toBe(false);
    expect(candidate.ownerName).toBe('Space Pirates');
    expect(candidate.ready).toBe(false);
    expect(candidate.missing).toContain('owner is not the owner');
  });

  it('reports missing thrusters and gyro', async () => {
    const report = await detect([
      { id: '104', pbName: '[HERMES-TEST]', blocks: ['Reactor', 'Cockpit', 'RadioAntenna'] },
    ]);
    const candidate = report.candidates[0]!;
    expect(candidate.ready).toBe(false);
    expect(candidate.missing).toContain('thrusters');
    expect(candidate.missing).toContain('gyro');
  });

  it('ignores grids without a tagged PB', async () => {
    const report = await detect([{ id: '105', pbName: 'unrelated script', pbData: 'print("hi")' }]);
    expect(report.candidates).toEqual([]);
    expect(report.gridsScanned).toBe(1);
    expect(report.gridsWithProgrammableBlocks).toBe(1);
    expect(report.programmableBlocks).toBe(1);
  });

  it('handles multiple grids and only reports tagged ones', async () => {
    const report = await detect([
      { id: '106', pbName: '[HERMES-TEST] a' },
      { id: '107', pbName: 'idle' },
      { id: '108', pbName: '[HERMES-TEST] c' },
    ]);
    expect(report.gridsScanned).toBe(3);
    expect(report.candidates.map((c) => c.gridId)).toEqual(['106', '108']);
  });

  it('matches the owner by identity name despite private-use prefix characters', async () => {
    const report = await detect([{ id: '109', owner: '333', pbName: '[HERMES-TEST]' }]);
    expect(report.candidates[0]!.ownerName).toBe('owner');
    expect(report.candidates[0]!.ownerIsYou).toBe(true);
  });

  it('reports a missing save instead of throwing', async () => {
    const dir = tempDir('se-rts-detector-missing-');
    const report = await scanSave({
      sbsPath: path.join(dir, 'nope.sbs'),
      sbcPath: path.join(dir, 'nope.sbc'),
      owner: OWNER,
      now: NOW,
    });
    expect(report.candidates).toEqual([]);
    expect(report.error).toContain('save file not found');
  });

  it('serves candidates through GET /api/handoff/candidates', async () => {
    const f = fixture([{ id: '200', name: 'API Rig', pbName: '[HERMES-TEST] api' }]);
    // 8764 is also used by the demo-site `vite preview`; a dev preview left
    // running makes this test fail with "Server is not running". Use a port
    // outside the demo/test range.
    const PORT = 8899;
    // Hermetic: a live demo server's exported RTS_DEMO/RTS_ENV in the shell
    // would make createRuntime demand the test-server lock markers. This test
    // exercises the handoff route, not the demo env gate.
    const saved = { demo: process.env.RTS_DEMO, env: process.env.RTS_ENV, marker: process.env.RTS_TEST_SERVER_MARKER };
    delete process.env.RTS_DEMO;
    delete process.env.RTS_ENV;
    delete process.env.RTS_TEST_SERVER_MARKER;
    const runtime = createRuntime({
      config: makeConfig({
        port: PORT,
        detector: { sbsPath: f.sbsPath, sbcPath: f.sbcPath, refreshMs: 60000 },
      }),
    });
    try {
      await runtime.listen(PORT);
      const res = await httpRequest<{ candidates: { gridId: string; ready: boolean }[] }>(
        PORT,
        'GET',
        '/api/handoff/candidates?refresh=1',
      );
      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(1);
      expect(res.body.candidates[0]).toMatchObject({ gridId: '200', ready: true });
    } finally {
      await runtime.close();
      if (saved.demo !== undefined) process.env.RTS_DEMO = saved.demo;
      if (saved.env !== undefined) process.env.RTS_ENV = saved.env;
      if (saved.marker !== undefined) process.env.RTS_TEST_SERVER_MARKER = saved.marker;
    }
  });

  it.skipIf(!fs.existsSync(SAVE))('runs read-only against the real synced save', async () => {
    const report = await scanSave({ sbsPath: SAVE, sbcPath: SBC, owner: OWNER, now: NOW });
    expect(report.error).toBeUndefined();
    expect(report.gridsScanned).toBeGreaterThan(0);
    // Current world state: PBs exist on one NPC grid, none tagged yet.
    expect(report.candidates.filter((c) => c.ready).length).toBe(0);
    for (const candidate of report.candidates) {
      expect(candidate.gridId).toMatch(/^\d+$/);
      expect(candidate.schemaVersion).toBe(1);
    }
  });
});
