package com.guardianpulse.child

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootCompletedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            val prefs = PrefsStore(context)
            if (prefs.isPaired && prefs.trackingActive) {
                LocationTrackingService.start(context)
            }
        }
    }
}
