# FAQ

**Does this need Torch, Pulsar or another server plugin loader?**
No. `HermesRts.Plugin.dll` is a native dedicated-server plugin: it is listed in
`<Plugins>` in `SpaceEngineers-Dedicated.cfg` and loaded by the server itself.

**Does it work in creative mode?**
No. This is a survival-only build. In creative the game is already a sandbox and
the automation assumes survival constraints (fuel, power, landing).

**Can it spawn, clone, delete, refuel or teleport ships?**
No. Those actions are not compiled into the plugin and the backend refuses to
send them (`reason: survival_mode`). The plugin only uses blocks and APIs a
player could use from the cockpit.

**Then how does a low ship get refuelled?**
It flies home, lands, and waits. You refuel it (or it charges), and you approve
the relaunch. See [survival-loop.md](survival-loop.md).

**Will this get me banned?**
It is a server-side plugin you install on your own dedicated server, and it
performs no action a player could not perform manually. It does not modify the
game executable, does not use the Remote API, and writes nothing into the world
save. Running it on someone else's server without permission is still a bad
idea, and it is not designed for that.

**Do I need the world-geometry or terrain service?**
No. The map draws an approximate planet shell without it. If you happen to run a
world-geometry service, point `RTS_TELEMETRY_TEST_BASE` at it to get real
terrain and block shapes. That service is a separate program and is not
published with this project.

**Does the map need internet access?**
No. Everything is served from your LAN host; the site is a static bundle served
by the backend at `/demo/`.

**Can I fly a ship with no base antenna?**
No. The comms gate requires a powered antenna on a `[HERMES-BASE]` grid within
range and fresh telemetry, otherwise the order is refused with `comms_denied`.
This is deliberate: it is the path the plugin actually verifies.

**Why is my ship not moving?**
In order of likelihood: it is untagged (untagged means `OFF` on a live server),
it is not owned by a Steam id in `RTS_OWNER_STEAM_IDS`, it is marked
`[PERSONAL]` and the order was not confirmed, there is no reachable base
antenna, or the world is below the sim-speed threshold. All four are audited with
a reason.

**What happens if the backend crashes?**
The plugin's safe mode stops autopilots on your grids after 30 s of silence. A
separate dead-man restores dampeners on any grid the backend stops ordering
after 6 s. Both run on the game thread, so they work even when the backend never
comes back.

**Does it change my save?**
No. The plugin has no save action. The optional handoff detector reads a **copy**
of the save directory (`RTS_SAVE_DIR`); the original is never written.

**Can one backend drive two servers?**
No. One backend, one world. Run a second instance with its own
`RTS_DATA_DIR`, port and token for a second server.

**Does it work with mods?**
Untested. Grids are resolved from blocks and tags the plugin can read, so most
mods are invisible to it; a mod that changes thruster or antenna behaviour will
make the flight model less accurate.

**Which server build is supported?**
`01_210_014` is what the plugin was compiled against and flown on. Other builds
may work if the assembly references resolve, but they are untested.

**Where are the logs?**
The plugin writes into the server log (look for `hermes plugin <version>
initialised` and `backend connected`) and to `plugin.log` beside the DLL. The
backend logs to stdout and to `RTS_DATA_DIR`, where the audit table also lives.
