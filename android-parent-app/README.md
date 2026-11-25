# GuardianPulse Parent — Native Android App

A dedicated Android APK wrapper for the **Parent Safety Console** (`https://guardian-pulse.onrender.com`), built with Kotlin + Android WebView.

## Features
- Opens your live Parent Console directly as a standalone Android app (no browser address bar).
- Keeps parent login session saved via DOM `localStorage`.
- Supports live 24/7 map, SSE real-time updates, route playback, and **Stay Spots (50m · 10m+)**.
- Clicking **Google Maps** on any Stay Spot automatically opens the native Google Maps app on your phone.
- Includes a gear button (bottom-right) to switch server URLs anytime.

## How to Build the `.apk` in Android Studio
1. Open **Android Studio** -> **Open** -> select `c:\new\spy\android-parent-app`.
2. Let Gradle sync finish.
3. Click **Build -> Build Bundle(s) / APK(s) -> Build APK(s)**.
4. Install `app/build/outputs/apk/debug/app-debug.apk` on the parent's Android phone.
