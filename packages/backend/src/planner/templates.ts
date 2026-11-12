import {
  NodeTemplateSchema,
  type CapabilityProfile,
  type NodeTemplate,
} from '@se-rts/schemas';

/** Named templates the CLI and REST API accept without a profile file. */
const PRESETS: Record<string, Omit<NodeTemplate, 'id'>> = {
  'radio-5km': { radioRadiusM: 5000, laserRangeM: null, laserUnlimited: false },
  'radio-10km': { radioRadiusM: 10000, laserRangeM: null, laserUnlimited: false },
  'radio-20km': { radioRadiusM: 20000, laserRangeM: null, laserUnlimited: false },
  'radio-50km': { radioRadiusM: 50000, laserRangeM: null, laserUnlimited: false },
  'laser-40km': { radioRadiusM: null, laserRangeM: 40000, laserUnlimited: false },
  'laser-unlimited': { radioRadiusM: null, laserRangeM: null, laserUnlimited: true },
};

export function presetTemplateNames(): string[] {
  return Object.keys(PRESETS).sort();
}

/** Derives a template from a real profiled grid (radio first, laser fallback). */
export function templateFromProfile(profile: CapabilityProfile): NodeTemplate {
  const radio = profile.radioAntennas
    .filter((a) => a.enabled === true && a.broadcasting === true && (a.radiusM ?? 0) > 0)
    .reduce((max, a) => Math.max(max, a.radiusM ?? 0), 0);
  const unlimited = profile.laserAntennas.some((a) => a.enabled === true && a.unlimited === true);
  const laserRange = profile.laserAntennas
    .filter((a) => a.enabled === true && a.maxRangeM !== null)
    .reduce((max, a) => Math.max(max, a.maxRangeM?.value ?? 0), 0);
  return NodeTemplateSchema.parse({
    id: profile.gridId,
    radioRadiusM: radio > 0 ? radio : null,
    laserRangeM: laserRange > 0 ? laserRange : null,
    laserUnlimited: unlimited,
  });
}

export function resolveTemplate(
  spec: string,
  profiles: CapabilityProfile[] = [],
): NodeTemplate {
  const preset = PRESETS[spec];
  if (preset) return NodeTemplateSchema.parse({ id: spec, ...preset });
  const profile = profiles.find((p) => p.gridId === spec || p.name === spec);
  if (profile) return templateFromProfile(profile);
  throw new Error(
    `unknown template "${spec}" (known: ${[...presetTemplateNames(), ...profiles.map((p) => p.gridId)].join(', ')})`,
  );
}
