#!/usr/bin/env node
/**
 * Test-lab scenario runner (stub).
 *
 * Loads the canonical ladder rungs and scenario catalog from @se-rts/schemas,
 * prints the plan, and refuses to execute anything unless an isolated test
 * server is configured AND marked as such. There is no game driver yet, so a
 * correctly configured run records "pending" rather than pretending to pass.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LADDER_RUNGS, SCENARIOS } from '@se-rts/schemas';

export const TEST_SERVER_MARKER = 'se-rts-test';
export const DEFAULT_LOG = 'scenarios/results/runs.jsonl';

export interface GateDecision {
  ok: boolean;
  reasons: string[];
}

export interface PlanItem {
  kind: 'rung' | 'scenario';
  id: string;
  name: string;
  rung: number | null;
  requiresApproval: boolean;
  destroysAsset: boolean;
  slow: boolean;
  steps: string[];
  assertions: string[];
}

export type RunStatus = 'passed' | 'failed' | 'refused' | 'pending' | 'skipped';

export interface RunRecord {
  schemaVersion: 1;
  at: number;
  runId: string;
  kind: 'rung' | 'scenario';
  id: string;
  rung: number | null;
  status: RunStatus;
  reason: string;
  evidence: Record<string, unknown>;
}

type Env = Record<string, string | undefined>;

/**
 * Execution gate. Both conditions are required; a URL alone is not enough,
 * because a production URL must never be mistaken for the test lab.
 */
export function evaluateGate(env: Env): GateDecision {
  const reasons: string[] = [];
  const url = env.RTS_TEST_SERVER_URL;

  if (!url) {
    reasons.push('RTS_TEST_SERVER_URL is not set');
  } else if (!/^wss?:\/\/[^\s]+$/i.test(url)) {
    reasons.push('RTS_TEST_SERVER_URL must be a ws:// or wss:// URL');
  } else if (/live|prod|hosted/i.test(url)) {
    reasons.push('RTS_TEST_SERVER_URL looks like a non-test endpoint');
  }

  if (env.RTS_TEST_SERVER_MARKER !== TEST_SERVER_MARKER) {
    reasons.push(`RTS_TEST_SERVER_MARKER must be "${TEST_SERVER_MARKER}"`);
  }

  return { ok: reasons.length === 0, reasons };
}

export function buildPlan(): PlanItem[] {
  const rungs: PlanItem[] = LADDER_RUNGS.map((r) => ({
    kind: 'rung',
    id: r.id,
    name: r.name,
    rung: r.rung,
    requiresApproval: r.requiresApproval,
    destroysAsset: r.destroysAsset,
    slow: false,
    steps: [],
    assertions: r.acceptance,
  }));

  const scenarios: PlanItem[] = SCENARIOS.map((s) => ({
    kind: 'scenario',
    id: s.id,
    name: s.name,
    rung: s.rung ?? null,
    requiresApproval: s.requiresApproval,
    destroysAsset: false,
    slow: s.slow,
    steps: s.steps,
    assertions: s.assertions,
  }));

  return [...rungs, ...scenarios];
}

export function selectPlan(
  plan: PlanItem[],
  opts: { rung?: number; scenario?: string } = {},
): PlanItem[] {
  let items = plan;
  if (opts.rung !== undefined) items = items.filter((i) => i.kind === 'rung' && i.rung === opts.rung);
  if (opts.scenario !== undefined) items = items.filter((i) => i.kind === 'scenario' && i.id === opts.scenario);
  return items;
}

