import {
  type ChainPlan,
  type LinkEdge,
  type NodeTemplate,
  type Planet,
} from '@se-rts/schemas';
import { planChain, buildGraph } from '../planner/index.js';
import { getStandIn, hardwareSummary, STANDINS } from './standins.js';

export type HardwareChoice = 'auto' | 'radio' | 'laser' | 'mixed';
export type OptionId = 'radio' | 'laser' | 'mixed';

export type AssumptionStatus = 'UNVERIFIED' | 'SIMULATED';

export interface DemoAssumption {
  id: string;
  text: string;
  status: AssumptionStatus;
}

export interface OptionNode {
  id: string;
  position: { x: number; y: number; z: number };
  kind: 'anchor' | 'relay';
  role: 'station' | 'radio-relay' | 'laser-bridge';
  prefab: string;
  radioRadiusM: number | null;
  laserRangeM: number | null;
  laserPorts: number;
  planet: string | null;
  controlSource: boolean;
}

export interface OptionHop {
  from: string;
  to: string;
  distanceM: number;
  kind: 'radio' | 'laser' | 'none';
  losClear: boolean;
}

export interface DemoConnectOption {
  id: OptionId;
  label: string;
  available: boolean;
  unavailableReason: string | null;
  templateId: string;
  spacingM: number;
  maxGapM: number;
  totalDistanceM: number;
  detour: boolean;
  blockedBy: string[];
  count: number;
  relayCount: number;
  nodes: OptionNode[];
  hops: OptionHop[];
  portUsage: { nodeId: string; used: number; capacity: number; ok: boolean }[];
  portsOk: boolean;
  linksOk: boolean;
  missingLinks: { from: string; to: string; distanceM: number }[];
  cost: { perNodeCredits: number | null; totalCredits: number | null; note: string };
  assumptions: DemoAssumption[];
}

export interface DemoConnectPlan {
  from: string;
  to: string;
  hardware: HardwareChoice;
  preferred: OptionId;
  templates: { radio: string; laser: string; laserSpacingM: number };
  hardwareSummary: ReturnType<typeof hardwareSummary>;
  options: DemoConnectOption[];
  assumptions: DemoAssumption[];
  labels: ('SIMULATED' | 'UNVERIFIED')[];
  planets: { from: Planet; to: Planet };
}

const RADIO_SPACING_M = 45_000; // 0.9 * 50 km
const LASER_MODEL_CAP_M = 100_000;
const LASER_SPACING_M = 90_000; // 0.9 * model cap
const LAST_MILE_RADIO_GAP_M = 9_000; // must fit the bridge's 10 km radio

export const RADIO_TEMPLATE: NodeTemplate = {
  id: 'Eradicator_mk.1',
  radioRadiusM: 50_000,
  laserRangeM: null,
  laserUnlimited: false,
};

export const LASER_CHAIN_TEMPLATE: NodeTemplate = {
  id: 'laser-model-100km',
  radioRadiusM: null,
  laserRangeM: null,
  laserUnlimited: true,
};

function planFor(from: Planet, to: Planet, planets: Planet[], template: NodeTemplate, maxSpacingM: number): ChainPlan {
  return planChain(from, to, template, { planets, maxSpacingM });
}

/** Node capability + spacing derived from an operator-supplied template. */
function radioRadiusOf(template: NodeTemplate): number {
  return template.radioRadiusM ?? STANDINS['Eradicator_mk.1']!.radioRadiusM ?? 50_000;
}

function radioSpacingOf(template: NodeTemplate): number {
  return radioRadiusOf(template) * 0.9;
}

function laserCapOf(template: NodeTemplate): number {
  if (template.laserUnlimited) return template.laserRangeM ?? LASER_MODEL_CAP_M;
  return template.laserRangeM ?? 0;
}

function laserSpacingOf(template: NodeTemplate, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const cap = laserCapOf(template);
  return cap > 0 ? cap * 0.9 : LASER_SPACING_M;
}

