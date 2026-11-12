import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import sax from 'sax';
import type { Vec3 } from '@se-rts/schemas';

/**
 * READ-ONLY handoff detector. It parses a *copy* of the synced save and looks
 * for programmable blocks tagged `[HERMES-TEST]` (name) or `HERMES_TEST=READY`
 * (CustomData). It never modifies the save and never talks to a game server.
 */

export type HandoffGoal = 'hover' | 'orbit' | 'interplanetary' | 'crash';
export const HANDOFF_GOALS: HandoffGoal[] = ['hover', 'orbit', 'interplanetary', 'crash'];

export interface IdentityInfo {
  id: string;
  name: string;
  steamId?: string;
}

export interface SafetyPrecheck {
  blocks: number;
  programmableBlocks: number;
  hasPower: boolean;
  hasThrusters: boolean;
  hasGyro: boolean;
  hasControl: boolean;
  hasAntenna: boolean;
}

export interface HandoffCandidate {
  schemaVersion: 1;
  gridId: string;
  gridName: string;
  ownerIdentityId: string | null;
  ownerName: string | null;
  ownerIsYou: boolean;
  goal: HandoffGoal;
  pbCustomName: string;
  pbCustomData: string;
  ready: boolean;
  missing: string[];
  precheck: SafetyPrecheck;
  position: Vec3 | null;
  scannedAt: number;
}

export interface ScanReport {
  sbsPath: string;
  sbcPath: string;
  scannedAt: number;
  gridsScanned: number;
  gridsWithProgrammableBlocks: number;
  programmableBlocks: number;
  taggedGrids: number;
  candidates: HandoffCandidate[];
  error?: string;
}

interface BlockScan {
  type: string;
  customName: string;
  customData: string;
  owner: string;
}

interface GridScan {
  id: string;
  name: string;
  isStatic: boolean;
  pos: Vec3 | null;
  blocks: number;
  owners: Map<string, number>;
  blockTypes: Set<string>;
  programmableBlocks: BlockScan[];
}

const BLOCK_TAGS = new Set(['MyObjectBuilder_CubeBlock', 'MyObjectBuilder_CubeGrid']);

function cleanName(value: string): string {
  return [...(value ?? '')]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return !(code >= 0xe000 && code <= 0xf8ff) && ch !== '\u200b' && ch !== '\ufeff';
    })
    .join('')
    .trim();
}

function parseGoal(customData: string): HandoffGoal {
  const match = /HERMES_GOAL\s*=\s*(hover|orbit|interplanetary|crash)/i.exec(customData);
  const value = match?.[1]?.toLowerCase();
  return (HANDOFF_GOALS as string[]).includes(value ?? '') ? (value as HandoffGoal) : 'hover';
}

function tagged(customName: string, customData: string): boolean {
  return customName.includes('[HERMES-TEST]') || /HERMES_TEST\s*=\s*READY/i.test(customData);
}

function xsiType(type: string | undefined): string {
  return (type ?? '').replace(/^MyObjectBuilder_/, '');
}

function isGridOpen(name: string, type: string | undefined): boolean {
  if (name === 'MyObjectBuilder_CubeGrid') return true;
  return name === 'MyObjectBuilder_EntityBase' && Boolean(type?.endsWith('MyObjectBuilder_CubeGrid'));
}

function blockKind(name: string, type: string | undefined): string {
  if (type) return xsiType(type);
  return xsiType(name);
}

