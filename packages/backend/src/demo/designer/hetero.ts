/**
 * Heterogeneous ship-to-slot assignment (T22).
 *
 * Hard constraints per slot, in this order:
 *   1. radio — the hull's measured antenna (times the range margin) must cover
 *      the longest link the slot has to carry;
 *   2. laser — every laser edge needs a free port on the hull and a laser range
 *      that covers the edge (a converter bridges laser <-> radio);
 *   3. tier — the hull must be able to reach and hold the slot altitude
 *      (atmo <= 10 km, H2 anywhere, ion >= 45 km or carried);
 *   4. power — only when the T30 power module supplies a budget function. When
 *      it does not exist the planner skips it with a note instead of inventing
 *      a number.
 *
 * Objective, in order: avoid a new build (reuse an existing owner-tagged ship),
 * avoid a carrier tow, fewer hull types, cheaper/smaller hull, less movement.
 * One ship fills one slot, so "minimise ships" means "fill every slot with the
 * fewest new builds"; an existing hull is always preferred to a clone.
 */
import type { DesignerHull } from './hulls.js';
import {
  BASE_ALTITUDE_M,
  ION_MIN_ALTITUDE_M,
  classifyHull,
  roleSummary,
  tierAtAltitude,
  type HullCapability,
  type HullTier,
} from './classification.js';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SlotRequirement {
  slotId: string;
  position: Vec3;
  altitudeM: number;
  gravityMps2: number;
  tier: HullTier;
  /** Longest radio link this slot must carry, metres. */
  requiredRadioM: number;
  /** Laser ports needed (one per laser edge incident to the slot). */
  requiredLaserPorts: number;
  /** Longest laser edge, metres; null when the slot has no laser edge. */
  laserLinkM: number | null;
  /** False when a planned laser edge at this slot is blocked by a planet. */
  losClear?: boolean;
  /** A station may fill this slot (T18: any altitude above 100 m AGL). */
  stationAllowed: boolean;
  /** Optional hint from the plan (e.g. 'coverage', 'bridge', 'apex'). */
  roleHint?: string;
}

export interface SlotAssignment {
  slotId: string;
  slotIndex: number;
  altitudeM: number;
  tier: HullTier;
  hullId: string;
  hullName: string;
  source: DesignerHull['source'];
  role: string;
  flightMode: 'autopilot' | 'level';
  /** True when an existing owner-tagged grid filled the slot (no new build). */
  reused: boolean;
  /** True when the hull cannot reach the slot on its own and must be carried. */
  carried: boolean;
  requiredRadioM: number;
  radioHeadroomM: number | null;
  moveM: number | null;
  why: string;
  labels: string[];
}

export interface UnfilledSlot {
  slotId: string;
  slotIndex: number;
  altitudeM: number;
  tier: HullTier;
  code: string;
  reason: string;
  gap: string;
  hint: string;
}

export interface MissingHullType {
  slotId: string;
  need: string;
  gap: string;
}

export interface SlotPowerVerdict {
  ok: boolean;
  reason: string;
}

export type SlotPowerCheck = (args: {
  hull: DesignerHull;
  capability: HullCapability;
  slot: SlotRequirement;
}) => SlotPowerVerdict;

export interface HeteroAssignment {
  assignments: SlotAssignment[];
  unfilled: UnfilledSlot[];
  missingHullTypes: MissingHullType[];
  shipCount: number;
  existingUsed: number;
  newBuilds: number;
  hullTypes: string[];
  carriedCount: number;
  power: { checked: boolean; skipped: boolean; note: string };
  objective: string[];
  labels: string[];
}

export interface AssignOptions {
  rangeMargin?: number;
  /** Existing physical positions (owner-tagged grids), by hull id. */
  positions?: Record<string, Vec3>;
  /** Optional T30 power budget; null/undefined = skipped. */
  powerCheck?: SlotPowerCheck | null;
  powerNote?: string | null;
  /** Cap new builds (prefabs); excess slots stay unfilled with a queued hint. */
  maxNewBuilds?: number;
}

