# Sim-speed gating

Space Engineers slows the simulation when the server cannot keep up. Orders sent
into a slow world arrive late and land on a stale picture, so the backend holds
new flight orders while the world is struggling.

## The rule

- No **new flight order** is dispatched below `RTS_SIMSPEED_MIN` (default
  **0.95**).
- The reading comes from the plugin's own sample of the world's simulation
  ratio; no Remote API and no extra configuration is needed.
- Orders already in flight are not cancelled. Stop, brake and hold are never
  gated, so you can always intervene.
- The map shows the current value and the hold state; the audit records each
  hold with the reading that caused it.

## Changing it

```bash
RTS_SIMSPEED_MIN=0.9      # more permissive: more orders in a slow world
RTS_SIMSPEED_MIN=1.0      # strict: only fly when the world runs at full speed
```

Values are validated at boot. Lowering the threshold trades safety margin for
throughput; on a busy server the usual fix is fewer concurrent flights, not a
lower threshold.

## What it does not do

- It does not throttle telemetry, reads or safety actions.
- It does not stop an autopilot that is already flying — that is safe mode's
  job when the backend itself goes quiet.
- It is not a fix for a server that is perpetually below 0.95; that is a load
  problem (grid count, physics, mods), and the backend is only a small part of
  the game-thread budget.

## When the world is slow, look at the host first

A measured lesson: the sim speed sat at ~0.5 while a **second Space Engineers
server** (the test world) ran on the same VM. Two dedicated servers on one host
split the CPU, and neither keeps up. The game itself, not the backend, was the
cost.

- Run one Space Engineers server per VM. Stop the test server before you judge
  live performance, and leave it stopped when you are not testing.
- Check the host (`docker stats`, `top`) before you change `RTS_SIMSPEED_MIN`.
  Raising the threshold hides the symptom and blocks legitimate orders.
- The same rule applies to the backend: keep it off the game host if that host is
  already at one server's worth of CPU.
