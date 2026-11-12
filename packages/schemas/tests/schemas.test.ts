import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  BehaviorConfigSchema,
  CapabilitySchema,
  IncidentSchema,
  LADDER_RUNGS,
  LedgerEntrySchema,
  MissionCreateSchema,
  MissionPatchSchema,
  MissionSchema,
  PluginMessageSchema,
  SCENARIOS,
  ShipSpecSchema,
  TelemetryMessage,
  jsonSchemas,
  type ShipSpec,
} from '@se-rts/schemas';

const validShipSpec = (): ShipSpec => ({
  schemaVersion: 1,
  id: 'sat-relay-mk1',
  role: 'relay',
  template: 'small-grid-sat-v1',
  parameters: {
    solarPanels: 4,
    batteries: 2,
    ionThrusters: 4,
    gyros: 2,
    antenna: 'radio',
    laser: true,
    camera: true,
    armor: 'light',
  },
  constraints: { maxMassKg: 8000, minTWR: 0.35, maxPCU: 2000, minEnduranceMin: 45, propulsion: 'ion' },
  version: 3,
});

describe('ShipSpec schema', () => {
  it('accepts the canonical example', () => {
    const parsed = ShipSpecSchema.parse(validShipSpec());
    expect(parsed.id).toBe('sat-relay-mk1');
    expect(parsed.parameters.ionThrusters).toBe(4);
  });

  it('ignores unknown fields (additive-only contract)', () => {
    const parsed = ShipSpecSchema.parse({ ...validShipSpec(), futureField: { anything: true } });
    expect(parsed).not.toHaveProperty('futureField');
  });

  it.each([
    ['missing schemaVersion', { ...validShipSpec(), schemaVersion: undefined }],
    ['unknown role', { ...validShipSpec(), role: 'dreadnought' }],
    ['no thrusters', { ...validShipSpec(), parameters: { solarPanels: 2, batteries: 1, gyros: 1 } }],
    ['no power source', { ...validShipSpec(), parameters: { ionThrusters: 4, gyros: 2 } }],
    ['negative thruster count', { ...validShipSpec(), parameters: { solarPanels: 1, ionThrusters: -2, gyros: 1 } }],
    ['propulsion mismatch', { ...validShipSpec(), constraints: { propulsion: 'hydrogen' } }],
    ['empty id', { ...validShipSpec(), id: '' }],
    ['wrong version type', { ...validShipSpec(), version: 'three' }],
  ])('rejects %s', (_name, input) => {
    expect(ShipSpecSchema.safeParse(input).success).toBe(false);
  });

  it('survives arbitrary JSON without throwing (fuzz)', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const result = ShipSpecSchema.safeParse(value);
        if (result.success) {
          // Accepted output must itself be valid (no normalisation drift).
          expect(ShipSpecSchema.safeParse(result.data).success).toBe(true);
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it('fuzzes mutations of a valid spec and never throws', () => {
    const keys = ['id', 'role', 'template', 'parameters', 'constraints', 'version', 'schemaVersion'];
    fc.assert(
      fc.property(fc.constantFrom(...keys), fc.anything(), (key, value) => {
        const mutated = { ...validShipSpec(), [key]: value } as Record<string, unknown>;
        expect(() => ShipSpecSchema.safeParse(mutated)).not.toThrow();
        return true;
      }),
      { numRuns: 300 },
    );
  });
});

describe('Mission schema', () => {
  const base = {
    schemaVersion: 1,
    id: 'm-1',
    type: 'build_deploy',
    priority: 50,
    desiredState: { shipSpec: 'sat-relay-mk1', station: 'orbit-A' },
    budget: { resources: { iron: 12000 }, timeMin: 90, lossLimit: 1 },
    createdAt: 1,
    updatedAt: 1,
  };

  it('defaults approval to approve and status to queued', () => {
    const parsed = MissionSchema.parse(base);
    expect(parsed.approval).toBe('approve');
    expect(parsed.status).toBe('queued');
    expect(parsed.desiredState.formation).toBe('none');
    expect(parsed.desiredState.qty).toBe(1);
  });

  it('requires a budget with a loss limit', () => {
    const { budget: _budget, ...withoutBudget } = base;
    expect(MissionSchema.safeParse(withoutBudget).success).toBe(false);
    expect(MissionSchema.safeParse({ ...base, budget: { timeMin: 10 } }).success).toBe(false);
  });

  it('rejects negative loss limits and unknown statuses', () => {
    expect(MissionSchema.safeParse({ ...base, budget: { timeMin: 10, lossLimit: -1 } }).success).toBe(false);
    expect(MissionSchema.safeParse({ ...base, status: 'vibing' }).success).toBe(false);
  });

  it('MissionCreate allows omitted id/timestamps and defaults schemaVersion', () => {
    const parsed = MissionCreateSchema.parse({
      type: 'move',
      desiredState: { shipSpec: 'sat-relay-mk1', station: 'orbit-A' },
      budget: { timeMin: 10, lossLimit: 0 },
    });
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.approval).toBe('approve');
  });

  it('PATCH body requires action or status', () => {
    expect(MissionPatchSchema.safeParse({}).success).toBe(false);
    expect(MissionPatchSchema.safeParse({ action: 'approve' }).success).toBe(true);
    expect(MissionPatchSchema.safeParse({ action: 'yeet' }).success).toBe(false);
  });
});

describe('other canonical schemas', () => {
  it('Incident, LedgerEntry, BehaviorConfig, Capability parse', () => {
    expect(
      IncidentSchema.parse({
        schemaVersion: 1,
        id: 'inc-1',
        state: 'detected',
        severity: 2,
        budget: { lossLimit: 1 },
        createdAt: 1,
        updatedAt: 1,
      }).uncertaintyRadiusM,
    ).toBe(0);
    expect(
      LedgerEntrySchema.parse({
        schemaVersion: 1,
        site: 'earth-base-1',
        item: 'SteelPlate',
        qty: 1200,
        reserved: 300,
        inTransit: 200,
        available: 700,
        asOf: 1,
      }).available,
    ).toBe(700);
    expect(
      BehaviorConfigSchema.parse({
        schemaVersion: 1,
        id: 'hauler-flee',
        version: 2,
        trigger: { on: 'threat_detected', withinM: 5000 },
        steps: [{ capability: 'charge_jump' }],
      }).enabled,
    ).toBe(false);
    expect(
      CapabilitySchema.parse({
        schemaVersion: 1,
        id: 'jump_to',
        version: 1,
        inputs: { target: 'vec3', offsetM: 'number' },
        outputs: { arrived: 'bool' },
      }).enabled,
    ).toBe(false);
  });
});

describe('plugin protocol schemas', () => {
  it('parses every message type', () => {
    const messages = [
      { schemaVersion: 1, type: 'hello', agentId: 'p', serverId: 's', version: '1', capabilities: [] },
      { schemaVersion: 1, type: 'telemetry', tick: 1 },
      { schemaVersion: 1, type: 'event', eventType: 'damage', at: 1 },
      { schemaVersion: 1, type: 'order', orderId: 'o1', orderType: 'move', entityId: 'grid:1', issuedAt: 1 },
      { schemaVersion: 1, type: 'ack', orderId: 'o1', ok: true, at: 1 },
      { schemaVersion: 1, type: 'status', simSpeed: 1 },
      { schemaVersion: 1, type: 'test', action: 'teleport' },
    ];
    for (const message of messages) {
      expect(PluginMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it('rejects unknown types and orders without ids', () => {
    expect(PluginMessageSchema.safeParse({ schemaVersion: 1, type: 'selfdestruct' }).success).toBe(false);
    expect(
      PluginMessageSchema.safeParse({ schemaVersion: 1, type: 'order', orderType: 'move', entityId: 'x' }).success,
    ).toBe(false);
  });

  it('keeps the frame-level simRatio the plugin sends (T79 live sim-speed)', () => {
    // zod strips what it does not declare, which is why this field reached the
    // backend as `undefined` for a whole deploy even though the plugin sent it.
    const parsed = TelemetryMessage.parse({
      schemaVersion: 1,
      type: 'telemetry',
      tick: 7,
      simRatio: {
        simulationRatio: 0.8,
        serverSimulationRatio: 0.9,
        value: 0.8,
        source: 'MyAPIGateway.Physics',
        state: 'readable',
        sampledAt: 1_800_000_000_000,
      },
    });
    expect(parsed.simRatio?.value).toBe(0.8);
    expect(parsed.simRatio?.source).toBe('MyAPIGateway.Physics');
    expect(parsed.simRatio?.sampledAt).toBe(1_800_000_000_000);
    // A failed read is carried, not invented: value null, state says why.
    const failed = TelemetryMessage.parse({
      schemaVersion: 1,
      type: 'telemetry',
      tick: 8,
      simRatio: { simulationRatio: null, state: 'UNVERIFIED: test' },
    });
    expect(failed.simRatio?.value).toBeUndefined();
    expect(failed.simRatio?.state).toBe('UNVERIFIED: test');
    // Still optional: an older plugin that does not send it parses.
    expect(TelemetryMessage.parse({ schemaVersion: 1, type: 'telemetry', tick: 9 }).simRatio).toBeUndefined();
  });

  it('ignores unknown fields on protocol messages', () => {
    const parsed = PluginMessageSchema.parse({
      schemaVersion: 1,
      type: 'ack',
      orderId: 'o1',
      ok: true,
      at: 1,
      future: true,
    });
    expect(parsed).not.toHaveProperty('future');
  });
});

describe('ladder and scenarios', () => {
  it('defines rungs 1-10 with 3/10 retry caps', () => {
    expect(LADDER_RUNGS.map((r) => r.rung)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const rung of LADDER_RUNGS) {
      expect(rung.retryCaps).toEqual({ perHypothesis: 3, perRung: 10 });
      expect(rung.acceptance.length).toBeGreaterThan(0);
    }
  });

  it('only the crash rung demands approval and destroys the asset', () => {
    const crash = LADDER_RUNGS[9]!;
    expect(crash.id).toBe('crash');
    expect(crash.requiresApproval).toBe(true);
    expect(crash.destroysAsset).toBe(true);
    for (const rung of LADDER_RUNGS.slice(0, 9)) {
      expect(rung.requiresApproval).toBe(false);
      expect(rung.destroysAsset).toBe(false);
    }
  });

  it('catalogs scenarios 1-10 as stubs', () => {
    expect(SCENARIOS).toHaveLength(10);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(10);
    for (const scenario of SCENARIOS) {
      expect(scenario.status).toBe('stub');
      expect(scenario.steps.length).toBeGreaterThan(0);
      expect(scenario.assertions.length).toBeGreaterThan(0);
    }
  });
});

describe('JSON Schema export', () => {
  it('exports a schema for every canonical object', () => {
    const names = [
      'ShipSpec',
      'Mission',
      'MissionCreate',
      'MissionPatch',
      'Incident',
      'LedgerEntry',
      'BehaviorConfig',
      'Capability',
      'LadderRung',
      'Scenario',
      'PluginMessage',
      'Hello',
      'Telemetry',
      'Event',
      'Order',
      'Ack',
      'Status',
      'Test',
    ];
    for (const name of names) {
      const schema = jsonSchemas[name];
      expect(schema, name).toBeTypeOf('object');
      const record = schema as Record<string, unknown>;
      expect(Boolean(record.type || record.anyOf || record.oneOf || record.$ref), name).toBe(true);
    }
  });
});