function assumptionsFor(id: OptionId): DemoAssumption[] {
  const common: DemoAssumption[] = [
    {
      id: 'planner_math',
      text: 'node positions and links are deterministic planner geometry; they are not read from the game server',
      status: 'SIMULATED',
    },
    {
      id: 'planet_los',
      text: 'planets are blocking spheres at max hill radius + 1,000 m; real terrain is not modelled',
      status: 'UNVERIFIED',
    },
  ];
  if (id === 'radio') {
    return [
      ...common,
      {
        id: 'radio_range',
        text: 'radio radius 50,000 m comes from the Eradicator_mk.1 prefab profile, not from an in-game link test',
        status: 'UNVERIFIED',
      },
      {
        id: 'radio_relay',
        text: 'multi-hop radio relaying is assumed; not yet demonstrated on the test server',
        status: 'UNVERIFIED',
      },
    ];
  }
  if (id === 'laser') {
    return [
      ...common,
      {
        id: 'laser_range',
        text: 'laser range is capped at 100,000 m in this model; the definition says MaxRange -1 (unlimited) and the real cap is unmeasured',
        status: 'UNVERIFIED',
      },
      {
        id: 'laser_moving',
        text: 'laser links are assumed to hold while both grids move; tracking/aiming is unverified',
        status: 'UNVERIFIED',
      },
      {
        id: 'laser_ports',
        text: 'one laser antenna per link end; port counts come from prefab block counts',
        status: 'UNVERIFIED',
      },
    ];
  }
  return [
    ...common,
    {
      id: 'mixed_endpoint',
      text: 'last-mile radio relays sit 9 km from the laser backbone so the bridge 10 km radio can close the link',
      status: 'SIMULATED',
    },
    {
      id: 'laser_range',
      text: 'laser backbone spacing is 90,000 m against a 100,000 m model cap; real cap unmeasured',
      status: 'UNVERIFIED',
    },
    {
      id: 'laser_moving',
      text: 'laser links are assumed to hold while both grids move; tracking/aiming is unverified',
      status: 'UNVERIFIED',
    },
  ];
}

function networkNode(n: OptionNode) {
  return {
    id: n.id,
    position: n.position,
    radioRadiusM: n.radioRadiusM,
    laserRangeM: n.laserRangeM,
    laserUnlimited: false,
    controlSource: n.controlSource,
  };
}

function hopKind(a: OptionNode, b: OptionNode, distanceM: number): 'radio' | 'laser' | 'none' {
  const laserOk = a.laserRangeM !== null && b.laserRangeM !== null && a.laserRangeM >= distanceM && b.laserRangeM >= distanceM;
  if (laserOk) return 'laser';
  const radioOk = a.radioRadiusM !== null && b.radioRadiusM !== null && a.radioRadiusM >= distanceM && b.radioRadiusM >= distanceM;
  if (radioOk) return 'radio';
  return 'none';
}

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function finishOption(input: {
  id: OptionId;
  label: string;
  available: boolean;
  unavailableReason: string | null;
  templateId: string;
  spacingM: number;
  from: Planet;
  to: Planet;
  planets: Planet[];
  nodes: OptionNode[];
  detour: boolean;
  blockedBy: string[];
  totalDistanceM: number;
}): DemoConnectOption {
  const { nodes } = input;
  const hops: OptionHop[] = [];
  for (let i = 0; i + 1 < nodes.length; i += 1) {
    const a = nodes[i]!;
    const b = nodes[i + 1]!;
    const d = distance(a.position, b.position);
    hops.push({ from: a.id, to: b.id, distanceM: d, kind: hopKind(a, b, d), losClear: true });
  }

  const graph = buildGraph(nodes.map(networkNode), input.planets);
  const edgeKeys = new Set(graph.edges.map((e: LinkEdge) => `${e.from}>${e.to}>${e.kind}`));
  const missingLinks = hops
    .filter((h) => {
      if (h.kind === 'none') return true;
      return !edgeKeys.has(`${h.from}>${h.to}>${h.kind}`) || !edgeKeys.has(`${h.to}>${h.from}>${h.kind}`);
    })
    .map((h) => ({ from: h.from, to: h.to, distanceM: h.distanceM }));

  const used: Record<string, number> = {};
  for (const hop of hops) {
    if (hop.kind !== 'laser') continue;
    used[hop.from] = (used[hop.from] ?? 0) + 1;
    used[hop.to] = (used[hop.to] ?? 0) + 1;
  }
  const portUsage = nodes.map((n) => {
    const u = used[n.id] ?? 0;
    return { nodeId: n.id, used: u, capacity: n.laserPorts, ok: u <= n.laserPorts };
  });
  const maxGapM = hops.reduce((m, h) => Math.max(m, h.distanceM), 0);

  return {
    id: input.id,
    label: input.label,
    available: input.available,
    unavailableReason: input.unavailableReason,
    templateId: input.templateId,
    spacingM: input.spacingM,
    maxGapM,
    totalDistanceM: input.totalDistanceM,
    detour: input.detour,
    blockedBy: input.blockedBy,
    count: nodes.length,
    relayCount: Math.max(0, nodes.length - 2),
    nodes,
    hops,
    portUsage,
    portsOk: portUsage.every((p) => p.ok),
    linksOk: missingLinks.length === 0,
    missingLinks,
    cost: {
      perNodeCredits: null,
      totalCredits: null,
      note: 'cost model placeholder: build/launch price is not modelled yet',
    },
    assumptions: assumptionsFor(input.id),
  };
}

