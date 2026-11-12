import { describe, expect, it } from 'vitest';
import { LaserLinker, isZeroVec, type LaserCallResult } from '../src/demo/laser.js';

interface FakeOptions {
  /** Round (1-based) in which both ends flip to Connected. 99 = never. */
  connectOnRound?: number;
  /** Start block A in a stale Connecting state with targetCoords 0. */
  staleConnecting?: boolean;
}

const POS = {
  a: { x: 1_000, y: 2_000, z: 3_000 },
  b: { x: 5_000, y: 7_000, z: 9_000 },
};

function fakeHub(opts: FakeOptions = {}) {
  const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  const enabled = new Set<string>();
  const targets = new Map<string, { x: number; y: number; z: number }>();
  const connectedTo = new Map<string, string>();
  let connects = 0;
  let disconnectedA = false;
  let t = 0;

  const status = (id: 'a' | 'b'): string => {
    if (id === 'a' && opts.staleConnecting && !disconnectedA) return 'Connecting';
    if (!enabled.has(id)) return 'Off';
    if (connectedTo.has(id)) return 'Connected';
    if (!targets.has(id)) return 'Idle';
    return 'RotatingToTarget';
  };

  const call = async (action: string, params: Record<string, unknown>): Promise<LaserCallResult> => {
    calls.push({ action, params });
    const gridId = String(params.entityId ?? '');
    const end: 'a' | 'b' | null =
      gridId === 'grid:A' ? 'a' : gridId === 'grid:B' ? 'b' : null;
    switch (action) {
      case 'laser_state':
        return {
          ok: true,
          result: {
            grids: [
              {
                gridId: 'grid:A',
                name: 'SAT-A',
                lasers: [
                  {
                    entityId: 'a1',
                    name: 'SAT-A L1',
                    position: POS.a,
                    status: status('a'),
                    targetCoords: targets.get('a') ?? { x: 0, y: 0, z: 0 },
                    enabled: enabled.has('a'),
                    otherGridId: connectedTo.get('a') ?? null,
                  },
                ],
              },
              {
                gridId: 'grid:B',
                name: 'SAT-B',
                lasers: [
                  {
                    entityId: 'b1',
                    name: 'SAT-B L1',
                    position: POS.b,
                    status: status('b'),
                    targetCoords: targets.get('b') ?? { x: 0, y: 0, z: 0 },
                    enabled: enabled.has('b'),
                    otherGridId: connectedTo.get('b') ?? null,
                  },
                ],
              },
            ],
          },
        };
      case 'set_block_props':
        if (end) enabled.add(end);
        return { ok: true, result: { blocks: [{}] } };
      case 'laser_target': {
        if (end) targets.set(end, { x: Number(params.x), y: Number(params.y), z: Number(params.z) });
        return { ok: true, result: { status: 'RotatingToTarget' } };
      }
      case 'laser_connect': {
        if (end) {
          connects += 1;
          const round = Math.ceil(connects / 2);
          const need = opts.connectOnRound ?? 1;
          if (round >= need) {
            connectedTo.set('a', 'grid:B');
            connectedTo.set('b', 'grid:A');
          }
        }
        return { ok: true, result: { status: 'Connecting' } };
      }
      case 'laser_disconnect':
        if (end) {
          connectedTo.delete(end);
          targets.delete(end);
          if (end === 'a') disconnectedA = true;
        }
        return { ok: true, result: { status: 'Idle' } };
      default:
        return { ok: false, error: `unexpected ${action}` };
    }
  };

  return {
    call,
    calls,
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('LaserLinker.connect', () => {
  it('runs OnOff -> target partner BLOCK -> connect and reports Connected', async () => {
    const hub = fakeHub();
    const result = await new LaserLinker({ call: hub.call, now: hub.now, sleep: hub.sleep, pollMs: 10 }).connect({
      a: { gridId: 'grid:A', laserBlockId: 'a1' },
      b: { gridId: 'grid:B', laserBlockId: 'b1' },
      timeoutMs: 200,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.finalStatus).toEqual({ a: 'Connected', b: 'Connected' });
    expect(result.connectedTo).toEqual({ a: 'grid:B', b: 'grid:A' });

    // Every laser is switched on before it is aimed.
    const actions = hub.calls.map((c) => c.action);
    const firstEnable = actions.indexOf('set_block_props');
    const firstAim = actions.indexOf('laser_target');
    const firstConnect = actions.indexOf('laser_connect');
    expect(firstEnable).toBeGreaterThan(-1);
    expect(firstEnable).toBeLessThan(firstAim);
    expect(firstAim).toBeLessThan(firstConnect);

    // Targets are the partner's LASER BLOCK coords, not grid centres.
    const aims = hub.calls.filter((c) => c.action === 'laser_target');
    expect(aims).toHaveLength(2);
    expect(aims[0]!.params).toMatchObject({ entityId: 'grid:A', x: POS.b.x, y: POS.b.y, z: POS.b.z });
    expect(aims[1]!.params).toMatchObject({ entityId: 'grid:B', x: POS.a.x, y: POS.a.y, z: POS.a.z });
    expect(result.target).toEqual({ a: POS.b, b: POS.a });
  });

  it('retries once and succeeds on the second sequence', async () => {
    const hub = fakeHub({ connectOnRound: 2 });
    const result = await new LaserLinker({ call: hub.call, now: hub.now, sleep: hub.sleep, pollMs: 10 }).connect({
      a: { gridId: 'grid:A', laserBlockId: 'a1' },
      b: { gridId: 'grid:B', laserBlockId: 'b1' },
      timeoutMs: 200,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.attemptsDetail).toHaveLength(2);
    expect(result.attemptsDetail[0]!.connected).toBe(false);
    expect(result.attemptsDetail[1]!.connected).toBe(true);
    // Two full sequences: enable x2 ends, aim x2 ends, connect x2 ends.
    expect(hub.calls.filter((c) => c.action === 'laser_connect')).toHaveLength(4);
  });

  it('gives up after one retry with the exact status per end', async () => {
    const hub = fakeHub({ connectOnRound: 99 });
    const result = await new LaserLinker({ call: hub.call, now: hub.now, sleep: hub.sleep, pollMs: 10 }).connect({
      a: { gridId: 'grid:A', laserBlockId: 'a1' },
      b: { gridId: 'grid:B', laserBlockId: 'b1' },
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.status).toEqual({ a: 'RotatingToTarget', b: 'RotatingToTarget' });
    expect(result.error).toContain('a=RotatingToTarget');
    expect(result.error).toContain('b=RotatingToTarget');
    expect(result.error).toContain('2 attempt');
  });

  it('clears a stale Connecting row whose targetCoords are zero first', async () => {
    const hub = fakeHub({ staleConnecting: true });
    const result = await new LaserLinker({ call: hub.call, now: hub.now, sleep: hub.sleep, pollMs: 10 }).connect({
      a: { gridId: 'grid:A', laserBlockId: 'a1' },
      b: { gridId: 'grid:B', laserBlockId: 'b1' },
      timeoutMs: 200,
    });
    expect(result.clearedStale.a).toBe(true);
    expect(hub.calls[1]).toMatchObject({ action: 'laser_disconnect', params: { laserBlockId: 'a1' } });
    expect(result.ok).toBe(true);
  });

  it('keeps the beam up by default and disconnects when asked', async () => {
    const keepHub = fakeHub();
    await new LaserLinker({ call: keepHub.call, now: keepHub.now, sleep: keepHub.sleep, pollMs: 10 }).connect({
      a: { gridId: 'grid:A', laserBlockId: 'a1' },
      b: { gridId: 'grid:B', laserBlockId: 'b1' },
      timeoutMs: 100,
    });
    expect(keepHub.calls.some((c) => c.action === 'laser_disconnect')).toBe(false);

    const cleanHub = fakeHub();
    const cleaned = await new LaserLinker({ call: cleanHub.call, now: cleanHub.now, sleep: cleanHub.sleep, pollMs: 10 }).connect({
      a: { gridId: 'grid:A', laserBlockId: 'a1' },
      b: { gridId: 'grid:B', laserBlockId: 'b1' },
      timeoutMs: 100,
      keepConnected: false,
    });
    expect(cleaned.disconnect).toEqual({ a: true, b: true });
    expect(cleanHub.calls.filter((c) => c.action === 'laser_disconnect')).toHaveLength(2);
  });

  it('reports a missing laser block without sending a beam order', async () => {
    const hub = fakeHub();
    const result = await new LaserLinker({ call: hub.call, now: hub.now, sleep: hub.sleep, pollMs: 10 }).connect({
      a: { gridId: 'grid:A', laserBlockId: 'nope' },
      b: { gridId: 'grid:B', laserBlockId: 'b1' },
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no laser antenna');
    expect(hub.calls.some((c) => c.action === 'laser_connect')).toBe(false);
  });
});

describe('isZeroVec', () => {
  it('treats a missing target as zero', () => {
    expect(isZeroVec(null)).toBe(true);
    expect(isZeroVec({ x: 0, y: 0, z: 0.2 })).toBe(true);
    expect(isZeroVec({ x: 0, y: 15, z: 0 })).toBe(false);
  });
});
