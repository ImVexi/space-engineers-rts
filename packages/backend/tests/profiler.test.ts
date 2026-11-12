import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileSave } from '../src/capabilities/profiler.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-rts-profile-'));

const DEFS = `<?xml version="1.0" encoding="utf-8"?>
<Definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CubeBlocks>
    <Definition xsi:type="MyObjectBuilder_RadioAntennaDefinition">
      <Id><TypeId>RadioAntenna</TypeId><SubtypeId>SmallBlockRadioAntenna</SubtypeId></Id>
      <CubeSize>Small</CubeSize>
      <MaxBroadcastRadius>200000</MaxBroadcastRadius>
    </Definition>
    <Definition xsi:type="MyObjectBuilder_LaserAntennaDefinition">
      <Id><TypeId>LaserAntenna</TypeId><SubtypeId>LargeBlockLaserAntenna</SubtypeId></Id>
      <CubeSize>Large</CubeSize>
      <MaxRange>-1</MaxRange>
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
      <MaxPowerOutput>4</MaxPowerOutput>
    </Definition>
    <Definition xsi:type="MyObjectBuilder_GasTankDefinition">
      <Id><TypeId>GasTank</TypeId><SubtypeId>LargeHydrogenTank</SubtypeId></Id>
      <Capacity>15000000</Capacity>
    </Definition>
  </CubeBlocks>
</Definitions>`;

function block(type: string, subtype: string, owner: string, extra = ''): string {
  return `<MyObjectBuilder_CubeBlock xsi:type="MyObjectBuilder_${type}">
    <SubtypeName>${subtype}</SubtypeName><Owner>${owner}</Owner>${extra}
  </MyObjectBuilder_CubeBlock>`;
}

function grid(id: string, name: string, size: string, blocks: string, extra = ''): string {
  return `<MyObjectBuilder_EntityBase xsi:type="MyObjectBuilder_CubeGrid">
    <EntityId>${id}</EntityId><DisplayName>${name}</DisplayName><GridSizeEnum>${size}</GridSizeEnum>${extra}
    <PositionAndOrientation><Position x="1" y="2" z="3" /></PositionAndOrientation>
    <CubeBlocks>${blocks}</CubeBlocks>
  </MyObjectBuilder_EntityBase>`;
}

const SBS = `<?xml version="1.0"?>
<MyObjectBuilder_Sector>
  <SectorObjects>
    ${grid(
      '1',
      'Radio Drone',
      'Small',
      [
        block('RadioAntenna', 'SmallBlockRadioAntenna', '900', '<Enabled>true</Enabled><BroadcastRadius>10000</BroadcastRadius><EnableBroadcasting>true</EnableBroadcasting>'),
        block('MyProgrammableBlock', 'SmallProgrammableBlock', '900', '<Enabled>true</Enabled>'),
        block('BatteryBlock', 'SmallBlockBatteryBlock', '900', '<Enabled>true</Enabled><CurrentStoredPower>0.5</CurrentStoredPower><MaxStoredPower>1</MaxStoredPower>'),
        block('Thrust', 'SmallBlockSmallAtmosphericThrust', '900', '<Enabled>true</Enabled>'),
        block('OxygenTank', 'LargeHydrogenTank', '900', '<Enabled>true</Enabled><FilledRatio>0.5</FilledRatio>'),
      ].join(''),
      '<Mass>5000</Mass>',
    )}
    ${grid(
      '2',
      'Laser Drone',
      'Large',
      [
        block('LaserAntenna', 'LargeBlockLaserAntenna', '901', '<Enabled>true</Enabled>'),
        block('RemoteControl', 'LargeBlockRemoteControl', '901', '<Enabled>true</Enabled>'),
      ].join(''),
    )}
    ${grid('3', 'No Antenna', 'Small', block('Gyro', 'SmallBlockGyro', '901', '<Enabled>true</Enabled>'))}
    ${grid(
      '4',
      'Missing Definition',
      'Small',
      block('RadioAntenna', 'MissingAntenna', '901', '<Enabled>true</Enabled><BroadcastRadius>7500</BroadcastRadius><EnableBroadcasting>true</EnableBroadcasting>'),
    )}
    <MyObjectBuilder_EntityBase xsi:type="MyObjectBuilder_EntityBase">
      <EntityId>99</EntityId>
      <ComponentData><Component>
        <SerializedPirateStation>
          ${grid('5', 'Pirate Prefab', 'Large', block('RadioAntenna', 'SmallBlockRadioAntenna', '900', '<Enabled>true</Enabled><BroadcastRadius>20000</BroadcastRadius><EnableBroadcasting>true</EnableBroadcasting>'))}
        </SerializedPirateStation>
      </Component></ComponentData>
    </MyObjectBuilder_EntityBase>
  </SectorObjects>
</MyObjectBuilder_Sector>`;