function radioOption(from: Planet, to: Planet, planets: Planet[], template: NodeTemplate): DemoConnectOption {
  const plan = planFor(from, to, planets, template, radioSpacingOf(template));
  const relays = STANDINS['Eradicator_mk.1']!;
  const station = STANDINS.EarthEasyStation!;
  const nodes: OptionNode[] = plan.nodes.map((n) => {
    const atFrom = n.planet === from.name;
    const atTo = n.planet === to.name;
    const prefab = atFrom || atTo ? (atFrom ? 'EarthEasyStation' : 'AlienEasyStation') : relays.prefab;
    const cap = getStandIn(prefab) ?? station;
    return {
      id: n.id,
      position: n.position,
      kind: n.kind,
      role: n.kind === 'anchor' ? 'station' : 'radio-relay',
      prefab,
      radioRadiusM: n.kind === 'anchor' ? cap.radioRadiusM : radioRadiusOf(template),
      laserRangeM: n.kind === 'anchor' ? cap.laserRangeM : null,
      laserPorts: n.kind === 'anchor' ? cap.laserPorts : 0,
      planet: n.planet,
      controlSource: atFrom,
    };
  });
  return finishOption({
    id: 'radio',
    label: 'Radio only',
    available: true,
    unavailableReason: null,
    templateId: template.id,
    spacingM: plan.spacingM,
    from,
    to,
    planets,
    nodes,
    detour: plan.detour,
    blockedBy: plan.blockedBy,
    totalDistanceM: plan.totalDistanceM,
  });
}

function laserOption(
  from: Planet,
  to: Planet,
  planets: Planet[],
  template: NodeTemplate,
  spacingOverride?: number,
): DemoConnectOption {
  const cap = laserCapOf(template);
  const hasLaser = cap > 0 && getStandIn('EncounterCitadelStation') !== null;
  const plan = planFor(from, to, planets, template, laserSpacingOf(template, spacingOverride));
  const bridge = STANDINS.EncounterCitadelStation!;
  const nodes: OptionNode[] = plan.nodes.map((n) => {
    const atFrom = n.planet === from.name;
    const atTo = n.planet === to.name;
    const prefab = atFrom ? 'EarthEasyStation' : atTo ? 'AlienEasyStation' : bridge.prefab;
    const stationCap = getStandIn(prefab)!;
    return {
      id: n.id,
      position: n.position,
      kind: n.kind,
      role: n.kind === 'anchor' ? 'station' : 'laser-bridge',
      prefab,
      radioRadiusM: stationCap.radioRadiusM,
      laserRangeM: n.kind === 'anchor' ? stationCap.laserRangeM : cap,
      laserPorts: n.kind === 'anchor' ? stationCap.laserPorts : cap > 0 ? bridge.laserPorts : 0,
      planet: n.planet,
      controlSource: atFrom,
    };
  });
  return finishOption({
    id: 'laser',
    label: 'Laser only',
    available: hasLaser,
    unavailableReason: hasLaser ? null : 'no laser-capable stand-in / laser template available on the test server',
    templateId: template.id,
    spacingM: plan.spacingM,
    from,
    to,
    planets,
    nodes,
    detour: plan.detour,
    blockedBy: plan.blockedBy,
    totalDistanceM: plan.totalDistanceM,
  });
}

/** Radio relays from `a` toward `b` so the final hop fits the bridge radio. */
function lastMileRelays(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  spacingM: number,
  finalGapM: number,
): { x: number; y: number; z: number }[] {
  const d = distance(a, b);
  if (d <= finalGapM) return [];
  const count = Math.max(1, Math.ceil((d - finalGapM) / spacingM));
  const out: { x: number; y: number; z: number }[] = [];
  const span = d - finalGapM;
  for (let i = 1; i <= count; i += 1) {
    const t = (span * i) / count / d;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
  }
  return out;
}

