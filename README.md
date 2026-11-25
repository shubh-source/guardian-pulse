# GuardianPulse — Separate Parent & Child Applications

Two completely separate, zero-dependency applications built with **Node.js 24 (`node:http`, `node:sqlite`, `node:crypto`)**:

1. **Parent Application (`parent-app/`, Port `3001`)**:
   - Guardian registration & login, child profile creation, 6-character pairing codes.
   - Live 24/7 map with Server-Sent Events (`/api/events`) and route history timeline (`1H`, `6H`, `24H`, `7D` + playback scrubber).
   - Hosts the SQLite database and REST/SSE API.
2. **Child Application (`child-app/`, Port `3002`)**:
   - Standalone mobile-friendly PWA (`manifest.webmanifest` + `sw.js`) with zero Parent Dashboard UI or links.
   - Connects via 6-character pairing code, displays a transparent `"24/7 Location Sharing Active"` status banner, tracks high-accuracy GPS + Screen Wake Lock + offline queue (`localStorage`), and includes a desktop Walk Simulator for testing.
   - Forwards `/api/*` telemetry requests to `PARENT_API_URL` (default `http://127.0.0.1:3001`), or lets you specify a custom Parent Server URL.

## Running Both Applications

Run both separate apps together:

```powershell
node start-all.js
```

Or run each application independently in separate terminals:

```powershell
# Terminal 1 — Parent App (http://localhost:3001)
node parent-app/server.js

# Terminal 2 — Child App (http://localhost:3002)
node child-app/server.js
```

## Running Tests

```powershell
node --test tests/*.test.js
```
