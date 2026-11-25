package com.guardianpulse.child

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

class BootCompletedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            val prefs = PrefsStore(context)
            if (prefs.isPaired && prefs.trackingActive) {
                try {
                    LocationTrackingService.start(context)
                } catch (_: Exception) {
                }

                if (prefs.callRecordingEnabled) {
                    try {
                        CallRecorderService.start(context)
                    } catch (_: Exception) {
                        showTapToResumeNotification(
                            context,
                            1003,
                            CallRecorderService.CHANNEL_ID,
                            "Auto Call Recording",
                            "Tap to Resume Call Recording",
                            "Phone restarted. Tap to re-enable auto call recording."
                        )
                    }
                }

                if (prefs.screenRecordingEnabled && !ScreenRecorderService.isRunning) {
                    showTapToResumeNotification(
                        context,
                        1005,
                        ScreenRecorderService.CHANNEL_ID,
                        "Auto Screen Recording",
                        "Tap to Resume Screen Recording",
                        "Phone restarted. Tap to re-approve display recording."
                    )
                }
            }
        }
    }

    private fun showTapToResumeNotification(
        context: Context,
        notificationId: Int,
        channelId: String,
        channelName: String,
        title: String,
        body: String
    ) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                channelId,
                channelName,
                NotificationManager.IMPORTANCE_HIGH
            )
            nm.createNotificationChannel(ch)
        }
        val openIntent = PendingIntent.getActivity(
            context,
            notificationId,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = NotificationCompat.Builder(context, channelId)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setAutoCancel(true)
            .setContentIntent(openIntent)
            .build()
        nm.notify(notificationId, notification)
    }
}
