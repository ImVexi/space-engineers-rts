import type { Config } from './config.js';
import { missionSummary } from './policy.js';
import type { PluginHub } from './pluginHub.js';
import { OPEN_STATUSES } from '@se-rts/schemas';
import type { Store } from './store.js';

export function buildSnapshot(deps: { config: Config; store: Store; hub: PluginHub; startedAt: number; clock?: () => number }): Record<string, unknown> {
  const now = deps.clock?.() ?? Date.now();
  const missions = deps.store.listMissions({ limit: 200 });
  const approvals = missions.filter((m) => m.approval === 'approve' && m.status === 'queued');
  return {
    schemaVersion: 1,
    now,
    uptimeSec: Math.round((now - deps.startedAt) / 1000),
    flags: deps.store.getFlags(),
    killSwitch: deps.store.isKillSwitchOn(),
    agent: deps.hub.agentInfo(),
    agentStatus: deps.hub.lastStatus(),
    missions: {
      counts: missionSummary(missions),
      open: missions.filter((m) => OPEN_STATUSES.includes(m.status)).length,
      recent: missions.slice(0, 25),
    },
    approvals: approvals.map((m) => ({
      id: m.id,
      type: m.type,
      priority: m.priority,
      desiredState: m.desiredState,
      budget: m.budget,
      createdAt: m.createdAt,
    })),
    units: deps.store.listUnits(),
    links: deps.store.listLinks(),
    alerts: deps.store.listAlerts(true).slice(0, 25),
    desired: deps.store.listDesired(),
    ledger: deps.store.listLedger(),
    caps: deps.config.caps,
    bind: { address: deps.config.bind, port: deps.config.port, authRequired: Boolean(deps.config.token) },
  };
}
