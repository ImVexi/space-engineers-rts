/**
 * Curated stand-in hardware, derived from `docs/stand-in-candidates.md`
 * (`npm run profile` output over 965 prefabs). Only values that document
 * states are used here; laser range is a DEMO MODEL CAP (100 km) because the
 * definition says `MaxRange: -1` (unlimited) and no in-game measurement
 * exists. Every assumption is surfaced to the API consumer with a status.
 */
export interface StandIn {
  prefab: string;
  label: string;
  role: 'radio-relay' | 'laser-bridge' | 'laser-leaf' | 'station' | 'drone';
  /** Largest broadcasting radio antenna radius on the main grid, metres. */
  radioRadiusM: number | null;
  /** Demo laser model cap; null when the grid has no laser antenna. */
  laserRangeM: number | null;
  /** Laser antenna blocks on the main grid == simultaneously usable ports. */
  laserPorts: number;
  controllable: boolean;
  sizeClass: 'large' | 'small';
  isStatic: boolean;
  sourceNote: string;
}

const LASER_MODEL_CAP_M = 100_000;

export const STANDINS: Record<string, StandIn> = {
  'Eradicator_mk.1': {
    prefab: 'Eradicator_mk.1',
    label: 'Eradicator_mk.1 (radio relay)',
    role: 'radio-relay',
    radioRadiusM: 50_000,
    laserRangeM: null,
    laserPorts: 0,
    controllable: true,
    sizeClass: 'large',
    isStatic: false,
    sourceNote: 'vanilla; radio 50 km, ion thrust, RC/PB; docs/stand-in-candidates.md',
  },
  EncounterCitadelStation: {
    prefab: 'EncounterCitadelStation',
    label: 'EncounterCitadelStation (2 lasers, can fly)',
    role: 'laser-bridge',
    radioRadiusM: 10_000,
    laserRangeM: LASER_MODEL_CAP_M,
    laserPorts: 2,
    controllable: true,
    sizeClass: 'large',
    isStatic: false,
    sourceNote: 'vanilla; 2 laser antennas, ion thrust, RC; docs/stand-in-candidates.md',
  },
  'Encounter Mercenary': {
    prefab: 'Encounter Mercenary',
    label: 'Encounter Mercenary (1 laser leaf)',
    role: 'laser-leaf',
    radioRadiusM: 30_000,
    laserRangeM: LASER_MODEL_CAP_M,
    laserPorts: 1,
    controllable: true,
    sizeClass: 'large',
    isStatic: true,
    sourceNote: 'vanilla; 1 laser antenna, needs launch; docs/stand-in-candidates.md',
  },
  Repair_Satellite: {
    prefab: 'Repair_Satellite',
    label: 'Repair_Satellite (1 laser, small)',
    role: 'laser-leaf',
    radioRadiusM: 5_000,
    laserRangeM: LASER_MODEL_CAP_M,
    laserPorts: 1,
    controllable: true,
    sizeClass: 'large',
    isStatic: true,
    sourceNote: 'vanilla; 1 laser antenna, ion thruster; docs/stand-in-candidates.md',
  },
  'Large Control Drone': {
    prefab: 'Large Control Drone',
    label: 'Large Control Drone (atmo hull, 1 km radio)',
    role: 'drone',
    radioRadiusM: 1_000,
    laserRangeM: LASER_MODEL_CAP_M,
    laserPorts: 1,
    controllable: true,
    sizeClass: 'large',
    isStatic: false,
    sourceNote:
      'vanilla; measured 2026-11-09: 19 atmo thrusters, mass 222,711 kg, TWR 2.45 at 5.7 km AGL, RC, 1 km radio (needs legs < ~900 m to stay gate-reachable)',
  },
  'Escort TT-420': {
    prefab: 'Escort TT-420',
    label: 'Escort TT-420 (atmo+H2 hull, no antenna)',
    role: 'drone',
    radioRadiusM: null,
    laserRangeM: null,
    laserPorts: 0,
    controllable: true,
    sizeClass: 'large',
    isStatic: false,
    sourceNote:
      'vanilla; measured 2026-11-09: 10 atmo + 7 H2 thrusters, mass 305,085 kg, TWR 9.0 at 2.9 km AGL, H2 tank 99.96 %, batteries full, RC 1; no radio antenna so the comms gate refuses it',
  },
  EarthEasyStation: {
    prefab: 'EarthEasyStation',
    label: 'EarthEasyStation (ground station)',
    role: 'station',
    radioRadiusM: 50_000,
    laserRangeM: LASER_MODEL_CAP_M,
    laserPorts: 1,
    controllable: false,
    sizeClass: 'large',
    isStatic: true,
    sourceNote: 'vanilla station; radio 50 km; control source anchor in this demo',
  },
  AlienEasyStation: {
    prefab: 'AlienEasyStation',
    label: 'AlienEasyStation (ground station)',
    role: 'station',
    radioRadiusM: 50_000,
    laserRangeM: LASER_MODEL_CAP_M,
    laserPorts: 1,
    controllable: false,
    sizeClass: 'large',
    isStatic: true,
    sourceNote: 'vanilla station; radio 50 km; isolated in this demo fixture',
  },
};

export function getStandIn(prefab: string): StandIn | null {
  return STANDINS[prefab] ?? null;
}

/**
 * Plugin telemetry carries the grid DisplayName, which for NPC stand-ins is the
 * human name (`Eradicator mk.1`), not the prefab SubtypeId. Normalising both
 * sides lets the gate find a capability profile without inventing one.
 */
export function getStandInByName(name: string | null | undefined): StandIn | null {
  if (!name) return null;
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const s of Object.values(STANDINS)) {
    if (s.prefab.toLowerCase().replace(/[^a-z0-9]/g, '') === n) return s;
  }
  return null;
}

export function listStandIns(): StandIn[] {
  return Object.values(STANDINS).sort((a, b) => a.prefab.localeCompare(b.prefab));
}

/** Hardware summary strings the connect popup shows next to the choices. */
export function hardwareSummary(): {
  radio: string;
  laser: string;
  mixed: string;
  lasersAvailable: number;
  radioRelaysAvailable: number;
} {
  const radio = STANDINS['Eradicator_mk.1']!;
  const laser = STANDINS.EncounterCitadelStation!;
  return {
    radio: `radio relays: ${radio.prefab} ${(radio.radioRadiusM ?? 0) / 1000} km radius, ${radio.controllable ? 'RC/PB controllable' : 'not controllable'}`,
    laser: `laser-capable flyer available: ${laser.prefab} (${laser.laserPorts} lasers, ${(laser.laserRangeM ?? 0) / 1000} km model cap)`,
    mixed: 'laser backbone + radio last mile at both anchors',
    lasersAvailable: laser.laserPorts,
    radioRelaysAvailable: 1,
  };
}
