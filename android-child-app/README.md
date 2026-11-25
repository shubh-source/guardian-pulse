# GuardianPulse Child — Native Android App (24/7 Background APK)

A native Kotlin Android application that connects directly to the **Parent App** API (`http://<YOUR-PC-OR-DOMAIN>:3001`) with **no browser required** and continues tracking **24/7** even when the phone screen is locked or restarted.

## Features
- **True 24/7 Foreground Location Service** (`LocationTrackingService.kt`) with a persistent transparent Android notification.
- **Auto-Start on Reboot** (`BootCompletedReceiver.kt`) so tracking resumes automatically after a phone restart.
- **Offline SQLite Queue** (`OfflineQueueHelper.kt`) storing up to 10,000 points locally when offline and batch-syncing to `/api/locations` as soon as network returns.
- **Permissions Flow**: Foreground + Background Location (*Allow all the time*), Notifications, and Battery Optimization exemption.

## How to Build the Installable `.apk`

Because this PC does not currently have Java JDK / Android Studio installed, build the APK on a machine with **Android Studio**:

1. Open **Android Studio** -> **Open** -> select `c:\new\spy\android-child-app`.
2. Let Gradle sync (downloads Android SDK 35 & Kotlin dependencies automatically).
3. Click **Build -> Build Bundle(s) / APK(s) -> Build APK(s)** (or run `./gradlew assembleDebug` if Gradle wrapper is generated).
4. Copy `app/build/outputs/apk/debug/app-debug.apk` to the child's Android phone and install it.

## Connecting the Phone App to Your Parent Server
1. Ensure the Parent App (`node parent-app/server.js`) is reachable from the phone:
   - **Same Wi-Fi**: Find your PC's local IP (e.g., `ipconfig` -> `192.168.1.10`) and enter `http://192.168.1.10:3001` as the **Parent Server URL** in the Android app (also allow port `3001` in Windows Firewall).
   - **Anywhere on Internet (24/7 outside home)**: Host `parent-app` on a public HTTPS server/VPS or tunnel (e.g., `https://your-server.example.com`) and enter that URL in the Android app.
2. Generate a 6-character pairing code in the Parent App (`http://localhost:3001`) and enter it in the Android app.
3. Grant **Allow all the time** for Location and tap **Allow Background Location & Disable Battery Sleep**.
