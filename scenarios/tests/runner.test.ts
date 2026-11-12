import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TEST_SERVER_MARKER,
  appendResult,
  buildPlan,
  evaluateGate,
  main,
  makeRecord,
  selectPlan,
} from '../runner';

const OPEN_ENV = {
  RTS_TEST_SERVER_URL: 'ws://127.0.0.1:27018/plugin',
  RTS_TEST_SERVER_MARKER: TEST_SERVER_MARKER,
};

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'se-rts-runner-'));
  logPath = join(dir, 'nested', 'runs.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('execution gate', () => {
  it('blocks with no configuration and says what is missing', () => {
    const gate = evaluateGate({});
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(' ')).toContain('RTS_TEST_SERVER_URL');
    expect(gate.reasons.join(' ')).toContain('RTS_TEST_SERVER_MARKER');
  });

  it('blocks when the URL is set but the marker is not', () => {
    const gate = evaluateGate({ RTS_TEST_SERVER_URL: 'ws://127.0.0.1:27018/plugin' });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(' ')).toContain(TEST_SERVER_MARKER);
  });

  it('blocks a production-looking URL even with the marker', () => {
    const gate = evaluateGate({
      RTS_TEST_SERVER_URL: 'wss://live.example.com/plugin',
      RTS_TEST_SERVER_MARKER: TEST_SERVER_MARKER,
    });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(' ')).toContain('non-test');
  });

  it('opens only with both test-server signals', () => {
    expect(evaluateGate(OPEN_ENV)).toEqual({ ok: true, reasons: [] });
  });
});

describe('plan', () => {
  it('loads all 10 rungs and all 10 scenarios from schemas', () => {
    const plan = buildPlan();
    expect(plan.filter((p) => p.kind === 'rung')).toHaveLength(10);
    expect(plan.filter((p) => p.kind === 'scenario')).toHaveLength(10);
    expect(plan.find((p) => p.kind === 'rung' && p.rung === 10)?.requiresApproval).toBe(true);
    expect(plan.find((p) => p.kind === 'rung' && p.rung === 10)?.destroysAsset).toBe(true);
  });

  it('filters by rung and scenario', () => {
    expect(selectPlan(buildPlan(), { rung: 3 })).toHaveLength(1);
    expect(selectPlan(buildPlan(), { scenario: 'authority_gate' })[0]!.name).toContain('Authority');
  });
});

describe('runner', () => {
  it('refuses to execute without a test server and records refusals', () => {
    const lines: string[] = [];
    const code = main({
      argv: ['--execute', '--rung', '1', '--log', logPath],
      env: {},
      now: () => 1_700_000_000_000,
      stdout: (l) => lines.push(l),
    });

    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('PENDING');
    const rows = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('refused');
    expect(rows[0].reason).toContain('no test server');
  });

  it('records pending, not passed, when the gate is open but no driver exists', () => {
    const code = main({
      argv: ['--execute', '--scenario', 'authority_gate', '--log', logPath],
      env: OPEN_ENV,
      now: () => 1_700_000_000_000,
    });
    expect(code).toBe(3);
    const row = JSON.parse(readFileSync(logPath, 'utf8').trim());
    expect(row.status).toBe('pending');
    expect(row.reason).toContain('driver not implemented');
  });

  it('prints a plan without touching the log by default', () => {
    const lines: string[] = [];
    const code = main({ argv: [], env: {}, stdout: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Rung 1: handshake');
    expect(lines.join('\n')).toContain('not run — no test server');
  });
});

describe('JSONL log format', () => {
  it('appends one valid JSON object per line with stable keys', () => {
    const item = buildPlan()[0]!;
    appendResult(logPath, makeRecord({ at: 1, runId: 'r1', item, status: 'skipped', reason: 'test' }));
    appendResult(logPath, makeRecord({ at: 2, runId: 'r1', item, status: 'failed', reason: 'test' }));

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const row = JSON.parse(line);
      expect(row.schemaVersion).toBe(1);
      expect(typeof row.at).toBe('number');
      expect(row.runId).toBe('r1');
      expect(row.kind).toBe('rung');
      expect(row.id).toBe('handshake');
      expect(typeof row.status).toBe('string');
      expect(typeof row.reason).toBe('string');
      expect(row.evidence).toEqual({});
    }
  });
});
