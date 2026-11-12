import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ShipRoleRegistry,
  actionIntent,
  mostRestrictive,
  orderDecision,
  parseRoleText,
  resolveRole,
  shipRoles,
  type RoleHint,
} from '../src/demo/roles.js';
import { personalShipLimits, PASSENGER_SPEED_CAP_MPS } from '../src/demo/passengers.js';
import { roleRefusalForMission, type DemoDeps } from '../src/demo/routes.js';
import { Store } from '../src/store.js';
import { openDb } from '../src/db.js';

const hint = (role: RoleHint['role'], source: RoleHint['source'] = 'block-name', token = `[${role}]`): RoleHint => ({
  role,
  source,
  token,
  block: 'PB',
});

function store(): Store {
  return new Store(openDb(':memory:', { memory: true }), () => 1_000);
}

beforeEach(() => shipRoles.reset());

describe('ship role tags: every spelling the owner asked for', () => {
  it('reads the full tag and the short alias from a block name', () => {
    expect(parseRoleText('[HERMES-PERSONAL] owner tug').map((m) => m.role)).toEqual(['personal']);
    expect(parseRoleText('Tug [PERSONAL]').map((m) => m.role)).toEqual(['personal']);
    expect(parseRoleText('[BASE]').map((m) => m.role)).toEqual(['base']);
    expect(parseRoleText('[OFF]').map((m) => m.role)).toEqual(['off']);
    expect(parseRoleText('[HERMES-TEST]').map((m) => m.role)).toEqual(['managed']);
  });

  it('is case-insensitive', () => {
    expect(parseRoleText('[personal]').map((m) => m.role)).toEqual(['personal']);
    expect(parseRoleText('hermes_base').length).toBe(0);
  });

  it('reads HERMES_ROLE=... from a CustomData body', () => {
    const hits = parseRoleText('timer\nHERMES_ROLE=base\npiston');
    expect(hits).toEqual([{ role: 'base', token: 'HERMES_ROLE=base' }]);
  });

  it('ignores an unknown HERMES_ROLE value', () => {
    expect(parseRoleText('HERMES_ROLE=pirate')).toEqual([]);
  });

  it('does not let a full tag trigger its short alias', () => {
    expect(parseRoleText('[HERMES-BASE]')).toHaveLength(1);
    expect(parseRoleText('[HERMES-OFF]')).toHaveLength(1);
  });
});

describe('role resolution: in-game tag wins, conflicts are restrictive', () => {
  it('uses the in-game tag over the site toggle and explains the source', () => {
    const res = resolveRole({ hints: [hint('personal')], site: 'managed', siteBy: 'vex' });
    expect(res.role).toBe('personal');
    expect(res.roleSource).toBe('in-game-tag');
    expect(res.reason).toContain('set in game');
  });

  it('uses the site toggle only when no tag exists', () => {
    const res = resolveRole({ hints: [], site: 'off', siteBy: 'vex' });
    expect(res.role).toBe('off');
    expect(res.roleSource).toBe('site-toggle');
  });

  it('defaults to managed (existing behaviour) when untagged and untoggled', () => {
    const res = resolveRole({ hints: [] });
    expect(res.role).toBe('managed');
    expect(res.roleSource).toBe('default');
  });

  it('resolves OFF > PERSONAL > BASE > MANAGED and marks the conflict between non-default tags', () => {
    const res = resolveRole({ hints: [hint('managed'), hint('base'), hint('personal'), hint('off')] });
    expect(res.role).toBe('off');
    expect(res.conflict).toBe(true);
    // MANAGED is the default role: it never takes part in a conflict.
    expect(res.conflictRoles).toEqual(['off', 'personal', 'base']);
    expect(res.reason).toContain('most restrictive');
  });

  it('a default managed tag never conflicts with an explicit PERSONAL tag (test #2 finding)', () => {
    // `[HERMES-TEST]` on the PB plus `[PERSONAL]` on another block: the grid is
    // the owner's personal ship, and that is not an ambiguity.
    const res = resolveRole({
      hints: [
        { role: 'managed', source: 'block-name', token: '[HERMES-TEST]', block: 'Programmable Block' },
        { role: 'personal', source: 'block-name', token: '[PERSONAL]', block: 'Battery 4' },
      ],
    });
    expect(res.role).toBe('personal');
    expect(res.conflict).toBe(false);
    expect(res.conflictRoles).toEqual([]);
    expect(res.reason).not.toContain('conflicting');
    // Two explicit non-default tags still conflict.
    const two = resolveRole({ hints: [hint('personal'), hint('base')] });
    expect(two.conflict).toBe(true);
    expect(two.conflictRoles).toEqual(['personal', 'base']);
  });

  it('mostRestrictive picks the strictest single role', () => {
    expect(mostRestrictive([{ role: 'managed' }, { role: 'base' }])).toBe('base');
    expect(mostRestrictive([])).toBeNull();
  });

  it('the registry raises one alert per conflicting grid, not per poll', () => {
    const s = store();
    const rows = [{ gridId: 'grid:1', name: 'Tug', hints: [hint('personal'), hint('base')] }];
    shipRoles.noteInGame(s, rows, 10);
    shipRoles.noteInGame(s, rows, 20);
    const alerts = s.listAlerts().filter((a) => a.kind === 'role_conflict');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toContain('PERSONAL vs BASE');
  });

  it('a site toggle cannot override an in-game tag, and the refusal is audited', () => {
    const s = store();
    shipRoles.noteInGame(s, [{ gridId: 'grid:2', name: 'Mine', hints: [hint('personal')] }], 10);
    const out = shipRoles.setSiteRole(s, 'grid:2', 'managed', 'vex', 20);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('role_set_in_game');
    expect(shipRoles.roleOf('grid:2')).toBe('personal');
  });

  it('a site toggle is stored server-side and audited', () => {
    const s = store();
    shipRoles.noteInGame(s, [{ gridId: 'grid:3', name: 'Tug', hints: [] }], 10);
    const out = shipRoles.setSiteRole(s, 'grid:3', 'personal', 'vex', 20);
    expect(out.ok).toBe(true);
    expect(shipRoles.resolution('grid:3').roleSource).toBe('site-toggle');
    expect(s.getKv('roles:site')).toContain('grid:3');
    const row = s.listAudit(50).find((a) => a.action === 'role_set');
    expect(row?.detail.applied).toBe('personal');
  });
});

