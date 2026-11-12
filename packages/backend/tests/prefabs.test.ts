import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePrefabFile, profilePrefabFile, profilePrefabs } from '../src/capabilities/prefabs.js';
import { loadDefinitions } from '../src/capabilities/definitions.js';
import { loadSpawnGroups } from '../src/capabilities/spawnGroups.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-rts-prefabs-'));

const DEFS = `<?xml version="1.0" encoding="utf-8"?>
<Definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CubeBlocks>
    <Definition xsi:type="MyObjectBuilder_RadioAntennaDefinition">
      <Id><TypeId>RadioAntenna</TypeId><SubtypeId>SmallBlockRadioAntenna</SubtypeId></Id>
      <CubeSize>Small</CubeSize>
      <Size x="1" y="1" z="1" />
      <MaxBroadcastRadius>200000</MaxBroadcastRadius>
    </Definition>
    <Definition xsi:type="MyObjectBuilder_LaserAntennaDefinition">
      <Id><TypeId>LaserAntenna</TypeId><SubtypeId>LargeBlockLaserAntenna</SubtypeId></Id>
      <CubeSize>Large</CubeSize>
      <MaxRange>-1</MaxRange>
    </Definition>
    <Definition xsi:type="MyObjectBuilder_ThrustDefinition">
      <Id><TypeId>Thrust</TypeId><SubtypeId>SmallBlockSmallThrust</SubtypeId></Id>
      <CubeSize>Small</CubeSize>
      <ThrusterType>Ion</ThrusterType>
      <ForceMagnitude>14400</ForceMagnitude>
    </Definition>
    <Definition xsi:type="MyObjectBuilder_ThrustDefinition">
      <Id><TypeId>Thrust</TypeId><SubtypeId>SmallBlockSmallAtmosphericThrust</SubtypeId></Id>
      <CubeSize>Small</CubeSize>
      <ThrusterType>Atmospheric</ThrusterType>
      <ForceMagnitude>96000</ForceMagnitude>
    </Definition>
    <Definition xsi:type="MyObjectBuilder_BatteryBlockDefinition">
      <Id><TypeId>BatteryBlock</TypeId><SubtypeId>SmallBlockBatteryBlock</SubtypeId></Id>
      <MaxStoredPower>1</MaxStoredPower>
    </Definition>
    <Definition xsi:type="MyObjectBuilder_GasTankDefinition">
      <Id><TypeId>OxygenTank</TypeId><SubtypeId>LargeHydrogenTank</SubtypeId></Id>
      <CubeSize>Large</CubeSize>
      <Capacity>15000000</Capacity>
    </Definition>
  </CubeBlocks>
</Definitions>`;

function block(type: string, subtype: string, extra = ''): string {
  return `<MyObjectBuilder_CubeBlock xsi:type="MyObjectBuilder_${type}">
      <SubtypeName>${subtype}</SubtypeName>${extra}
    </MyObjectBuilder_CubeBlock>`;
}

function grid(id: string, displayName: string, size: string, blocks: string | string[], opts: { isStatic?: boolean; mass?: number } = {}): string {
  return `<CubeGrid>
    <SubtypeName />
    <EntityId>${id}</EntityId>
    <DisplayName>${displayName}</DisplayName>
    <GridSizeEnum>${size}</GridSizeEnum>
    <IsStatic>${opts.isStatic ? 'true' : 'false'}</IsStatic>
    <PositionAndOrientation><Position x="0" y="0" z="0" /></PositionAndOrientation>
    <CubeBlocks>${blocks}</CubeBlocks>${opts.mass === undefined ? '' : `\n    <Mass>${opts.mass}</Mass>`}
  </CubeGrid>`;
}

function prefab(subtype: string, grids: string[]): string {
  return `<?xml version="1.0"?>
<Definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Prefabs>
    <Prefab xsi:type="MyObjectBuilder_PrefabDefinition">
      <Id Type="MyObjectBuilder_PrefabDefinition" Subtype="${subtype}" />
      <CubeGrids>
        ${grids.join('\n')}
      </CubeGrids>
    </Prefab>
  </Prefabs>
</Definitions>`;
}

