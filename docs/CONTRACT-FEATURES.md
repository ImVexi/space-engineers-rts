# CONTRACT-FEATURES.md — functional batch (owner priority, no camera work)

## 1. Links: possible vs current
GET /api/demo/links?planet= -> {
  current: [{a, b, kind:'radio'|'laser', label:'GAME'|'SIMULATED', lengthM}],   // what exists now (GAME = game-reported: antenna groups / laser Connected)
  possible: [{a, b, kind, lengthM, reason:'in radio range'|'laser LOS clear'|'laser no free port'|'occluded by <body>', feasible:bool}], // what COULD exist within range/LOS/ports
  summary: {radioEdges, laserEdges, possibleRadio, possibleLaser, isolated:[ids]}
}
Frontend: overlay toggle 'Links: current | possible | both(dim possible)'.

## 2. Laser connect sequence (fix)
Order: set_block_props OnOff=true -> laser_target(coords of partner's laser block) -> laser_connect -> poll laser_state <=20 s -> retry once -> if still not Connected report exact status. Applies to: planner link creation, 'link these two' action, and the supervisor. Reset stale 'Connecting' when targetCoords empty.

## 3. Flight profile (speed + coast) in executor
Per leg compute: a_brake from live thrust; v_cruise = min(configMaxCruise, sqrt(2*a_brake*(dist-brakeMargin))); in vacuum: dampeners OFF (coast), burn to v, coast, brake at v^2/2a; inside atmosphere: dampeners ON, continuous thrust, climb rate >= 30 m/s. Send ONE move with that speed; re-send only if required speed changes >20% or a guard trips. FlightMode OneWay for long legs, Precision inside 100 m. Guards unchanged (reserve, ground, overshoot). Report predicted vs actual time/fuel per flight.

## 4. Groups
entities.groups table {id, name, color, members[]}; CRUD via /api/demo/groups; a grid can be in multiple groups. UI: select ships -> 'Group as…' ; groups appear as chips in the Fleet page + a layer on the map (coloured bracket); clicking a group selects all members; bulk actions operate on the group. Persist across restarts.

## 5. Constellation control (live)
Select a group/plan -> panel with count, altitude, pattern, redundancy, spacing, ring inclination. Editing shows a live preview (ghost slots) and a cost line (ships needed, moves, fuel, ETA). 'Apply' -> executor moves/stations exactly the members, in waves, never cutting base connectivity; progress per ship in the same panel with live telemetry (position deltas), and the coverage number updating as ships arrive.
