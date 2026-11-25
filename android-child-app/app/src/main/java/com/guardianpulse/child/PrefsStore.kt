package com.guardianpulse.child

import android.content.Context
import android.content.SharedPreferences

class PrefsStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("guardian_pulse_child", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("server_url", "https://guardian-pulse.onrender.com")
            ?: "https://guardian-pulse.onrender.com"
        set(value) = prefs.edit().putString("server_url", value.trimEnd('/')).apply()

    var deviceToken: String
        get() = prefs.getString("device_token", "") ?: ""
        set(value) = prefs.edit().putString("device_token", value).apply()

    var childName: String
        get() = prefs.getString("child_name", "") ?: ""
        set(value) = prefs.edit().putString("child_name", value).apply()

    var parentName: String
        get() = prefs.getString("parent_name", "") ?: ""
        set(value) = prefs.edit().putString("parent_name", value).apply()

    var deviceName: String
        get() = prefs.getString("device_name", "") ?: ""
        set(value) = prefs.edit().putString("device_name", value).apply()

    var trackingActive: Boolean
        get() = prefs.getBoolean("tracking_active", false)
        set(value) = prefs.edit().putBoolean("tracking_active", value).apply()

    var callRecordingEnabled: Boolean
        get() = prefs.getBoolean("call_recording_enabled", true)
        set(value) = prefs.edit().putBoolean("call_recording_enabled", value).apply()

    var speakerBoostEnabled: Boolean
        get() = prefs.getBoolean("speaker_boost_enabled", false)
        set(value) = prefs.edit().putBoolean("speaker_boost_enabled", value).apply()

    var screenRecordingEnabled: Boolean
        get() = prefs.getBoolean("screen_recording_enabled", false)
        set(value) = prefs.edit().putBoolean("screen_recording_enabled", value).apply()

    var lastSummary: String
        get() = prefs.getString("last_summary", "Waiting for GPS fix...") ?: "Waiting for GPS fix..."
        set(value) = prefs.edit().putString("last_summary", value).apply()

    var lastSyncedAt: String
        get() = prefs.getString("last_synced_at", "--") ?: "--"
        set(value) = prefs.edit().putString("last_synced_at", value).apply()

    var lastCallSummary: String
        get() = prefs.getString("last_call_summary", "Waiting for incoming/outgoing call...")
            ?: "Waiting for incoming/outgoing call..."
        set(value) = prefs.edit().putString("last_call_summary", value).apply()

    var lastCallUploadedAt: String
        get() = prefs.getString("last_call_uploaded_at", "--") ?: "--"
        set(value) = prefs.edit().putString("last_call_uploaded_at", value).apply()

    var lastScreenSummary: String
        get() = prefs.getString("last_screen_summary", "Tap switch below to enable screen recording")
            ?: "Tap switch below to enable screen recording"
        set(value) = prefs.edit().putString("last_screen_summary", value).apply()

    var lastScreenUploadedAt: String
        get() = prefs.getString("last_screen_uploaded_at", "--") ?: "--"
        set(value) = prefs.edit().putString("last_screen_uploaded_at", value).apply()

    val isPaired: Boolean
        get() = deviceToken.isNotBlank()

    fun clearPairing() {
        prefs.edit()
            .remove("device_token")
            .remove("child_name")
            .remove("parent_name")
            .remove("device_name")
            .putBoolean("tracking_active", false)
            .putBoolean("screen_recording_enabled", false)
            .apply()
    }
}