// Two grids: a tiny 2-block escort first, the real ship second. The main grid
// must be picked by block count, not by file order.
const RELAY = prefab('(NPC-TEST) Relay Drone', [
  grid(
    '1',
    'Escort Bit',
    'Small',
    block('Thrust', 'SmallBlockSmallThrust', '<Enabled>true</Enabled>'),
  ),
  grid(
    '2',
    'Relay Drone',
    'Small',
    [
      block('RadioAntenna', 'SmallBlockRadioAntenna', '<Enabled>true</Enabled><BroadcastRadius>8000</BroadcastRadius><EnableBroadcasting>true</EnableBroadcasting>'),
      block('Thrust', 'SmallBlockSmallThrust', '<Enabled>true</Enabled>'),
      block('Thrust', 'SmallBlockSmallThrust', '<Enabled>true</Enabled>'),
      block('RemoteControl', 'SmallBlockRemoteControl', '<Enabled>true</Enabled>'),
      block('Gyro', 'SmallBlockGyro', '<Enabled>true</Enabled>'),
      block('BatteryBlock', 'SmallBlockBatteryBlock', '<Enabled>true</Enabled>'),
      block('OxygenTank', 'LargeHydrogenTank', '<Enabled>true</Enabled>'),
    ],
    { mass: 12000 },
  ),
]);

// A legacy prefab that is gzip-compressed on disk, with a single large grid
// carrying one laser antenna (leaf node).
const LASER_LEAF = prefab('(NPC-TEST) Laser Leaf', [
  grid(
    '3',
    'Laser Leaf',
    'Large',
    [
      block('LaserAntenna', 'LargeBlockLaserAntenna', '<Enabled>true</Enabled>'),
      block('RadioAntenna', 'SmallBlockRadioAntenna', '<Enabled>true</Enabled><BroadcastRadius>5000</BroadcastRadius><EnableBroadcasting>true</EnableBroadcasting>'),
      block('Thrust', 'SmallBlockSmallAtmosphericThrust', '<Enabled>true</Enabled>'),
    ],
    { mass: 20000 },
  ),
]);

const SPAWN_GROUPS = `<?xml version="1.0"?>
<Definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SpawnGroups>
    <SpawnGroup>
      <Id><TypeId>SpawnGroupDefinition</TypeId><SubtypeId>TEST-SpawnGroup-Relay</SubtypeId></Id>
      <Description>
[Modular Encounters SpawnGroup]
[SpaceCargoShip:
  true]
      </Description>
      <IsPirate>true</IsPirate>
      <Prefabs>
        <Prefab SubtypeId="(NPC-TEST) Relay Drone"><Speed>10</Speed></Prefab>
      </Prefabs>
    </SpawnGroup>
    <SpawnGroup>
      <Id><TypeId>SpawnGroupDefinition</TypeId><SubtypeId>TEST-SpawnGroup-Laser</SubtypeId></Id>
      <Description>[Modular Encounters SpawnGroup]
[AtmosphericCargoShip:true]
[AdminSpawnOnly:true]</Description>
      <Prefabs>
        <Prefab SubtypeId="(NPC-TEST) Laser Leaf" />
        <Prefab SubtypeId="(NPC-TEST) Not Installed" />
      </Prefabs>
    </SpawnGroup>
  </SpawnGroups>
</Definitions>`;

let defs: Awaited<ReturnType<typeof loadDefinitions>>;

