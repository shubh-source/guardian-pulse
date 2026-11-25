# Deploying GuardianPulse to Render

This repository includes ready-to-deploy Render configuration (`render.yaml`, `Dockerfile.parent`, `Dockerfile.child`) pinned to **Node.js 24** (`node:24-alpine`, required for built-in `node:sqlite`).

## Option 1: One-Click Blueprint Deploy (Recommended for 24/7 Use)

1. Push `c:\new\spy` to a GitHub or GitLab repository.
2. In the [Render Dashboard](https://dashboard.render.com/), click **New + -> Blueprint**.
3. Connect your repository — Render detects `render.yaml` and creates:
   - **`guardianpulse-parent`**: Parent Safety Console + REST/SSE API + 1GB Persistent Disk (`/var/data/guardian.db`).
   - **`guardianpulse-child`**: Child Web PWA pointing automatically to `guardianpulse-parent` via `PARENT_API_URL`.
4. Click **Apply**. After deploy finishes, you get HTTPS URLs such as:
   - `https://guardianpulse-parent.onrender.com`
   - `https://guardianpulse-child.onrender.com`

> **Important Note on Render Free vs. Starter Plan:**
> - **Starter Plan + Persistent Disk** (`render.yaml` default) stays awake 24/7 and preserves SQLite location history + Stay Spots across restarts.
> - **Free Plan**: Render Free web services do **not** support Persistent Disks and automatically sleep after 15 minutes of inactivity (so location history resets on redeploy/sleep and pings sent while asleep can fail until woken up). To test on Free tier manually, create a **Web Service** using **Docker** (`Dockerfile.parent`), omit the Disk, and set `DB_PATH=/tmp/guardian.db` + `SESSION_SECRET=<random-string>`.

## Option 2: Connect the Native Android App (`android-child-app/`)

Once `guardianpulse-parent` is live on Render:
1. Build the APK from `android-child-app/` in Android Studio (**Build -> Build APK(s)**) and install it on the child's phone.
2. In the Android app, enter:
   - **Parent Server URL**: `https://guardianpulse-parent.onrender.com`
   - **Pairing Code**: 6-character code generated in the Parent Console.
3. Grant **Allow all the time** for Location and disable Battery Optimization for the app so 24/7 background updates and 50m / 10+ min Stay Spots work reliably.
