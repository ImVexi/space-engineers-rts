import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCTION_ACTIONS, decideOrderChannel } from '../src/demo/channel.js';
import { ADMIN_ACTIONS } from '../src/demo/survival.js';

/**
 * T75 follow-up (2026-11-11): no FEATURE may silently die in survival.
 *
 * The channel split is only honest if every action the executor, the
 * provisioner, the power poller, staging, autotune, naming and the demo routes
 * actually send is either
 *
 *   - a PRODUCTION action (the live build answers it in both modes), or
 *   - an ADMIN action the backend refuses BEFORE the wire, with
 *     `reason: 'survival_mode'` and an audit row - a stated policy, not a bug.
 *
 * This test derives the action set from the source (so a new send cannot slip
 * in unnoticed) and pins the refusal table. A name that is neither production
 * nor in REFUSED_IN_SURVIVAL fails here.
 */

const DEMO_DIR = new URL('../src/demo/', import.meta.url).pathname;

/** Every .ts file under src/demo, recursively (relative to DEMO_DIR). */
function demoFiles(dir = DEMO_DIR, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...demoFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

/** Every action name a feature sends as a plugin action, read from the source. */
function scannedActions(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (name: string | undefined, file: string): void => {
    if (!name) return;
    const list = found.get(name) ?? [];
    if (!list.includes(file)) list.push(file);
    found.set(name, list);
  };

  for (const rel of demoFiles()) {
    const file = rel.split('/').pop() ?? rel;
    // Collapse whitespace so a call split over lines reads as one line.
    const text = readFileSync(join(DEMO_DIR, rel), 'utf8').replace(/\s+/g, ' ');
    // callPlugin(deps, 'action', params) - the provisioner/designer/naming path.
    for (const m of text.matchAll(/callPlugin\([^()]{0,200}?'([a-z_]+)'\s*[,)]/g)) add(m[1], file);
    // this.send(exec, drone, now, 'test', <entity>, 'action', params).
    for (const m of text.matchAll(/this\.send\(\s*exec[^;]{0,200}?'test',\s*[^,]{1,60},\s*'([a-z_]+)'/g)) {
      add(m[1], file);
    }
    // this.sendRaw(..., 'test', { action: 'name', ... }).
    for (const m of text.matchAll(/sendRaw\([^;]{0,200}?'test',\s*\{\s*action:\s*'([a-z_]+)'/g)) add(m[1], file);
    // this.orderChannel('action', ...) - the standalone payload builders.
    for (const m of text.matchAll(/this\.orderChannel\('([a-z_]+)'/g)) add(m[1], file);
    // An inline channel decision names the action it is deciding for.
    for (const m of text.matchAll(/decideOrderChannel\('test',\s*'([a-z_]+)'/g)) add(m[1], file);
  }
  return found;
}

/**
 * Actions a feature still tries to send that survival must refuse, each with
 * the reason the user/audit sees. Anything else must be a production action.
 */
const REFUSED_IN_SURVIVAL: Record<string, string> = {
  spawn_prefab: 'replacement-by-spawn: survival has no spawn, a lost node is re-shaped/reassigned/built',
  clone_grid: 'replacement-by-clone: a copy is still a spawn the live build cannot do',
  delete_grid: 'cleanup deletes a grid; survival never removes world content',
  ownership: 'ownership takeover would be a cheat; a grid is given or merged by its owner',
  teleport_player: 'teleporting the owner character is a cheat and does not exist live',
  zero_velocity: 'writing the physics body is a teleport; survival stations on dampeners only',
  save: 'server save is a test-world trim step; the live server owns its saves',
};

/** Test-harness-only names that are not admin cheats but still cannot run live. */
const TEST_ONLY_ACTIONS = new Set(['save', 'damage', 'wave', 'reset', 'reset_world', 'refill']);

/** Features that lose a capability in survival, and what they lose. */
const UNAVAILABLE_FEATURES: Array<{ feature: string; actions: string[]; why: string }> = [
  { feature: 'missions queued as spawn', actions: ['spawn_prefab', 'clone_grid'], why: 'no grid can be created' },
  { feature: 'cleanupStale / delete_cleanup', actions: ['delete_grid'], why: 'no grid can be deleted' },
  { feature: 'ownership takeover on spawn', actions: ['ownership'], why: 'no grid can change owner' },
  { feature: 'provisioner teleportOwner', actions: ['teleport_player'], why: 'no character teleport' },
  { feature: 'test-world station path', actions: ['zero_velocity'], why: 'dampener stop only' },
  { feature: 'world trim', actions: ['save', 'delete_planets'], why: 'world content is not edited' },
];

describe('T75: every feature action is production or explicitly refused in survival', () => {
  it('scans a non-trivial set of feature actions', () => {
    const scanned = scannedActions();
    expect(scanned.size).toBeGreaterThanOrEqual(20);
    // Sanity: the scan really sees the executor and the pollers.
    expect(scanned.has('ai_off')).toBe(true);
    expect(scanned.has('land_ground')).toBe(true);
    expect(scanned.has('profile')).toBe(true);
  });

  it('never lets a feature send an action that survival would silently drop', () => {
    const silent: string[] = [];
    for (const [action, files] of scannedActions()) {
      const decision = decideOrderChannel('test', action, true);
      if (decision.refused) {
        if (!(action in REFUSED_IN_SURVIVAL)) silent.push(`${action} (${files.join(',')})`);
        continue;
      }
      if (decision.orderType !== 'action') silent.push(`${action} -> ${decision.orderType}`);
    }
    expect(silent, `no stated survival policy for: ${silent.join('; ')}`).toEqual([]);
  });

  it('classifies each feature action exactly once', () => {
    for (const action of scannedActions().keys()) {
      const production = PRODUCTION_ACTIONS.has(action);
      const refused = action in REFUSED_IN_SURVIVAL;
      expect(production || refused, action).toBe(true);
      expect(production && refused, action).toBe(false);
    }
  });

  it('keeps the refusal table to real admin actions with a reason', () => {
    for (const [action, why] of Object.entries(REFUSED_IN_SURVIVAL)) {
      expect(ADMIN_ACTIONS.has(action) || TEST_ONLY_ACTIONS.has(action), action).toBe(true);
      expect(why.length, action).toBeGreaterThan(20);
      const decision = decideOrderChannel('test', action, true);
      expect(decision.refused, action).toBe(true);
      expect(decision.reason, action).toBe('survival_mode');
      // In the test world the same action still goes out on the test channel.
      const test = decideOrderChannel('test', action, false);
      expect(test.refused, action).toBe(false);
      expect(test.orderType, action).toBe('test');
    }
  });

  it('names each unavailable feature and the actions it cannot send', () => {
    for (const entry of UNAVAILABLE_FEATURES) {
      for (const action of entry.actions) {
        expect(decideOrderChannel('test', action, true).refused, `${entry.feature}: ${action}`).toBe(true);
      }
      expect(entry.why.length, entry.feature).toBeGreaterThan(10);
    }
  });

  it('keeps the capabilities survival depends on reachable', () => {
    // The executor's secure sequence and every read the features poll.
    for (const action of ['ai_off', 'wake', 'diag', 'list_players', 'planets', 'rename_grid', 'gps_list']) {
      const decision = decideOrderChannel('test', action, true);
      expect(decision.orderType, action).toBe('action');
      expect(decision.refused, action).toBe(false);
    }
  });
});