const SBC = `<?xml version="1.0"?>
<MyObjectBuilder_Sector>
  <Factions>
    <MyObjectBuilder_Faction>
      <FactionId>f1</FactionId><Tag>SPRT</Tag><Name>Space Pirates</Name>
      <Members><MyObjectBuilder_FactionMember><PlayerId>900</PlayerId></MyObjectBuilder_FactionMember></Members>
    </MyObjectBuilder_Faction>
    <MyObjectBuilder_Faction>
      <FactionId>f2</FactionId><Tag>FSTC</Tag><Name>First Colony</Name>
      <Members><MyObjectBuilder_FactionMember><PlayerId>901</PlayerId></MyObjectBuilder_FactionMember></Members>
    </MyObjectBuilder_Faction>
  </Factions>
  <Players><dictionary>
    <item><Key>900</Key><Value>f1</Value></item>
    <item><Key>901</Key><Value>f2</Value></item>
  </dictionary></Players>
  <AllPlayersData><dictionary>
    <item><Key><HashedId>1</HashedId></Key><Value>
      <DisplayName>owner</DisplayName><IdentityId>901</IdentityId>
    </Value></item>
  </dictionary></AllPlayersData>
  <Identities>
    <MyObjectBuilder_Identity><IdentityId>900</IdentityId><DisplayName>Pirate Bot</DisplayName></MyObjectBuilder_Identity>
    <MyObjectBuilder_Identity><IdentityId>901</IdentityId><DisplayName>owner</DisplayName></MyObjectBuilder_Identity>
  </Identities>
</MyObjectBuilder_Sector>`;

let report: Awaited<ReturnType<typeof profileSave>>;

beforeAll(async () => {
  fs.mkdirSync(path.join(root, 'defs', 'CubeBlocks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'save'), { recursive: true });
  fs.writeFileSync(path.join(root, 'defs', 'CubeBlocks', 'CubeBlocks_Test.sbc'), DEFS);
  fs.writeFileSync(path.join(root, 'save', 'SANDBOX_0_0_0_.sbs'), SBS);
  fs.writeFileSync(path.join(root, 'save', 'Sandbox.sbc'), SBC);
  report = await profileSave({
    sbsPath: path.join(root, 'save', 'SANDBOX_0_0_0_.sbs'),
    sbcPath: path.join(root, 'save', 'Sandbox.sbc'),
    defsPath: path.join(root, 'defs'),
    now: 123,
  });
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const byName = (name: string) => report.grids.find((g) => g.name === name)!;

describe('capability profiler', () => {
  it('excludes SerializedPirateStation prefabs and keeps top-level grids', () => {
    expect(report.gridsScanned).toBe(4);
    expect(report.gridsExcluded).toBe(1);
    expect(report.grids.map((g) => g.name).sort()).toEqual(
      ['Laser Drone', 'Missing Definition', 'No Antenna', 'Radio Drone'].sort(),
    );
  });

  it('profiles a radio-only drone with sourced numbers', () => {
    const g = byName('Radio Drone');
    expect(g.isNpc).toBe(true);
    expect(g.ownerKind).toBe('npc');
    expect(g.ownerFactionTag).toBe('SPRT');
    expect(g.sizeClass).toBe('small');
    expect(g.massKg).toBe(5000);
    expect(g.radioAntennas[0]?.radiusM).toBe(10000);
    expect(g.radioAntennas[0]?.maxRadiusM).toEqual({
      value: 200000,
      source: 'definition',
      subtype: 'SmallBlockRadioAntenna',
    });
    expect(g.programmableBlocks).toBe(1);
    expect(g.power.batteries.capacityMWh).toBe(1);
    expect(g.power.batteries.storedMWh).toBe(0.5);
    expect(g.thrusters.atmo.totalForceN).toBe(96000);
    expect(g.thrusters.atmo.bySubtype[0]?.forceN?.subtype).toBe('SmallBlockSmallAtmosphericThrust');
    expect(g.hydrogenTanks.count).toBe(1);
    expect(g.hydrogenTanks.capacityL).toBe(15000000);
    expect(g.hydrogenTanks.fillRatio).toBe(0.5);
    expect(g.hydrogenTanks.bySubtype[0]?.value?.subtype).toBe('LargeHydrogenTank');
    expect(g.roles.canRelay).toBe(true);
    expect(g.roles.canLaserLink).toBe(false);
    expect(g.roles.controllable).toBe(true);
    expect(g.roles.canFlyInGravity).toBe(true);
    expect(g.roles.canFlyInSpace).toBe(false);
  });

  it('profiles a player-owned laser drone', () => {
    const g = byName('Laser Drone');
    expect(g.isNpc).toBe(false);
    expect(g.ownerKind).toBe('player');
    expect(g.roles.canLaserLink).toBe(true);
    expect(g.laserAntennas[0]?.unlimited).toBe(true);
    expect(g.laserAntennas[0]?.maxRangeM).toBeNull();
    expect(g.roles.canRelay).toBe(false);
    expect(g.roles.controllable).toBe(true);
    expect(g.roles.canFlyInSpace).toBe(false);
  });

  it('profiles a drone with no antenna', () => {
    const g = byName('No Antenna');
    expect(g.radioAntennas).toEqual([]);
    expect(g.laserAntennas).toEqual([]);
    expect(g.roles.canRelay).toBe(false);
    expect(g.roles.canLaserLink).toBe(false);
    expect(g.roles.controllable).toBe(false);
  });

  it('emits nulls and records a missing definition instead of guessing', () => {
    const g = byName('Missing Definition');
    expect(g.radioAntennas[0]?.radiusM).toBe(7500);
    expect(g.radioAntennas[0]?.maxRadiusM).toBeNull();
    expect(g.missingDefinitions).toContain('MissingAntenna');
    expect(g.massKg).toBeNull();
    expect(g.roles.canFlyInGravity).toBe('unknown');
  });
});