interface Verdict {
  ok: boolean;
  code: string;
  reason: string;
  carried: boolean;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function tierLabel(tier: HullTier): string {
  switch (tier) {
    case 'ground':
      return 'on the ground';
    case 'atmo':
      return 'atmo tier';
    case 'zero-g':
      return 'zero gravity';
    default:
      return 'inside gravity';
  }
}

function tierOk(cap: HullCapability, slot: SlotRequirement): { ok: boolean; carried: boolean; reason: string } {
  const altitude = slot.altitudeM;
  if (slot.tier === 'ground') {
    if (cap.stationOnly) return { ok: true, carried: false, reason: 'placed on the ground (no thrust needed)' };
    if (cap.tierEligibility.atmo || cap.tierEligibility.h2) return { ok: true, carried: false, reason: 'can lift from the ground' };
    if (cap.tierEligibility.ion) {
      return {
        ok: true,
        carried: true,
        reason: `ion-only hull: orbital spawn (${(ION_MIN_ALTITUDE_M / 1000).toFixed(0)} km) or a carrier is needed to place it on the ground`,
      };
    }
    return { ok: false, carried: false, reason: 'no thrust and not a station-only grid' };
  }
  if (slot.tier === 'zero-g') {
    // In zero-g a relay needs no hold thrust at all: an H2/ion hull can be
    // placed orbitally, and any other grid can be towed and stationed.
    if (cap.tierEligibility.h2 || cap.tierEligibility.ion) {
      return { ok: true, carried: false, reason: 'zero-g: no hold thrust needed; H2/ion hull can be placed orbitally' };
    }
    if (cap.stationCapable) {
      return { ok: true, carried: true, reason: 'zero-g: no hold thrust needed; must be towed to the slot' };
    }
    return { ok: false, carried: false, reason: 'cannot hold a zero-g slot' };
  }
  if (cap.tierEligibility.h2) return { ok: true, carried: false, reason: 'H2 thrust holds at any altitude' };
  if (slot.tier === 'atmo' && cap.tierEligibility.atmo) {
    return { ok: true, carried: false, reason: `atmo thrust holds up to ${(cap.ceilings.atmoM / 1000).toFixed(0)} km` };
  }
  if (cap.tierEligibility.ion && altitude >= ION_MIN_ALTITUDE_M) {
    return { ok: true, carried: false, reason: `ion holds from ${(ION_MIN_ALTITUDE_M / 1000).toFixed(0)} km (orbital spawn)` };
  }
  if (cap.stationOnly && altitude >= 100) {
    return { ok: true, carried: true, reason: 'no thrust: must be towed to the slot, then stationed' };
  }
  if (cap.stationCapable && altitude >= 100) {
    return {
      ok: true,
      carried: true,
      reason:
        cap.tierEligibility.atmo
          ? `atmo-only hull: cannot reach ${(altitude / 1000).toFixed(1)} km on its own (ceiling ${(cap.ceilings.atmoM / 1000).toFixed(0)} km); carried, then stationed`
          : `not self-deploying at ${(altitude / 1000).toFixed(1)} km: carried, then stationed`,
    };
  }
  return { ok: false, carried: false, reason: `cannot hold ${(altitude / 1000).toFixed(1)} km` };
}

function evaluate(
  hull: DesignerHull,
  cap: HullCapability,
  slot: SlotRequirement,
  options: AssignOptions,
): Verdict {
  const margin = options.rangeMargin ?? 0.9;
  if (slot.requiredRadioM > 0) {
    if (cap.radioRangeM === null || !(cap.radioRangeM > 0)) {
      return { ok: false, code: 'no_radio', reason: 'hull has no radio antenna', carried: false };
    }
    const effective = cap.radioRangeM * margin;
    if (effective + 0.5 < slot.requiredRadioM) {
      return {
        ok: false,
        code: 'radio_range_short',
        reason: `radio ${(effective / 1000).toFixed(1)} km (${(cap.radioRangeM / 1000).toFixed(0)} km x ${margin}) is shorter than the ${(slot.requiredRadioM / 1000).toFixed(1)} km link at this slot`,
        carried: false,
      };
    }
  }
  if (slot.requiredLaserPorts > 0) {
    if (slot.losClear === false) {
      return { ok: false, code: 'laser_los_blocked', reason: 'a planned laser edge at this slot is blocked by a planet', carried: false };
    }
    if (cap.laserPorts < slot.requiredLaserPorts) {
      return {
        ok: false,
        code: 'laser_ports_short',
        reason: `needs ${slot.requiredLaserPorts} free laser port(s), hull has ${cap.laserPorts}`,
        carried: false,
      };
    }
    if (slot.laserLinkM !== null) {
      if (cap.laserRangeM === null) {
        return { ok: false, code: 'laser_range_unknown', reason: 'laser range is not measured on this hull', carried: false };
      }
      if (cap.laserRangeM + 0.5 < slot.laserLinkM) {
        return {
          ok: false,
          code: 'laser_range_short',
          reason: `laser ${(cap.laserRangeM / 1000).toFixed(0)} km is shorter than the ${(slot.laserLinkM / 1000).toFixed(1)} km laser edge`,
          carried: false,
        };
      }
    }
  }
  const tier = tierOk(cap, slot);
  if (!tier.ok) return { ok: false, code: 'tier_ineligible', reason: tier.reason, carried: tier.carried };

  if (options.powerCheck) {
    const verdict = options.powerCheck({ hull, capability: cap, slot });
    if (!verdict.ok) {
      return { ok: false, code: 'power_budget', reason: verdict.reason, carried: tier.carried };
    }
  }
  return { ok: true, code: 'ok', reason: tier.reason, carried: tier.carried };
}

function usedTypeKey(hull: DesignerHull): string {
  // Prefab types are what get built; owner-tagged grids are individual ships.
  return hull.source === 'prefab' ? `prefab:${hull.name}` : hull.id;
}

/**
 * Assign hulls to slots. Deterministic: candidates are sorted by a fixed key
 * and ties fall back to the hull id, never to input order.
 */
export function assignHullsToSlots(
  hulls: DesignerHull[],
  requirements: SlotRequirement[],
  options: AssignOptions = {},
): HeteroAssignment {
  const capabilities = new Map(hulls.map((hull) => [hull.id, classifyHull(hull)]));
  const usedIds = new Set<string>();
  const usedTypes = new Set<string>();
  const assignments: SlotAssignment[] = [];
  const unfilled: UnfilledSlot[] = [];
  const positions = options.positions ?? {};

  // Strictest slots first: laser ports, then radio length, then altitude.
  const order = requirements
    .map((slot, index) => ({ slot, index }))
    .sort(
      (a, b) =>
        b.slot.requiredLaserPorts - a.slot.requiredLaserPorts ||
        b.slot.requiredRadioM - a.slot.requiredRadioM ||
        b.slot.altitudeM - a.slot.altitudeM ||
        a.index - b.index,
    );

  const maxNewBuilds = options.maxNewBuilds ?? Number.POSITIVE_INFINITY;
  let newBuilds = 0;
  for (const { slot, index } of order) {
    const candidates = hulls
      .filter((hull) => hull.source !== 'owner-tagged' || !usedIds.has(hull.id))
      .map((hull) => {
        const cap = capabilities.get(hull.id)!;
        const verdict = evaluate(hull, cap, slot, options);
        const existing = hull.source === 'owner-tagged' && positions[hull.id] !== undefined;
        const moveM = existing ? distance(positions[hull.id]!, slot.position) : null;
        return { hull, cap, verdict, existing, moveM };
      })
      .filter((candidate) => candidate.verdict.ok)
      .sort((a, b) => {
        const keyA = [
          a.verdict.carried ? 1 : 0,
          a.existing ? 0 : 1,
          a.cap.stationOnly ? 1 : 0,
          usedTypes.has(usedTypeKey(a.hull)) ? 0 : 1,
          a.cap.costRank,
          a.moveM ?? 0,
          a.hull.id,
        ];
        const keyB = [
          b.verdict.carried ? 1 : 0,
          b.existing ? 0 : 1,
          b.cap.stationOnly ? 1 : 0,
          usedTypes.has(usedTypeKey(b.hull)) ? 0 : 1,
          b.cap.costRank,
          b.moveM ?? 0,
          b.hull.id,
        ];
        for (let i = 0; i < keyA.length; i += 1) {
          const va = keyA[i]!;
          const vb = keyB[i]!;
          if (typeof va === 'number' && typeof vb === 'number') {
            if (va !== vb) return va - vb;
          } else if (String(va) !== String(vb)) {
            return String(va).localeCompare(String(vb));
          }
        }
        return 0;
      });

    // A new prefab build is capped; an existing ship never counts against it.
    const first = candidates[0];
    const choice = first && (first.hull.source !== 'prefab' || newBuilds < maxNewBuilds) ? first : undefined;

    if (!choice && first) {
      unfilled.push({
        slotId: slot.slotId,
        slotIndex: index,
        altitudeM: slot.altitudeM,
        tier: slot.tier,
        code: 'new_build_cap',
        reason: `a hull fits but the new-build cap (${maxNewBuilds}) is reached`,
        gap: `slot ${slot.slotId} is QUEUED: ${first.hull.name} fits, but launching it would exceed the active cap`,
        hint: 'Raise maxActive, or launch the next wave once a ship is released.',
      });
      continue;
    }

    if (!choice) {
      const best = hulls
        .map((hull) => ({ hull, cap: capabilities.get(hull.id)! }))
        .sort((a, b) => (b.cap.radioRangeM ?? 0) - (a.cap.radioRangeM ?? 0) || a.hull.id.localeCompare(b.hull.id))[0];
      const bestRadio = best?.cap.radioRangeM ?? 0;
      const bestLaser = hulls.reduce((max, hull) => Math.max(max, hull.laserCount), 0);
      const failureCodes = hulls
        .map((hull) => evaluate(hull, capabilities.get(hull.id)!, slot, options).code)
        .filter((code) => code !== 'ok');
      const priority = [
        'laser_los_blocked',
        'laser_range_unknown',
        'laser_range_short',
        'laser_ports_short',
        'tier_ineligible',
        'power_budget',
        'radio_range_short',
        'no_radio',
      ];
      const specific = priority.find((code) => failureCodes.includes(code));
      let code = 'no_hull_fits';
      let gap = '';
      if (slot.requiredRadioM > (bestRadio || 0)) {
        code = 'missing_long_range_radio';
        gap =
          `slot ${slot.slotId} needs a radio link of ${(slot.requiredRadioM / 1000).toFixed(1)} km; ` +
          `the longest antenna available is ${(bestRadio / 1000).toFixed(1)} km (${best?.hull.name ?? 'none'})`;
      } else if (slot.requiredLaserPorts > bestLaser) {
        code = 'missing_laser_ports';
        gap = `slot ${slot.slotId} needs ${slot.requiredLaserPorts} laser port(s); the fleet has at most ${bestLaser}`;
      } else {
        code = specific ?? 'tier_ineligible';
        gap =
          `slot ${slot.slotId} at ${(slot.altitudeM / 1000).toFixed(1)} km (${tierLabel(slot.tier)}) has no eligible hull: ` +
          (specific === 'power_budget'
            ? 'the T30 power budget is short for every candidate'
            : 'every radio-capable hull is out of tier (atmo ceiling 10 km, H2/ion required)');
      }
      unfilled.push({
        slotId: slot.slotId,
        slotIndex: index,
        altitudeM: slot.altitudeM,
        tier: slot.tier,
        code,
        reason: 'no available hull satisfies the hard constraints',
        gap,
        hint:
          code === 'missing_long_range_radio'
            ? 'Build a large-grid antenna hull (50 km measured) or add a relay so the link is shorter.'
            : code === 'missing_laser_ports'
              ? 'Add a laser hub (3+ ports) or split the laser edges across leaves.'
              : 'Add an H2 relay for the high tier, or station an atmo hull after towing it.',
      });
      continue;
    }

    const { hull, cap, verdict, existing, moveM } = choice;
    if (hull.source === 'owner-tagged') usedIds.add(hull.id);
    else newBuilds += 1;
    usedTypes.add(usedTypeKey(hull));
    const stationNote =
      slot.tier === 'zero-g'
        ? 'zero-g: free hold, no station needed'
        : `station hold is free (T18)${hull.isStatic ? '; already static' : ''}`;
    const role =
      slot.requiredLaserPorts > 0
        ? cap.roles.find((candidate) => candidate.startsWith('laser')) ?? cap.roles[0] ?? 'none'
        : cap.roles[0] ?? 'none';
    const why =
      `${hull.name} (${roleSummary(cap)}) -> ${slot.slotId} at ${(slot.altitudeM / 1000).toFixed(1)} km ` +
      `(${tierLabel(slot.tier)}): needs ${(slot.requiredRadioM / 1000).toFixed(1)} km of radio, ` +
      `hull has ${cap.radioRangeM === null ? 'none' : `${(cap.radioRangeM / 1000).toFixed(0)} km`}; ` +
      `${verdict.reason}; ${stationNote}` +
      (cap.flightMode === 'level' ? '; lift-only -> level flight (T25), never face-the-waypoint autopilot' : '') +
      (existing && moveM !== null ? `; reuses an existing ship ${(moveM / 1000).toFixed(1)} km away` : '; new build');
    assignments.push({
      slotId: slot.slotId,
      slotIndex: index,
      altitudeM: slot.altitudeM,
      tier: slot.tier,
      hullId: hull.id,
      hullName: hull.name,
      source: hull.source,
      role,
      flightMode: cap.flightMode,
      reused: hull.source === 'owner-tagged',
      carried: verdict.carried,
      requiredRadioM: Math.round(slot.requiredRadioM),
      radioHeadroomM: cap.radioRangeM === null ? null : Math.round(cap.radioRangeM - slot.requiredRadioM),
      moveM: moveM === null ? null : Math.round(moveM),
      why,
      labels: ['SIMULATED', 'ASSIGNMENT', existing ? 'REUSED' : 'NEW-BUILD', ...(verdict.carried ? ['CARRIED'] : [])],
    });
  }

  assignments.sort((a, b) => a.slotIndex - b.slotIndex);
  unfilled.sort((a, b) => a.slotIndex - b.slotIndex);
  const missingHullTypes: MissingHullType[] = unfilled.map((slot) => ({
    slotId: slot.slotId,
    need:
      slot.tier === 'zero-g'
        ? 'space relay (H2 or ion)'
        : slot.tier === 'atmo'
          ? 'atmo relay (or any hull, stationed)'
          : slot.tier === 'ground'
            ? 'ground relay / rover'
            : 'H2 relay for the in-gravity tier',
    gap: slot.gap,
  }));

  return {
    assignments,
    unfilled,
    missingHullTypes,
    shipCount: assignments.length,
    existingUsed: assignments.filter((assignment) => assignment.reused).length,
    newBuilds: newBuilds,
    hullTypes: [...new Set(assignments.map((assignment) => assignment.hullName))].sort(),
    carriedCount: assignments.filter((assignment) => assignment.carried).length,
    power: options.powerCheck
      ? { checked: true, skipped: false, note: options.powerNote ?? 'T30 power budget applied as a hard constraint' }
      : {
          checked: false,
          skipped: true,
          note:
            options.powerNote ??
            'T30 power module is not available in this build: power budget skipped (the planner does not invent MW numbers)',
        },
    objective: [
      'fill every slot with one ship',
      'prefer an existing ship over a new build',
      'prefer a self-deploying hull over a carrier tow',
      'prefer fewer distinct hull types',
      'then cheaper/smaller hull',
      'then less movement',
    ],
    labels: ['SIMULATED', 'ASSIGNMENT', 'HARD-CONSTRAINTS'],
  };
}

/**
 * Build slot requirements from a planned link graph: the longest incident radio
 * (or laser) edge is what the hull must cover at that slot.
 */
export function requirementsFromLinks(args: {
  nodes: { id: string; position: Vec3; altitudeM: number; role?: string }[];
  links: { a: string; b: string; lengthM: number; kind?: 'radio' | 'laser' }[];
  zeroGAltitudeM: number;
  gravityAt?: (altitudeM: number) => number;
  baseId?: string;
}): SlotRequirement[] {
  const zeroG = args.zeroGAltitudeM;
  return args.nodes.map((node) => {
    let radio = 0;
    let laserPorts = 0;
    let laserLink: number | null = null;
    for (const link of args.links) {
      if (link.a !== node.id && link.b !== node.id) continue;
      if (link.kind === 'laser') {
        laserPorts += 1;
        laserLink = Math.max(laserLink ?? 0, link.lengthM);
      } else {
        radio = Math.max(radio, link.lengthM);
      }
    }
    return {
      slotId: node.id,
      position: node.position,
      altitudeM: node.altitudeM,
      gravityMps2: args.gravityAt ? Math.round(args.gravityAt(node.altitudeM) * 1000) / 1000 : 0,
      tier: tierAtAltitude(node.altitudeM, zeroG),
      requiredRadioM: Math.round(radio * 10) / 10,
      requiredLaserPorts: laserPorts,
      laserLinkM: laserLink === null ? null : Math.round(laserLink * 10) / 10,
      stationAllowed: node.altitudeM >= 100,
      roleHint: node.role,
    };
  });
}

/** Base-01 default altitude, re-exported so the mode builders agree. */
export const DEFAULT_BASE_ALTITUDE_M = BASE_ALTITUDE_M;
