# Scenario / ladder runner

**Stub. It cannot run a game scenario yet.**

`runner.ts` loads the canonical data from `packages/schemas`:

- `LADDER_RUNGS` — escalation rungs 1-10, acceptance criteria and retry caps;
- `SCENARIOS` — catalog items from build plan §8.1.

It prints the plan for each, and refuses to execute unless **both** of these
are set:

| Variable | Required value |
|---|---|
| `RTS_TEST_SERVER_URL` | a `ws://` or `wss://` URL that is not production-looking |
| `RTS_TEST_SERVER_MARKER` | `se-rts-test` |

A URL alone is not sufficient: the marker stops a live/production URL from
being mistaken for the isolated lab. When the gate is closed the runner exits
`2`, prints the PENDING reason, and writes one `refused` record per selected
item. When the gate is open it exits `3` and records `pending` — the test-lab
driver that actually spawns/moves/damages things is not implemented.

## Commands

```bash
npm run scenarios                      # full plan, gate status
npm run scenarios -- --rung 10         # one rung
npm run scenarios -- --scenario authority_gate --json
npm run scenarios -- --execute --log scenarios/results/dev.jsonl
```

Default log: `scenarios/results/runs.jsonl` (ignored by `.gitignore`).

## JSONL record

```json
{"schemaVersion":1,"at":1700000000000,"runId":"run-1700000000000",
 "kind":"rung","id":"handshake","rung":1,"status":"refused",
 "reason":"not run — no test server (...)","evidence":{"gate":["..."]}}
```

Status is one of `passed | failed | refused | pending | skipped`. `passed` can
only be written by a real driver after its assertions ran; this stub never
emits it.