describe('order decisions per role', () => {
  const res = (role: string) => resolveRole({ hints: [hint(role as never)] });

  it('MANAGED allows everything, including automatic features', () => {
    expect(orderDecision(res('managed'), 'automatic', { action: 'set_block_props' }).allowed).toBe(true);
  });

  it('PERSONAL refuses every automatic action and says why', () => {
    const d = orderDecision(res('personal'), 'automatic', { action: 'set_block_props' });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('role_personal');
    expect(d.reason).toContain('personal ship: no automatic action');
  });

  it('PERSONAL flight orders need confirmPersonal and then pass', () => {
    expect(orderDecision(res('personal'), 'owner-order', { action: 'move' }).code).toBe('personal_confirmation_required');
    expect(orderDecision(res('personal'), 'owner-order', { action: 'move', confirmPersonal: true }).allowed).toBe(true);
    expect(orderDecision(res('personal'), 'owner-order', { action: 'land_at', confirmPersonal: true }).allowed).toBe(true);
  });

  it('PERSONAL refuses a non-flight action even when confirmed', () => {
    const d = orderDecision(res('personal'), 'owner-order', { action: 'convert_to_station', confirmPersonal: true });
    expect(d.allowed).toBe(false);
  });

  it('stop/brake/hold are always allowed for PERSONAL and BASE', () => {
    for (const role of ['personal', 'base'] as const) {
      expect(orderDecision(res(role), 'safety', { action: 'stop' }).allowed).toBe(true);
      expect(orderDecision(res(role), 'safety', { action: 'brake' }).allowed).toBe(true);
    }
  });

  it('BASE refuses every movement order', () => {
    const d = orderDecision(res('base'), 'owner-order', { action: 'move', confirmPersonal: true });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('role_base');
    expect(d.reason).toBe('a base is never moved: every movement order is refused');
  });

  it('OFF refuses everything with the exact reason the owner asked for', () => {
    for (const intent of ['automatic', 'owner-order', 'safety'] as const) {
      const d = orderDecision(res('off'), intent, { action: 'stop', confirmPersonal: true });
      expect(d.allowed).toBe(false);
      expect(d.code).toBe('role_off');
      expect(d.reason).toBe('marked OFF in game: this grid receives no orders');
    }
  });

  it('classifies safety orders and the collision-avoidance guard', () => {
    expect(actionIntent('stop')).toBe('safety');
    expect(actionIntent('set_dampeners')).toBe('safety');
    expect(actionIntent('set_block_props', { props: { CollisionAvoidance: true } })).toBe('safety');
    expect(actionIntent('set_block_props', { props: { Radius: 1000 } })).toBe('automatic');
    expect(actionIntent('convert_to_station')).toBe('automatic');
  });
});

describe('personal landings fly the gentle ride-along envelope', () => {
  it('caps cruise at 60 m/s and forbids free fall / dampeners-off', () => {
    const limits = personalShipLimits(9.81);
    expect(limits.speedCapMps).toBe(PASSENGER_SPEED_CAP_MPS);
    expect(limits.speedCapMps).toBe(60);
    expect(limits.allowFreeFall).toBe(false);
    expect(limits.allowDampenersOff).toBe(false);
    expect(limits.lateralAccelMps2).toBeCloseTo(0.5 * 9.81, 5);
  });
});