function mixedOption(
  from: Planet,
  to: Planet,
  planets: Planet[],
  laserTemplate: NodeTemplate,
  radioTemplate: NodeTemplate,
  spacingOverride?: number,
): DemoConnectOption {
  const cap = laserCapOf(laserTemplate);
  const hasLaser = cap > 0 && getStandIn('EncounterCitadelStation') !== null;
  const plan = planFor(from, to, planets, laserTemplate, laserSpacingOf(laserTemplate, spacingOverride));
  const positions = plan.nodes.map((n) => n.position);
  const bridge = STANDINS.EncounterCitadelStation!;
  const relay = STANDINS['Eradicator_mk.1']!;
  const station = STANDINS.EarthEasyStation!;
  const radioSpacing = radioSpacingOf(radioTemplate);
  const finalGap = Math.min(LAST_MILE_RADIO_GAP_M, radioRadiusOf(radioTemplate) * 0.9);

  const raw: { position: { x: number; y: number; z: number }; role: OptionNode['role']; prefab: string }[] = [];
  const first = positions[0]!;
  const second = positions[1] ?? first;
  raw.push({ position: first, role: 'station', prefab: 'EarthEasyStation' });
  for (const pos of lastMileRelays(first, second, radioSpacing, finalGap)) {
    raw.push({ position: pos, role: 'radio-relay', prefab: relay.prefab });
  }
  for (let i = 1; i < positions.length - 1; i += 1) {
    raw.push({ position: positions[i]!, role: 'laser-bridge', prefab: bridge.prefab });
  }
  const last = positions[positions.length - 1]!;
  const penultimate = positions[positions.length - 2] ?? last;
  for (const pos of lastMileRelays(last, penultimate, radioSpacing, finalGap).reverse()) {
    raw.push({ position: pos, role: 'radio-relay', prefab: relay.prefab });
  }
  raw.push({ position: last, role: 'station', prefab: 'AlienEasyStation' });

  const nodes: OptionNode[] = raw.map((r, index) => {
    const capStandIn = getStandIn(r.prefab) ?? station;
    const atFrom = index === 0;
    const atTo = index === raw.length - 1;
    const isRadioRelay = r.role === 'radio-relay';
    return {
      id: `node-${index}`,
      position: r.position,
      kind: atFrom || atTo ? 'anchor' : 'relay',
      role: r.role,
      prefab: r.prefab,
      radioRadiusM: isRadioRelay ? radioRadiusOf(radioTemplate) : capStandIn.radioRadiusM,
      laserRangeM: r.role === 'laser-bridge' ? cap : capStandIn.laserRangeM,
      laserPorts: isRadioRelay ? 0 : r.role === 'laser-bridge' ? (cap > 0 ? bridge.laserPorts : 0) : capStandIn.laserPorts,
      planet: atFrom ? from.name : atTo ? to.name : null,
      controlSource: atFrom,
    };
  });

  return finishOption({
    id: 'mixed',
    label: 'Mixed (laser backbone + radio last mile)',
    available: hasLaser,
    unavailableReason: hasLaser ? null : 'mixed needs a laser-capable stand-in and radio relays; the laser bridge is missing',
    templateId: `${radioTemplate.id}+${laserTemplate.id}`,
    spacingM: plan.spacingM,
    from,
    to,
    planets,
    nodes,
    detour: plan.detour,
    blockedBy: plan.blockedBy,
    totalDistanceM: plan.totalDistanceM,
  });
}

export function buildConnectPlan(input: {
  from: Planet;
  to: Planet;
  planets: Planet[];
  hardware: HardwareChoice;
  templates?: { radio?: NodeTemplate; laser?: NodeTemplate; laserSpacingM?: number };
}): DemoConnectPlan {
  const radioTemplate = input.templates?.radio ?? RADIO_TEMPLATE;
  const laserTemplate = input.templates?.laser ?? LASER_CHAIN_TEMPLATE;
  const laserSpacingM = input.templates?.laserSpacingM;
  const options = [
    radioOption(input.from, input.to, input.planets, radioTemplate),
    laserOption(input.from, input.to, input.planets, laserTemplate, laserSpacingM),
    mixedOption(input.from, input.to, input.planets, laserTemplate, radioTemplate, laserSpacingM),
  ];
  const preferred: OptionId =
    input.hardware === 'auto' ? (options[1]!.available ? 'laser' : 'radio') : (input.hardware as OptionId);
  return {
    from: input.from.name,
    to: input.to.name,
    hardware: input.hardware,
    preferred,
    templates: {
      radio: radioTemplate.id,
      laser: laserTemplate.id,
      laserSpacingM: laserSpacingOf(laserTemplate, laserSpacingM),
    },
    hardwareSummary: hardwareSummary(),
    options,
    assumptions: [
      {
        id: 'comms_gate',
        text: 'command authority is planner reachability when the plugin has not reported link state',
        status: 'SIMULATED',
      },
      {
        id: 'execution',
        text: 'nothing is spawned or flown by this plan; approving only creates missions in the queue',
        status: 'SIMULATED',
      },
    ],
    labels: ['SIMULATED', 'UNVERIFIED'],
    planets: { from: input.from, to: input.to },
  };
}

export function optionById(plan: DemoConnectPlan, id: OptionId): DemoConnectOption {
  const option = plan.options.find((o) => o.id === id);
  if (!option) throw new Error(`unknown plan option ${id}`);
  if (!option.available) throw new Error(`plan option ${id} is not available: ${option.unavailableReason}`);
  return option;
}

export { RADIO_SPACING_M, LASER_MODEL_CAP_M, LASER_SPACING_M, LAST_MILE_RADIO_GAP_M };