beforeAll(async () => {
  fs.mkdirSync(path.join(root, 'defs', 'CubeBlocks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'defs', 'CubeBlocks', 'CubeBlocks_Test.sbc'), DEFS);
  defs = await loadDefinitions(path.join(root, 'defs'));

  fs.mkdirSync(path.join(root, 'prefabs', 'Drones'), { recursive: true });
  fs.mkdirSync(path.join(root, 'prefabs', 'LegacyContent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prefabs', 'Drones', '(NPC-TEST) Relay Drone.sbc'), RELAY);
  fs.writeFileSync(path.join(root, 'prefabs', 'LegacyContent', 'Laser Leaf.sbc'), zlib.gzipSync(LASER_LEAF));

  fs.mkdirSync(path.join(root, 'sg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sg', 'TEST-SpawnGroups.sbc'), SPAWN_GROUPS);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('prefab profiler', () => {
  it('reads every CubeGrid in a prefab file', async () => {
    const parsed = await parsePrefabFile(path.join(root, 'prefabs', 'Drones', '(NPC-TEST) Relay Drone.sbc'));
    expect(parsed.subtype).toBe('(NPC-TEST) Relay Drone');
    expect(parsed.grids.map((g) => g.blocks.length)).toEqual([1, 7]);
  });

  it('transparently reads gzip-compressed legacy prefabs', async () => {
    const parsed = await parsePrefabFile(path.join(root, 'prefabs', 'LegacyContent', 'Laser Leaf.sbc'));
    expect(parsed.subtype).toBe('(NPC-TEST) Laser Leaf');
    expect(parsed.grids[0]!.blocks).toHaveLength(3);
  });

  it('profiles the block-heaviest grid of a multi-grid prefab', async () => {
    const p = await profilePrefabFile(path.join(root, 'prefabs', 'Drones', '(NPC-TEST) Relay Drone.sbc'), {
      definitions: defs,
    });
    expect(p).not.toBeNull();
    expect(p!.gridCount).toBe(2);
    expect(p!.mainGridIndex).toBe(1);
    expect(p!.gridBlockCounts).toEqual([1, 7]);
    expect(p!.main.name).toBe('Relay Drone');
    expect(p!.main.radioAntennas[0]?.radiusM).toBe(8000);
    expect(p!.main.radioAntennas[0]?.maxRadiusM?.value).toBe(200000);
    expect(p!.main.thrusters.ion.totalForceN).toBe(28800);
    expect(p!.main.remoteControls).toBe(1);
    expect(p!.main.gyros).toBe(1);
    expect(p!.main.hydrogenTanks.capacityL).toBe(15000000);
    expect(p!.main.massKg).toBe(12000);
    expect(p!.main.roles.canRelay).toBe(true);
    expect(p!.main.roles.canFlyInSpace).toBe(true);
    expect(p!.main.roles.canFlyInGravity).toBe(false);
    expect(p!.estimatedPcu).toBe(7);
  });

  it('scans a tree and labels each prefab with its file and source', async () => {
    const { prefabs, filesScanned } = await profilePrefabs({
      prefabRoots: [path.join(root, 'prefabs')],
      defsPath: path.join(root, 'defs'),
    });
    expect(filesScanned).toBe(2);
    expect(prefabs.map((p) => p.subtype).sort()).toEqual(['(NPC-TEST) Laser Leaf', '(NPC-TEST) Relay Drone']);
    const leaf = prefabs.find((p) => p.subtype === '(NPC-TEST) Laser Leaf')!;
    expect(leaf.main.sizeClass).toBe('large');
    expect(leaf.main.laserAntennas).toHaveLength(1);
    expect(leaf.main.laserAntennas[0]?.unlimited).toBe(true);
    expect(leaf.estimatedPcu).toBe(30);
    expect(leaf.estimatedMassKg).toBeNull();
  });

  it('maps spawn groups back to the prefab SubtypeIds they reference', async () => {
    const index = await loadSpawnGroups([path.join(root, 'sg')]);
    const relay = index.get('(NPC-TEST) Relay Drone');
    expect(relay?.map((r) => r.group)).toEqual(['TEST-SpawnGroup-Relay']);
    expect(relay?.[0]?.hints).toContain('space-cargo');
    expect(relay?.[0]?.adminOnly).toBe(false);
    const leaf = index.get('(NPC-TEST) Laser Leaf');
    expect(leaf?.[0]?.hints).toContain('planet-cargo');
    expect(leaf?.[0]?.adminOnly).toBe(true);
    // A referenced prefab that is not installed is still indexed by subtype.
    expect(index.has('(NPC-TEST) Not Installed')).toBe(true);
  });

  it('returns null for a file with no grid', async () => {
    const empty = path.join(root, 'prefabs', 'Empty.sbc');
    fs.writeFileSync(empty, '<?xml version="1.0"?><Definitions><Prefabs/></Definitions>');
    await expect(profilePrefabFile(empty, { definitions: defs })).resolves.toBeNull();
  });
});