describe('mission role gate (the 409 the site shows)', () => {
  // A full DemoDeps needs config/hubs the gate never touches; cast through
  // unknown so `.store` stays typed as Store instead of collapsing to never.
  const deps = () => ({ store: store(), clock: () => 1_000 }) as unknown as DemoDeps;
  const req = { headers: {} } as never;

  it('PERSONAL without confirmPersonal returns 409 with a plain reason', () => {
    shipRoles.noteInGame(deps().store, [{ gridId: 'grid:p', name: 'Tug', hints: [hint('personal')] }], 10);
    const err = roleRefusalForMission(deps(), req, {
      type: 'move',
      assignedUnits: ['grid:p'],
      desiredState: {},
    });
    expect(err?.status).toBe(409);
    expect(err?.code).toBe('personal_confirmation_required');
    expect(err?.message).toContain('personal ship');
  });

  it('PERSONAL with confirmPersonal proceeds', () => {
    shipRoles.noteInGame(deps().store, [{ gridId: 'grid:p2', name: 'Tug', hints: [hint('personal')] }], 10);
    expect(
      roleRefusalForMission(deps(), req, {
        type: 'move',
        assignedUnits: ['grid:p2'],
        desiredState: { personalConfirmed: true },
      }),
    ).toBeNull();
  });

  it('a PERSONAL grid is refused even for an automatic build/repair mission', () => {
    shipRoles.noteInGame(deps().store, [{ gridId: 'grid:p3', name: 'Tug', hints: [hint('personal')] }], 10);
    const err = roleRefusalForMission(deps(), req, {
      type: 'repair',
      assignedUnits: ['grid:p3'],
      desiredState: { personalConfirmed: true },
    });
    expect(err?.status).toBe(409);
  });

  it('BASE movement is refused, OFF is refused for every mission', () => {
    shipRoles.noteInGame(
      deps().store,
      [
        { gridId: 'grid:b', name: 'Base', hints: [hint('base')] },
        { gridId: 'grid:o', name: 'Off', hints: [hint('off')] },
      ],
      10,
    );
    expect(roleRefusalForMission(deps(), req, { type: 'move', assignedUnits: ['grid:b'], desiredState: {} })?.code).toBe('role_base');
    expect(roleRefusalForMission(deps(), req, { type: 'move', assignedUnits: ['grid:o'], desiredState: {} })?.code).toBe('role_off');
  });
});

describe('no automatic feature bypasses the role (source sweep)', () => {
  const repo = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url).pathname, 'utf8');

  const enforced: Array<[string, RegExp]> = [
    // The send boundary: every executor order passes the gate.
    ['demo/executor.ts', /private roleGate\(/],
    ['demo/executor.ts', /if \(!this\.roleGate\(exec, drone, now, action, params\)\) return;/],
    ['demo/executor.ts', /this\.roleGate\(exec, drone, now, rawAction, params\)/],
    ['demo/executor.ts', /stagingSend/],
    // Provisioner never touches PERSONAL/OFF (profileForGrid returns null).
    ['demo/provision/provisioner.ts', /res\.role === 'personal' \|\| res\.role === 'off'\) return null/],
    ['demo/provision/provisioner.ts', /shipRoles\.noteInGame/],
    // Antenna auto-tune, auto-naming, fleet ops and designer selection.
    ['demo/autotune/apply.ts', /shipRoles\.roleOf\(change\.gridId\)/],
    ['demo/naming/naming.ts', /res\.role === 'personal' \|\| res\.role === 'off'/],
    ['demo/fleet/service.ts', /shipRoles\.roleOf\(step\.memberId\)/],
    ['demo/designer/routes.ts', /shipRoles\.roleOf\(profile\.gridId\)/],
    // Route-level confirmation and the OFF refusal.
    ['demo/routes.ts', /export function roleRefusalForMission/],
  ];

  for (const [file, pattern] of enforced) {
    it(`${file} carries its role check`, () => {
      expect(repo(file)).toMatch(pattern);
    });
  }
});

describe('move-to: the role gate runs BEFORE the dry-run branch', () => {
  // A dry run is the preflight a person reads before pressing Fly. Reporting
  // "ok" for a grid whose role refuses the order was a real bug (2026-11-11:
  // PERSONAL without confirmPersonal answered 200/ok and only the real call
  // refused), so the ordering is pinned rather than the wording.
  it('asks roleRefusalForMission before it answers the dry run', () => {
    const src = readFileSync(new URL('../src/demo/routes.ts', import.meta.url).pathname, 'utf8');
    const gate = src.indexOf('const roleRefusal = roleRefusalForMission(');
    const dry = src.indexOf('if (parsed.data.dryRun) {', gate);
    expect(gate).toBeGreaterThan(-1);
    expect(dry).toBeGreaterThan(gate);
  });
});
