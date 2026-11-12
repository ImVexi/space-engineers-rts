export * from './common.js';
export * from './shipSpec.js';
export * from './mission.js';
export * from './domain.js';
export * from './plugin.js';
export * from './ladder.js';
export * from './scenarios.js';
export * from './capability.js';
export * from './network.js';

import { zodToJsonSchema } from 'zod-to-json-schema';
import { ShipSpecSchema } from './shipSpec.js';
import { MissionCreateSchema, MissionPatchSchema, MissionSchema } from './mission.js';
import { BehaviorConfigSchema, CapabilitySchema, IncidentSchema, LedgerEntrySchema } from './domain.js';
import {
  AckMessage,
  EventMessage,
  HelloMessage,
  OrderMessage,
  PluginMessageSchema,
  StatusMessage,
  TelemetryMessage,
  PluginPlayer,
  TestMessage,
} from './plugin.js';
import { LadderRungSchema } from './ladder.js';
import { ScenarioSchema } from './scenarios.js';
import { CapabilityProfileSchema, CapabilityReportSchema } from './capability.js';
import {
  ChainPlanSchema,
  CoveragePlanSchema,
  LinkGraphSchema,
  LinkModelConfigSchema,
  NodeTemplateSchema,
  PlanetSchema,
  WhatIfResultSchema,
} from './network.js';

/**
 * Published JSON Schema bundle (draft-07). Consumers that are not TypeScript
 * (the C# plugin, the website, external tools) validate against these.
 * Unknown fields are ignored by the runtime validators; JSON Schema objects do
 * not set `additionalProperties: false`, matching that contract.
 */
export const jsonSchemas: Record<string, unknown> = {
  ShipSpec: zodToJsonSchema(ShipSpecSchema, { name: 'ShipSpec', $refStrategy: 'none' }),
  Mission: zodToJsonSchema(MissionSchema, { name: 'Mission', $refStrategy: 'none' }),
  MissionCreate: zodToJsonSchema(MissionCreateSchema, { name: 'MissionCreate', $refStrategy: 'none' }),
  MissionPatch: zodToJsonSchema(MissionPatchSchema, { name: 'MissionPatch', $refStrategy: 'none' }),
  Incident: zodToJsonSchema(IncidentSchema, { name: 'Incident', $refStrategy: 'none' }),
  LedgerEntry: zodToJsonSchema(LedgerEntrySchema, { name: 'LedgerEntry', $refStrategy: 'none' }),
  BehaviorConfig: zodToJsonSchema(BehaviorConfigSchema, { name: 'BehaviorConfig', $refStrategy: 'none' }),
  Capability: zodToJsonSchema(CapabilitySchema, { name: 'Capability', $refStrategy: 'none' }),
  LadderRung: zodToJsonSchema(LadderRungSchema, { name: 'LadderRung', $refStrategy: 'none' }),
  Scenario: zodToJsonSchema(ScenarioSchema, { name: 'Scenario', $refStrategy: 'none' }),
  PluginMessage: zodToJsonSchema(PluginMessageSchema, { name: 'PluginMessage', $refStrategy: 'none' }),
  Hello: zodToJsonSchema(HelloMessage, { name: 'Hello', $refStrategy: 'none' }),
  Telemetry: zodToJsonSchema(TelemetryMessage, { name: 'Telemetry', $refStrategy: 'none' }),
  Player: zodToJsonSchema(PluginPlayer, { name: 'Player', $refStrategy: 'none' }),
  Event: zodToJsonSchema(EventMessage, { name: 'Event', $refStrategy: 'none' }),
  Order: zodToJsonSchema(OrderMessage, { name: 'Order', $refStrategy: 'none' }),
  Ack: zodToJsonSchema(AckMessage, { name: 'Ack', $refStrategy: 'none' }),
  Status: zodToJsonSchema(StatusMessage, { name: 'Status', $refStrategy: 'none' }),
  Test: zodToJsonSchema(TestMessage, { name: 'Test', $refStrategy: 'none' }),
  CapabilityProfile: zodToJsonSchema(CapabilityProfileSchema, { name: 'CapabilityProfile', $refStrategy: 'none' }),
  CapabilityReport: zodToJsonSchema(CapabilityReportSchema, { name: 'CapabilityReport', $refStrategy: 'none' }),
  Planet: zodToJsonSchema(PlanetSchema, { name: 'Planet', $refStrategy: 'none' }),
  NodeTemplate: zodToJsonSchema(NodeTemplateSchema, { name: 'NodeTemplate', $refStrategy: 'none' }),
  LinkModelConfig: zodToJsonSchema(LinkModelConfigSchema, { name: 'LinkModelConfig', $refStrategy: 'none' }),
  LinkGraph: zodToJsonSchema(LinkGraphSchema, { name: 'LinkGraph', $refStrategy: 'none' }),
  WhatIfResult: zodToJsonSchema(WhatIfResultSchema, { name: 'WhatIfResult', $refStrategy: 'none' }),
  ChainPlan: zodToJsonSchema(ChainPlanSchema, { name: 'ChainPlan', $refStrategy: 'none' }),
  CoveragePlan: zodToJsonSchema(CoveragePlanSchema, { name: 'CoveragePlan', $refStrategy: 'none' }),
};
