# Map site (`packages/demo-site`)

The web UI: a 3D map of your world, the relay/coverage planner, mission
approval, ship role panels, and the survival-loop controls. React + three.js
(`@react-three/fiber`), built with Vite, served by the backend at `/demo/`.

```
src/lib/          camera, pose, picking, coverage mesh, terrain sampling, SETR tiles
src/components/   Scene, panels (designer, coverage, roles, fleet, safety, audit)
tests/            camera/context-stack, picking, coverage, panels (jsdom)
e2e/              Playwright scripts (optional; need a running backend)
scripts/dev.mjs   starts a test-locked backend and the site together
```

Scene units are kilometres (`toScene = metres / 1000`). Planets are spheres at
their `maxHillRadiusM`; markers, radio footprints and links share that space.
Terrain occlusion needs an optional world-geometry service (see
`../docs/CONFIGURATION.md`, `RTS_TELEMETRY_TEST_BASE`); without it the map draws
an approximate shell and says so.

## Run

```bash
npm ci
npm run demo:build          # typecheck + vite build into packages/demo-site/dist
npm start                   # backend serves /demo/
```

For frontend work with hot reload:

```bash
npm run demo:dev            # backend on 127.0.0.1:8763, vite on 127.0.0.1:8764
```

`RTS_DEMO=1`, `RTS_ENV=test` and `RTS_TEST_SERVER_MARKER=se-rts-test` are set by
`demo:dev`: that combination mounts the admin routes. A real server runs with
`RTS_ENV=live` + `RTS_DEMO_SURVIVAL=1`, where the admin capabilities are refused
at runtime.

## Build-time values

`VITE_DEMO_API_BASE` (default same-origin `/api`) and `VITE_DEMO_ENV` are stamped
into `<head>` as meta tags so a deployed bundle can be verified with
`node scripts/verify-demo-deploy.mjs --dist packages/demo-site/dist`.

## Tests

```bash
npm run demo:test           # vitest, jsdom + node
```