function vecFrom(attrs: Record<string, string>): Vec3 | null {
  if (attrs.x === undefined || attrs.y === undefined || attrs.z === undefined) return null;
  const x = Number(attrs.x);
  const y = Number(attrs.y);
  const z = Number(attrs.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

interface ParserHandlers {
  onIdentity?: (id: string, name: string, steamId?: string) => void;
  onPlayer?: (identityId: string | null, steamId: string | null) => void;
}


/** Feeds a Node stream into a sax parser without buffering the whole file. */
function feedParser(
  stream: NodeJS.ReadableStream,
  parser: { write: (chunk: string) => unknown; close: () => unknown },
  reject: (err: Error) => void,
): void {
  const decoder = new StringDecoder('utf8');
  stream.on('data', (chunk: Buffer | string) => {
    parser.write(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  });
  stream.on('end', () => {
    parser.write(decoder.end());
    parser.close();
  });
  stream.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
}

/** Streams Sandbox.sbc identities/players (small file, still streamed). */
export function parseSbcStream(
  stream: NodeJS.ReadableStream,
  handlers: ParserHandlers,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parser = sax.parser(true, { trim: true, normalize: false });
    let depth = 0;
    let identityDepth = 0;
    let playerDepth = 0;
    let id = '';
    let name = '';
    let steamId = '';
    let identityId: string | null = null;
    let field: string | null = null;

    parser.onopentag = (node) => {
      depth += 1;
      const tag = node.name;
      if (tag === 'MyObjectBuilder_Identity') {
        identityDepth = depth;
        id = '';
        name = '';
      } else if (tag === 'MyObjectBuilder_Player') {
        playerDepth = depth;
        steamId = '';
        identityId = null;
      } else if (identityDepth && depth === identityDepth + 1) {
        field = tag;
      } else if (playerDepth && depth === playerDepth + 1) {
        field = tag;
      } else {
        field = null;
      }
    };
    parser.ontext = (text) => {
      if (!field) return;
      if (identityDepth && depth === identityDepth + 1) {
        if (field === 'IdentityId') id += text;
        else if (field === 'DisplayName') name += text;
      } else if (playerDepth && depth === playerDepth + 1) {
        if (field === 'SteamId') steamId += text;
        else if (field === 'IdentityId' || field === 'PlayerIdentityId') identityId = text.trim();
      }
    };
    parser.onclosetag = () => {
      if (identityDepth && depth === identityDepth) {
        handlers.onIdentity?.(id.trim(), cleanName(name) , undefined);
        identityDepth = 0;
      } else if (playerDepth && depth === playerDepth) {
        handlers.onPlayer?.(identityId, steamId.trim() || null);
        playerDepth = 0;
      } else if (depth === identityDepth + 1 || depth === playerDepth + 1) {
        field = null;
      }
      depth -= 1;
    };
    parser.onerror = (err) => {
      reject(err);
      parser.resume();
    };
    parser.onend = () => resolve();
    feedParser(stream, parser, reject);
  });
}

/** Streams the sector file, returning every grid that carries a tagged PB. */
export function parseSectorStream(
  stream: NodeJS.ReadableStream,
  opts: { identities: Map<string, IdentityInfo>; owner: { steamId: string; identityNames: string[] }; now: number },
): Promise<{ grids: number; gridsWithPb: number; pbs: number; candidates: HandoffCandidate[] }> {
  return new Promise((resolve, reject) => {
    const parser = sax.parser(true, { trim: true, normalize: false });
    let grid: GridScan | null = null;
    let gridDepth = 0;
    let block: BlockScan | null = null;
    let blockDepth = 0;
    let capture: { field: string; depth: number; parts: string[] } | null = null;
    let grids = 0;
    let gridsWithPb = 0;
    let pbs = 0;
    const candidates: HandoffCandidate[] = [];
    const ownerNames = new Set(opts.owner.identityNames.map((n) => cleanName(n).toLowerCase()));

    const assign = (target: GridScan | BlockScan, field: string, text: string) => {
      const value = text.trim();
      if (target === grid) {
        if (field === 'EntityId') grid.id = value;
        else if (field === 'DisplayName' || field === 'Name') grid.name = value;
        else if (field === 'IsStatic') grid.isStatic = value.toLowerCase() === 'true';
      } else if (block) {
        if (field === 'CustomName') block.customName = value;
        else if (field === 'CustomData') block.customData = value;
        else if (field === 'Owner' || field === 'BuiltBy') block.owner = value;
      }
    };

    const finishBlock = () => {
      if (!grid || !block) return;
      grid.blocks += 1;
      grid.blockTypes.add(block.type);
      if (block.owner && block.owner !== '0') {
        grid.owners.set(block.owner, (grid.owners.get(block.owner) ?? 0) + 1);
      }
      if (block.type === 'ProgrammableBlock' || block.type.endsWith('ProgrammableBlock')) {
        grid.programmableBlocks.push(block);
        pbs += 1;
      }
      block = null;
    };

    const finishGrid = () => {
      if (!grid) return;
      grids += 1;
      if (grid.programmableBlocks.length) gridsWithPb += 1;

      const taggedPbs = grid.programmableBlocks.filter((pb) => tagged(pb.customName, pb.customData));
      if (taggedPbs.length) {
        const pb = taggedPbs[0]!;
        const ownerId = [...grid.owners.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        const identity = ownerId ? opts.identities.get(ownerId) : undefined;
        const ownerName = identity?.name ?? null;
        const ownerIsYou =
          Boolean(identity?.steamId && identity.steamId === opts.owner.steamId) ||
          (ownerName !== null && ownerNames.has(cleanName(ownerName).toLowerCase()));

        const precheck: SafetyPrecheck = {
          blocks: grid.blocks,
          programmableBlocks: grid.programmableBlocks.length,
          hasPower: ['Reactor', 'BatteryBlock', 'SolarPanel', 'HydrogenEngine'].some((t) => grid!.blockTypes.has(t)),
          hasThrusters: grid.blockTypes.has('Thrust'),
          hasGyro: grid.blockTypes.has('Gyro'),
          hasControl: ['RemoteControl', 'Cockpit'].some((t) => grid!.blockTypes.has(t)),
          hasAntenna: ['RadioAntenna', 'LaserAntenna'].some((t) => grid!.blockTypes.has(t)),
        };
        const missing: string[] = [];
        if (!precheck.hasPower) missing.push('power source');
        if (!precheck.hasThrusters) missing.push('thrusters');
        if (!precheck.hasGyro) missing.push('gyro');
        if (!precheck.hasControl) missing.push('remote control or cockpit');
        if (!precheck.hasAntenna) missing.push('antenna');
        if (!ownerIsYou) missing.push('owner is not the owner');

        candidates.push({
          schemaVersion: 1,
          gridId: grid.id,
          gridName: cleanName(grid.name) || grid.id,
          ownerIdentityId: ownerId,
          ownerName,
          ownerIsYou,
          goal: parseGoal(pb.customData),
          pbCustomName: pb.customName,
          pbCustomData: pb.customData,
          ready: missing.length === 0,
          missing,
          precheck,
          position: grid.pos,
          scannedAt: opts.now,
        });
      }
      grid = null;
    };

    const stack: string[] = [];
    let gridTag = '';
    let gridTagDepth = 0;

    parser.onopentag = (node) => {
      stack.push(node.name);
      const depth = stack.length;
      const name = node.name;
      const parent = stack[depth - 2];
      const attrs = node.attributes as Record<string, string>;
      const type = attrs['xsi:type'];

      if (isGridOpen(name, type)) {
        grid = {
          id: '',
          name: '',
          isStatic: false,
          pos: null,
          blocks: 0,
          owners: new Map(),
          blockTypes: new Set(),
          programmableBlocks: [],
        };
        gridDepth = depth;
        gridTag = name;
        gridTagDepth = depth;
        return;
      }
      if (!grid) return;

      if (parent === gridTag && depth === gridTagDepth + 1) {
        if (['EntityId', 'DisplayName', 'Name', 'IsStatic'].includes(name)) {
          capture = { field: name, depth, parts: [] };
        }
        return;
      }

      if (name === 'Position' && parent === 'PositionAndOrientation') {
        grid.pos = vecFrom(attrs);
        return;
      }

      if (parent === 'CubeBlocks' && !block) {
        block = { type: blockKind(name, type), customName: '', customData: '', owner: '' };
        blockDepth = depth;
        return;
      }

      if (block && depth === blockDepth + 1) {
        if (['CustomName', 'CustomData', 'Owner', 'BuiltBy', 'SubtypeName', 'Enabled'].includes(name)) {
          capture = { field: name, depth, parts: [] };
        }
      }
    };

    parser.ontext = (text) => {
      if (capture && stack.length === capture.depth) capture.parts.push(text);
    };

    parser.oncdata = (text) => {
      if (capture && stack.length === capture.depth) capture.parts.push(text);
    };

    parser.onclosetag = () => {
      const depth = stack.length;
      if (capture && depth === capture.depth) {
        if (block) assign(block, capture.field, capture.parts.join(''));
        else if (grid) assign(grid, capture.field, capture.parts.join(''));
        capture = null;
      }
      if (block && depth === blockDepth) finishBlock();
      if (grid && depth === gridDepth) finishGrid();
      stack.pop();
    };

    parser.onerror = (err) => {
      reject(err);
      parser.resume();
    };
    parser.onend = () => resolve({ grids, gridsWithPb, pbs, candidates });
    feedParser(stream, parser, reject);
  });
}

export function loadIdentities(sbcPath: string): Promise<Map<string, IdentityInfo>> {
  const identities = new Map<string, IdentityInfo>();
  const players: { identityId: string | null; steamId: string | null }[] = [];
  if (!fs.existsSync(sbcPath)) return Promise.resolve(identities);
  const stream = fs.createReadStream(sbcPath);
  return parseSbcStream(stream, {
    onIdentity: (id, name) => {
      if (id) identities.set(id, { id, name });
    },
    onPlayer: (identityId, steamId) => {
      players.push({ identityId, steamId });
      if (!identityId || !steamId) return;
      const existing = identities.get(identityId);
      if (existing) existing.steamId = steamId;
      else identities.set(identityId, { id: identityId, name: identityId, steamId });
    },
  }).then(() => identities);
}

export async function scanSave(opts: {
  sbsPath: string;
  sbcPath: string;
  owner: { steamId: string; identityNames: string[] };
  now?: number;
}): Promise<ScanReport> {
  const now = opts.now ?? Date.now();
  const report: ScanReport = {
    sbsPath: opts.sbsPath,
    sbcPath: opts.sbcPath,
    scannedAt: now,
    gridsScanned: 0,
    gridsWithProgrammableBlocks: 0,
    programmableBlocks: 0,
    taggedGrids: 0,
    candidates: [],
  };
  if (!fs.existsSync(opts.sbsPath)) {
    report.error = `save file not found: ${opts.sbsPath}`;
    return report;
  }
  try {
    const identities = await loadIdentities(opts.sbcPath);
    const result = await parseSectorStream(fs.createReadStream(opts.sbsPath), {
      identities,
      owner: opts.owner,
      now,
    });
    report.gridsScanned = result.grids;
    report.gridsWithProgrammableBlocks = result.gridsWithPb;
    report.programmableBlocks = result.pbs;
    report.taggedGrids = result.candidates.length;
    report.candidates = result.candidates;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  }
  return report;
}

export class DetectorService {
  private report: ScanReport | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<ScanReport> | null = null;

  constructor(
    private readonly opts: {
      sbsPath: string;
      sbcPath: string;
      owner: { steamId: string; identityNames: string[] };
      clock?: () => number;
    },
  ) {}

  async refresh(): Promise<ScanReport> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = scanSave({
      sbsPath: this.opts.sbsPath,
      sbcPath: this.opts.sbcPath,
      owner: this.opts.owner,
      now: this.opts.clock?.() ?? Date.now(),
    }).finally(() => {
      this.inFlight = null;
    });
    this.report = await this.inFlight;
    return this.report;
  }

  getReport(): ScanReport | null {
    return this.report;
  }

  candidates(): HandoffCandidate[] {
    return this.report?.candidates ?? [];
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
