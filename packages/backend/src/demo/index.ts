export { resolveDemoEnv, DemoEnvError, DEMO_ENV, DEMO_MARKER, HOSTED_ENV, HOSTED_OPT_IN, type DemoEnv } from './env.js';
export {
  demoRoutesFor,
  DemoHttpError,
  hintForCode,
  invalidateDemoStateCache,
  demoStateCacheStats,
  type DemoRoute,
  type DemoDeps,
  type ExecutionState,
} from './routes.js';
export { evaluateGate, type CommsGate, type GateInput } from './gate.js';
export {
  PRODUCTION_ACTIONS,
  PRODUCTION_ORDER_TYPE,
  decideOrderChannel,
  isProductionAction,
  survivalChannelRefusal,
  type ChannelDecision,
} from './channel.js';
export {
  safetyOrderReason,
  isSafetyOrder,
  SAFETY_HOLD_RADIUS_M,
  type SafetyOrderInput,
} from './safety-order.js';
export { DemoExecutor, isDemoMission, isDesignerMission, gridMoveMission, type DroneState, type DroneRow, type GridMoveMissionInput } from './executor.js';
export { STANDINS, listStandIns, getStandIn, hardwareSummary, type StandIn } from './standins.js';
export { buildConnectPlan, optionById, type DemoConnectOption, type DemoConnectPlan, type HardwareChoice } from './options.js';
export { seedWorld, loadWorld, demoGraph, laserPortUsage, type DemoWorld, type DemoNode } from './world.js';
export * from './power/index.js';
export * from './autotune/index.js';
