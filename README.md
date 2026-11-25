# GuardianPulse — Separate Parent & Child Applications

Two completely separate, zero-dependency applications built with **Node.js 24 (`node:http`, `node:sqlite`, `node:crypto`)**:

1. **Parent Application (`parent-app/`, Port `3001`)**:
   - Guardian registration & login, child profile creation, 6-character pairing codes.
   - Live 24/7 map with Server-Sent Events (`/api/events`) and route history timeline (`1H`, `6H`, `24H`, `7D` + playback scrubber).
   - Hosts the SQLite database and REST/SSE API.
2. **Child Application (`child-app/` PWA & `android-child-app/` Native APK)**:
   - Standalone mobile-friendly PWA (`manifest.webmanifest` + `sw.js`) and native Kotlin Android app (`android-child-app/`) with zero Parent Dashboard UI or links.
   - Connects via a single 6-character pairing code, displays transparent foreground notifications, and merges all 3 protections into one app: 24/7 GPS location tracking, automatic incoming/outgoing call recording, and segmented phone display screen recording (`MediaProjection`) sent straight to the Parent App with zero permanent local storage.

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
