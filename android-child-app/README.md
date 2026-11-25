# GuardianPulse Child — Native Android App (24/7 Background APK)

A native Kotlin Android application that connects directly to the **Parent App** API (`http://<YOUR-PC-OR-DOMAIN>:3001`) with **no browser required** and continues tracking **24/7** even when the phone screen is locked or restarted.

## Features
- **True 24/7 Foreground Location Service** (`LocationTrackingService.kt`) with a persistent transparent Android notification.
- **Automatic Incoming & Outgoing Call Recording** (`CallRecorderService.kt` + `CallStateReceiver.kt`) using standard foreground microphone recording (`VOICE_RECOGNITION` / `MIC`), immediately streaming finished calls to the Parent App (`POST /api/calls`) with **zero permanent local storage** on the child phone.
- **Automatic Display Screen Recording** (`ScreenRecorderService.kt`) using Android `MediaProjection` (`foregroundServiceType="mediaProjection"`), recording 60-second 720p MP4 clips while the phone display is on, pausing automatically when the screen turns off, and streaming clips to `POST /api/screen-recordings` with immediate local cleanup.
- **Auto-Start on Reboot** (`BootCompletedReceiver.kt`) so location and call protection resume automatically after a phone restart (and posts a tap-to-resume prompt for `MediaProjection` screen recording as required by Android OS).
- **Offline Queues**: `OfflineQueueHelper.kt` buffers up to 10,000 GPS points offline; `PendingUploadStore.kt` and `PendingScreenUploadStore.kt` temporarily buffer call audio and screen clips in app cache if offline and delete each local file immediately once the Parent Server confirms upload.
- **Permissions Flow**: Foreground + Background Location (*Allow all the time*), Microphone, Phone State, Call Log, Notifications, Battery Optimization exemption, and Android `MediaProjection` screen capture consent.

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
