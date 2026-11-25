package com.guardianpulse.child

import android.content.Context
import android.content.SharedPreferences

class PrefsStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("guardian_pulse_child", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("server_url", "http://192.168.1.10:3001") ?: "http://192.168.1.10:3001"
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

    var lastSummary: String
        get() = prefs.getString("last_summary", "Waiting for GPS fix...") ?: "Waiting for GPS fix..."
        set(value) = prefs.edit().putString("last_summary", value).apply()

    var lastSyncedAt: String
        get() = prefs.getString("last_synced_at", "--") ?: "--"
        set(value) = prefs.edit().putString("last_synced_at", value).apply()

    val isPaired: Boolean
        get() = deviceToken.isNotBlank()

    fun clearPairing() {
        prefs.edit()
            .remove("device_token")
            .remove("child_name")
            .remove("parent_name")
            .remove("device_name")
            .putBoolean("tracking_active", false)
            .apply()
    }
}