export function formatPlan(items: PlanItem[], gate: GateDecision): string {
  const lines: string[] = [];
  lines.push('SE RTS scenario runner — PLAN ONLY (no game driver in this build)');
  lines.push(
    gate.ok
      ? 'Gate: OPEN (test server configured)'
      : `Gate: BLOCKED — ${gate.reasons.join('; ')}`,
  );
  lines.push('');

  for (const item of items) {
    const label = item.kind === 'rung' ? `Rung ${item.rung}` : 'Scenario';
    const flags = [
      item.requiresApproval ? 'approval-required' : null,
      item.destroysAsset ? 'destroys-asset' : null,
      item.slow ? 'slow' : null,
    ].filter(Boolean);
    lines.push(`${label}: ${item.id} — ${item.name}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
    for (const s of item.steps) lines.push(`  step: ${s}`);
    for (const a of item.assertions) lines.push(`  assert: ${a}`);
  }

  lines.push('');
  lines.push(
    gate.ok
      ? 'PENDING: test-lab driver not implemented; execution is refused by design.'
      : `PENDING: not run — no test server. ${gate.reasons.join('; ')}. See <repo>-PENDING.md.`,
  );
  return lines.join('\n');
}

export function makeRecord(args: {
  at: number;
  runId: string;
  item: PlanItem;
  status: RunStatus;
  reason: string;
  evidence?: Record<string, unknown>;
}): RunRecord {
  return {
    schemaVersion: 1,
    at: args.at,
    runId: args.runId,
    kind: args.item.kind,
    id: args.item.id,
    rung: args.item.rung,
    status: args.status,
    reason: args.reason,
    evidence: args.evidence ?? {},
  };
}

/** Appends exactly one JSON object per line; creates parent directories. */
export function appendResult(logPath: string, record: RunRecord): void {
  const absolute = resolve(logPath);
  mkdirSync(dirname(absolute), { recursive: true });
  appendFileSync(absolute, `${JSON.stringify(record)}\n`, 'utf8');
}

export interface MainOptions {
  argv: string[];
  env: Env;
  now?: () => number;
  stdout?: (line: string) => void;
}

/** Returns the process exit code. 0 plan, 2 refused, 3 pending driver. */
export function main(opts: MainOptions): number {
  const { argv, env } = opts;
  const now = opts.now ?? (() => Date.now());
  const out = opts.stdout ?? ((line: string) => console.log(line));

  if (argv.includes('--help')) {
    out(USAGE);
    return 0;
  }

  const execute = argv.includes('--execute');
  const json = argv.includes('--json');
  const rung = numberArg(argv, '--rung');
  const scenario = stringArg(argv, '--scenario');
  const logPath = stringArg(argv, '--log') ?? DEFAULT_LOG;

  const gate = evaluateGate(env);
  const plan = selectPlan(buildPlan(), { rung, scenario });

  if (plan.length === 0) {
    out('No matching rung or scenario. Use --rung 1..10 or --scenario <id>.');
    return 1;
  }

  if (!execute) {
    out(json ? JSON.stringify({ gate, plan }, null, 2) : formatPlan(plan, gate));
    return 0;
  }

  const runId = env.RTS_RUN_ID ?? `run-${now()}`;
  const at = now();

  if (!gate.ok) {
    out(`PENDING: refusing to execute — ${gate.reasons.join('; ')}. See <repo>-PENDING.md.`);
    for (const item of plan) {
      appendResult(
        logPath,
        makeRecord({
          at,
          runId,
          item,
          status: 'refused',
          reason: `not run — no test server (${gate.reasons.join('; ')})`,
          evidence: { gate: gate.reasons },
        }),
      );
    }
    out(`Recorded ${plan.length} refusal(s) to ${logPath}`);
    return 2;
  }

  out('PENDING: test server is configured, but the test-lab driver is not implemented in this build.');
  for (const item of plan) {
    appendResult(
      logPath,
      makeRecord({
        at,
        runId,
        item,
        status: 'pending',
        reason: 'test-lab driver not implemented',
        evidence: { gate: 'open' },
      }),
    );
  }
  out(`Recorded ${plan.length} pending result(s) to ${logPath}`);
  return 3;
}

export const USAGE = `Usage: npm run scenarios -- [options]

  --plan                 Print the ladder + scenario plan (default)
  --execute              Run selected items (refused without a test server)
  --rung <1..10>         Select one ladder rung
  --scenario <id>        Select one scenario from the catalog
  --log <path>           JSONL output path (default ${DEFAULT_LOG})
  --json                 Machine-readable plan
  --help                 This text

Execution requires RTS_TEST_SERVER_URL (ws:// or wss://) and
RTS_TEST_SERVER_MARKER=${TEST_SERVER_MARKER}.`;

function stringArg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function numberArg(argv: string[], name: string): number | undefined {
  const raw = stringArg(argv, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(new URL(import.meta.url).pathname);
}

if (isEntrypoint()) {
  process.exitCode = main({ argv: process.argv.slice(2), env: process.env });
}
